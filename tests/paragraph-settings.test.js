/**
 * 验证段落详细属性的默认/显式值、HTML 契约、非连续选区和目标身份映射。
 * 原段落清单固定，部分 patch 保留未修改字段，合法属性更新可继续编辑，真实替换会永久终止旧草稿。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state"
import { ParagraphLayout, PARAGRAPH_LAYOUT_ATTRIBUTES, normalizeParagraphLayout, isValidParagraphLayout, parseParagraphLayout } from "../src/pages/editor/extensions/paragraph-layout.js"
import { captureParagraphTarget, mapParagraphTarget, readParagraphSettings, applyParagraphSettings } from "../src/pages/editor/tools/paragraph-settings.js"

// 安装编辑器需要的浏览器对象和帧调度，让 Node 测试执行真实 schema/事务逻辑；JSDOM 不承担原生版式验收。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// null 表示沿用样式，明确 0/false 表示关闭；默认 fixture 让三态语义在解析、回显和提交中可区分。
const DEFAULT_LAYOUT = { spaceBefore: null, spaceAfter: null, keepWithNext: null, keepTogether: null }
// 每个场景创建独立编辑器并在 finally 销毁，隔离正文、插件和撤销历史；扩展组合只提供该组验证所需能力。
const createEditor = content => new Editor({
  element: document.createElement("div"), extensions: [StarterKit.configure({ trailingNode: false }), TableKit, ParagraphLayout], content
})
// 从当前树收集段落/标题及绝对位置，供复杂列表/表格与前置插入后核对实际影响范围。
const paragraphs = editor => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (["paragraph", "heading"].includes(node.type.name)) result.push({ node, pos }) })
  return result
}
const select = (editor, from, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
const selectAll = editor => editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
// 模拟弹层打开期间的目标跟踪，主事务与插件追加事务都依次映射；stop 用于场景结束时解除监听。
const track = editor => {
  const target = captureParagraphTarget(editor)
  const listener = ({ transaction, appendedTransactions = [] }) => [transaction, ...appendedTransactions].forEach(current => mapParagraphTarget(target, current))
  editor.on("transaction", listener)
  return { target, stop: () => editor.off("transaction", listener) }
}

test("段落布局属性默认 null，0/false 明确关闭，严格验证半磅范围", () => {
  assert.deepEqual(PARAGRAPH_LAYOUT_ATTRIBUTES, Object.keys(DEFAULT_LAYOUT))
  assert.deepEqual(normalizeParagraphLayout(), DEFAULT_LAYOUT)
  assert.deepEqual(normalizeParagraphLayout({ spaceBefore: 0, spaceAfter: 120, keepWithNext: false, keepTogether: true }), {
    spaceBefore: 0, spaceAfter: 120, keepWithNext: false, keepTogether: true
  })
  assert.deepEqual(normalizeParagraphLayout({ spaceBefore: 0.25, spaceAfter: Infinity, keepWithNext: "false", keepTogether: 0 }), DEFAULT_LAYOUT)
  assert.equal(isValidParagraphLayout({ spaceBefore: 0.5, spaceAfter: 119.5, keepWithNext: null, keepTogether: false }), true)
  for (const value of [-0.5, 120.5, 1.25, NaN, Infinity, "12", undefined]) assert.equal(isValidParagraphLayout({ spaceBefore: value }), false)
  assert.equal(isValidParagraphLayout({ keepWithNext: "true" }), false)
  assert.equal(isValidParagraphLayout(null), false)
  assert.equal(isValidParagraphLayout([]), false)
})

test("HTML 往返保留磅数及分页 true/false，默认标题不写覆盖默认 CSS 的 inline style", () => {
  const editor = createEditor("<p>a</p><h2>b</h2>")
  try {
    assert.deepEqual(normalizeParagraphLayout(paragraphs(editor)[0].node.attrs), DEFAULT_LAYOUT)
    assert.equal(editor.getHTML(), "<p>a</p><h2>b</h2>")
    selectAll(editor)
    assert.equal(applyParagraphSettings(editor, captureParagraphTarget(editor), { spaceBefore: 0, spaceAfter: 12.5, keepWithNext: false, keepTogether: true }).ok, true)
    const html = editor.getHTML()
    assert.match(html, /margin-top: 0pt/)
    assert.match(html, /margin-bottom: 12.5pt/)
    assert.match(html, /break-after: auto/)
    assert.match(html, /break-inside: avoid/)
    const parsed = createEditor(html)
    try {
      for (const { node } of paragraphs(parsed)) assert.deepEqual(normalizeParagraphLayout(node.attrs), {
        spaceBefore: 0, spaceAfter: 12.5, keepWithNext: false, keepTogether: true
      })
      selectAll(parsed)
      applyParagraphSettings(parsed, captureParagraphTarget(parsed), DEFAULT_LAYOUT)
      assert.equal(parsed.getHTML(), "<p>a</p><h2>b</h2>")
    } finally { parsed.destroy() }
  } finally { editor.destroy() }
})

test("HTML 解析仅接收安全 pt 与 avoid/auto，兼容旧分页属性并拒绝未知 CSS", () => {
  const element = document.createElement("p")
  element.setAttribute("style", "margin-top:120pt;margin-bottom:0.5pt;page-break-after:avoid;page-break-inside:auto")
  assert.deepEqual(parseParagraphLayout(element), { spaceBefore: 120, spaceAfter: 0.5, keepWithNext: true, keepTogether: false })
  element.setAttribute("style", "margin-top:120.5pt;margin-bottom:12px;break-after:always;break-inside:var(--value);page-break-after:avoid")
  assert.deepEqual(parseParagraphLayout(element), DEFAULT_LAYOUT)
  element.setAttribute("style", "margin-top:calc(1pt + 1pt);margin-bottom:-1pt;break-after:auto;break-inside:avoid")
  assert.deepEqual(parseParagraphLayout(element), { ...DEFAULT_LAYOUT, keepWithNext: false, keepTogether: true })
  assert.deepEqual(parseParagraphLayout(null), DEFAULT_LAYOUT)
})

test("光标、跨段选区及全文选择收集段落/标题，排除代码块和结束起点的下一段", () => {
  const editor = createEditor("<p>one</p><h2>two</h2><pre><code>code</code></pre><p>four</p><p></p>")
  try {
    select(editor, 2)
    assert.equal(readParagraphSettings(editor, captureParagraphTarget(editor)).count, 1)
    const blocks = paragraphs(editor)
    select(editor, 2, blocks[1].pos + 1)
    assert.equal(readParagraphSettings(editor, captureParagraphTarget(editor)).count, 1)
    select(editor, blocks[1].pos + 2, 2)
    assert.equal(readParagraphSettings(editor, captureParagraphTarget(editor)).count, 2)
    let codePos = null
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "codeBlock") codePos = pos })
    select(editor, codePos + 1)
    assert.equal(captureParagraphTarget(editor), null)
    selectAll(editor)
    assert.equal(readParagraphSettings(editor, captureParagraphTarget(editor)).count, 4)
    select(editor, blocks.at(-1).pos + 1)
    assert.equal(readParagraphSettings(editor, captureParagraphTarget(editor)).count, 1)
  } finally { editor.destroy() }
})

// 设置面板显示 mixed 时不等于用户要求统一所有属性，仅 patch 字段可以改变，否则会丢失各段原格式。
test("多段混合值仅更新 patch 字段，未编辑的默认/0/false 和异样式保留", () => {
  const editor = createEditor("<p style='margin-top:3pt;break-after:auto'>a</p><h2 style='margin-top:7.5pt;break-after:avoid'>b</h2><p>c</p>")
  try {
    selectAll(editor)
    const target = captureParagraphTarget(editor)
    assert.deepEqual(readParagraphSettings(editor, target), {
      values: { spaceBefore: "mixed", spaceAfter: null, keepWithNext: "mixed", keepTogether: null }, count: 3
    })
    assert.equal(applyParagraphSettings(editor, target, { spaceAfter: 0, keepTogether: false }).ok, true)
    assert.deepEqual(paragraphs(editor).map(({ node }) => node.attrs.spaceBefore), [3, 7.5, null])
    assert.deepEqual(paragraphs(editor).map(({ node }) => node.attrs.keepWithNext), [false, true, null])
    assert.deepEqual(paragraphs(editor).map(({ node }) => node.attrs.spaceAfter), [0, 0, 0])
    assert.deepEqual(paragraphs(editor).map(({ node }) => node.attrs.keepTogether), [false, false, false])
    assert.ok(editor.state.selection instanceof AllSelection)
  } finally { editor.destroy() }
})

test("选区从空段或段末开始仍包含起始段，但结束仅触碰下一段起点时排除下一段", () => {
  const editor = createEditor("<p></p><p>two</p><p>three</p>")
  try {
    let blocks = paragraphs(editor)
    select(editor, 1, blocks[1].pos + 2)
    assert.equal(readParagraphSettings(editor, captureParagraphTarget(editor)).count, 2)
    select(editor, 1, blocks[1].pos + 1)
    assert.equal(readParagraphSettings(editor, captureParagraphTarget(editor)).count, 1)
    editor.commands.setContent("<p>one</p><p>two</p><p></p>")
    blocks = paragraphs(editor)
    select(editor, blocks[0].pos + blocks[0].node.nodeSize - 1, blocks[1].pos + 2)
    assert.equal(readParagraphSettings(editor, captureParagraphTarget(editor)).count, 2)
    select(editor, 1, blocks[2].pos + 1)
    assert.equal(readParagraphSettings(editor, captureParagraphTarget(editor)).count, 2)
  } finally { editor.destroy() }
})

test("整段和标题 NodeSelection 支持段落设置，代码节点选择没有适用目标", () => {
  const editor = createEditor("<p></p><h2>heading</h2><pre><code>code</code></pre>")
  try {
    for (const index of [0, 1]) {
      const block = paragraphs(editor)[index]
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, block.pos)))
      const target = captureParagraphTarget(editor)
      assert.equal(readParagraphSettings(editor, target).count, 1)
      assert.equal(applyParagraphSettings(editor, target, { spaceBefore: 6 }).ok, true)
      assert.equal(paragraphs(editor)[index].node.attrs.spaceBefore, 6)
      // paragraph/heading 默认不可由鼠标选成节点，PM 将其 NodeBookmark 规范为段内 TextSelection。
      assert.equal(editor.state.selection.$from.parent.type.name, block.node.type.name)
    }
    let codePos
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "codeBlock") codePos = pos })
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, codePos)))
    assert.equal(captureParagraphTarget(editor), null)
  } finally { editor.destroy() }
})

// 多格选择使用真实离散 ranges，期望范围故意包含未选中间列，以检出 selection.from/to 包围盒误用。
test("CellSelection 只收集被选单元格里的段落，不扩大到中间未选的列", () => {
  const editor = createEditor("<table><tr><td><p>a</p></td><td><p>b</p><h3>bb</h3></td></tr><tr><td><p>c</p></td><td><p></p></td></tr></table>")
  try {
    const table = editor.state.doc.firstChild
    const map = TableMap.get(table)
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, 1 + map.map[1], 1 + map.map[3])))
    const target = captureParagraphTarget(editor)
    assert.equal(readParagraphSettings(editor, target).count, 3)
    assert.equal(applyParagraphSettings(editor, target, { spaceAfter: 24 }).ok, true)
    assert.deepEqual(paragraphs(editor).map(({ node }) => node.attrs.spaceAfter), [null, 24, 24, null, 24])
    assert.ok(editor.state.selection instanceof CellSelection)
  } finally { editor.destroy() }
})

test("列表和被选外层单元格内的嵌套表格段落都属于原选择内容", () => {
  const editor = createEditor("<ul><li><p>list</p></li></ul><table><tr><td><p>outer</p><table><tr><td><p>inner</p></td></tr></table></td><td><p>outside</p></td></tr></table>")
  try {
    select(editor, paragraphs(editor)[0].pos + 1)
    assert.equal(readParagraphSettings(editor, captureParagraphTarget(editor)).count, 1)
    let outerTable
    editor.state.doc.descendants((node, pos) => { if (!outerTable && node.type.name === "table") outerTable = { node, pos } })
    const cell = outerTable.pos + 1 + TableMap.get(outerTable.node).map[0]
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cell)))
    const target = captureParagraphTarget(editor)
    assert.equal(readParagraphSettings(editor, target).count, 2)
    applyParagraphSettings(editor, target, { keepTogether: true })
    assert.deepEqual(paragraphs(editor).map(({ node }) => node.attrs.keepTogether), [null, true, true, null])
  } finally { editor.destroy() }
})

test("前方插段落、段首插字/删字/删全部内容都映射原节点，当前选区改变不重新指向", () => {
  const editor = createEditor("<p>before</p><p>target</p><p>later</p>")
  try {
    select(editor, paragraphs(editor)[1].pos + 2)
    const { target, stop } = track(editor)
    editor.view.dispatch(editor.state.tr.insert(0, editor.state.schema.nodes.paragraph.create(null, editor.state.schema.text("new"))))
    const original = paragraphs(editor)[2].pos
    editor.view.dispatch(editor.state.tr.insertText("xyz", original + 1))
    assert.equal(target.valid, true)
    editor.view.dispatch(editor.state.tr.delete(original + 1, original + 4))
    assert.equal(target.valid, true)
    editor.view.dispatch(editor.state.tr.delete(original + 1, original + 7))
    assert.equal(target.valid, true)
    select(editor, paragraphs(editor).at(-1).pos + 1)
    assert.equal(applyParagraphSettings(editor, target, { spaceBefore: 12.5 }).ok, true)
    assert.deepEqual(paragraphs(editor).map(({ node }) => node.attrs.spaceBefore), [null, null, 12.5, null])
    stop()
  } finally { editor.destroy() }
})

test("合法 setNodeMarkup 和标题类型切换保留目标，同时多步事务完成节点映射", () => {
  const editor = createEditor("<p>before</p><p>target</p>")
  try {
    select(editor, paragraphs(editor)[1].pos + 1)
    const { target, stop } = track(editor)
    const tr = editor.state.tr.insertText("x", 1)
    const pos = paragraphs(editor)[1].pos + 1
    tr.setNodeMarkup(pos, editor.state.schema.nodes.heading, { ...tr.doc.nodeAt(pos).attrs, level: 3, spaceAfter: 7.5 })
    editor.view.dispatch(tr)
    assert.equal(target.valid, true)
    assert.equal(readParagraphSettings(editor, target).values.spaceAfter, 7.5)
    assert.equal(applyParagraphSettings(editor, target, { keepWithNext: false }).ok, true)
    assert.equal(paragraphs(editor)[1].node.type.name, "heading")
    assert.equal(paragraphs(editor)[1].node.attrs.keepWithNext, false)
    stop()
  } finally { editor.destroy() }
})

test("紧贴原段落前插入新段只移动原目标；split 后保留原段而不转向新增段落", () => {
  for (const splitOffset of [0, 2]) {
    const editor = createEditor("<p>before</p><p>target</p><p>later</p>")
    try {
      const original = paragraphs(editor)[1]
      select(editor, original.pos + 1)
      const { target, stop } = track(editor)
      const paragraph = editor.state.schema.nodes.paragraph.create(null, editor.state.schema.text("inserted"))
      editor.view.dispatch(editor.state.tr.insert(original.pos, paragraph))
      assert.equal(target.valid, true)
      const shifted = paragraphs(editor)[2]
      editor.view.dispatch(editor.state.tr.split(shifted.pos + 1 + splitOffset))
      assert.equal(target.valid, true)
      select(editor, paragraphs(editor)[3].pos + 1)
      assert.equal(applyParagraphSettings(editor, target, { keepTogether: true }).ok, true)
      const blocks = paragraphs(editor)
      assert.deepEqual(blocks.map(({ node }) => node.attrs.keepTogether), [null, null, true, null, null])
      assert.equal(blocks[2].node.textContent, "target".slice(0, splitOffset))
      assert.equal(blocks[3].node.textContent, "target".slice(splitOffset))
      stop()
    } finally { editor.destroy() }
  }
})

// 视觉内容相同或坐标可解析也不能证明原段落仍存在，必须拒绝整个批次而非把旧草稿套给新外壳。
test("原段落删除、同位替换、join 消失或转为代码块后拒绝整个草稿", () => {
  for (const action of ["delete", "replace", "join", "code"]) {
    const editor = createEditor("<p>before</p><p>target</p><p>later</p>")
    try {
      select(editor, paragraphs(editor)[1].pos + 1)
      const { target, stop } = track(editor)
      const original = paragraphs(editor)[1]
      if (action === "delete") editor.view.dispatch(editor.state.tr.delete(original.pos, original.pos + original.node.nodeSize))
      if (action === "replace") editor.view.dispatch(editor.state.tr.replaceWith(original.pos, original.pos + original.node.nodeSize, original.node))
      if (action === "join") editor.commands.joinBackward()
      if (action === "code") editor.commands.toggleCodeBlock()
      assert.equal(target.valid, false, action)
      const content = editor.getJSON()
      assert.equal(applyParagraphSettings(editor, target, { spaceBefore: 20 }).ok, false)
      assert.deepEqual(editor.getJSON(), content)
      stop()
    } finally { editor.destroy() }
  }
})

test("未映射的旧 doc 与任一选中段落丢失均拒绝保存，未受影响段落不被部分提交", () => {
  const editor = createEditor("<p>one</p><p>two</p><p>three</p>")
  try {
    selectAll(editor)
    const stale = captureParagraphTarget(editor)
    editor.view.dispatch(editor.state.tr.insertText("x", 1))
    assert.equal(applyParagraphSettings(editor, stale, { spaceBefore: 10 }).ok, false)
    selectAll(editor)
    const { target, stop } = track(editor)
    const second = paragraphs(editor)[1]
    editor.view.dispatch(editor.state.tr.delete(second.pos, second.pos + second.node.nodeSize))
    assert.equal(target.valid, false)
    assert.equal(readParagraphSettings(editor, target), null)
    assert.equal(applyParagraphSettings(editor, target, { keepTogether: true }).ok, false)
    assert.deepEqual(paragraphs(editor).map(({ node }) => node.attrs.keepTogether), [null, null])
    stop()
  } finally { editor.destroy() }
})

// update 数量和逐次 undo 同时证明批量设置是一个正文步骤，且不会确认无变化草稿为新编辑。
test("一次保存只产生一个正文更新，并与前后文字输入分开撤销；同值 patch 不产生更新", () => {
  const editor = createEditor("<p>a</p><h2>b</h2>")
  try {
    select(editor, 1)
    editor.commands.insertContent("x")
    selectAll(editor)
    const { target, stop } = track(editor)
    let updates = 0
    editor.on("update", () => { updates += 1 })
    assert.deepEqual(applyParagraphSettings(editor, target, DEFAULT_LAYOUT), { ok: true, changed: false })
    assert.equal(updates, 0)
    assert.deepEqual(applyParagraphSettings(editor, target, { spaceBefore: 120, spaceAfter: 0, keepWithNext: false, keepTogether: true }), { ok: true, changed: true })
    assert.equal(updates, 1)
    select(editor, 1)
    editor.commands.insertContent("y")
    editor.commands.undo()
    assert.equal(paragraphs(editor)[0].node.textContent, "xa")
    assert.equal(paragraphs(editor)[1].node.attrs.spaceBefore, 120)
    editor.commands.undo()
    for (const { node } of paragraphs(editor)) assert.deepEqual(normalizeParagraphLayout(node.attrs), DEFAULT_LAYOUT)
    editor.commands.undo()
    assert.equal(paragraphs(editor)[0].node.textContent, "a")
    stop()
  } finally { editor.destroy() }
})

test("patch 白名单、只读、切换、输入法和销毁守卫拒绝修改正文", () => {
  const editor = createEditor("<p>a</p>")
  try {
    const { target, stop } = track(editor)
    const content = editor.getJSON()
    for (const patch of [null, [], { spaceBefore: "12" }, { spaceAfter: 120.5 }, { spaceBefore: 1.25 }, { keepWithNext: 1 }, { unknown: true }]) {
      assert.equal(applyParagraphSettings(editor, target, patch).ok, false)
    }
    editor.setEditable(false)
    assert.equal(applyParagraphSettings(editor, target, { spaceBefore: 12 }).ok, false)
    editor.setEditable(true)
    assert.equal(applyParagraphSettings(editor, target, { spaceBefore: 12 }, true).ok, false)
    editor.view.input.composing = true
    assert.equal(applyParagraphSettings(editor, target, { spaceBefore: 12 }).ok, false)
    editor.view.input.composing = false
    assert.deepEqual(editor.getJSON(), content)
    stop()
    editor.destroy()
    assert.equal(applyParagraphSettings(editor, target, { spaceBefore: 12 }).ok, false)
  } finally { if (!editor.isDestroyed) editor.destroy() }
})
