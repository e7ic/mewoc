/**
 * 验证正文/H1–H6 的段落样式切换保留文字格式、段落精细设置、原选区与待输入 marks。
 * 包含多格范围、追加事务、永久失效与父结构约束，确保样式图库不作用到后来点击的内容。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { AllSelection, NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { mapParagraphTarget } from "../src/pages/editor/tools/paragraph-settings.js"
import { applyParagraphStyle, captureParagraphStyleTarget, getNextParagraphStyleLevel, readParagraphStyle } from "../src/pages/editor/tools/paragraph-style.js"

// 安装编辑器需要的浏览器对象和帧调度，让 Node 测试执行真实 schema/事务逻辑；JSDOM 不承担原生版式验收。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// 每个场景创建独立编辑器并在 finally 销毁，隔离正文、插件和撤销历史；扩展组合只提供该组验证所需能力。
const createEditor = (content = "<p>第一段</p><p>第二段</p>") => new Editor({
  element: document.createElement("div"),
  extensions: createExtensions().map(extension => extension.name === "starterKit" ? extension.configure({ trailingNode: false }) : extension), content
})
// 每次从最新正文树读取段落与标题位置，避免结构转换后的断言依赖过期坐标。
const blocks = editor => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (["paragraph", "heading"].includes(node.type.name)) result.push({ node, pos }) })
  return result
}
const select = (editor, from, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
// 模拟弹层打开期间的目标跟踪，主事务与插件追加事务都依次映射；stop 用于场景结束时解除监听。
const track = editor => {
  const target = captureParagraphStyleTarget(editor)
  const listener = ({ transaction, appendedTransactions = [] }) => {
    for (const current of [transaction, ...appendedTransactions]) mapParagraphTarget(target, current)
  }
  editor.on("transaction", listener)
  return { target, stop: () => editor.off("transaction", listener) }
}

test("正文与H1–H6转换保留文字marks及段落精细属性，不触碰未选段落", () => {
  const editor = createEditor('<p style="margin-top:7.5pt;margin-bottom:12.5pt;break-inside:avoid;break-after:auto;text-indent:2em;margin-left:3em;line-height:2"><strong>格式文字</strong></p><p>另一段</p>')
  try {
    select(editor, 2)
    const originalAttrs = { ...blocks(editor)[0].node.attrs }
    const originalContent = blocks(editor)[0].node.content.toJSON()
    for (const level of [1, 2, 3, 4, 5, 6, 0]) {
      const { target, stop } = track(editor)
      assert.equal(applyParagraphStyle(editor, target, level).ok, true)
      const first = blocks(editor)[0].node
      assert.equal(first.type.name, level ? "heading" : "paragraph")
      assert.equal(readParagraphStyle(editor), level)
      const { level: _level, ...attrs } = first.attrs
      assert.deepEqual(attrs, originalAttrs)
      assert.deepEqual(first.content.toJSON(), originalContent)
      assert.equal(blocks(editor)[1].node.type.name, "paragraph")
      stop()
    }
  } finally { editor.destroy() }
})

// 先设置尚未写入文字的 storedMarks，再切换段落类型继续输入，检出工具栏夺焦后待输入格式丢失。
test("卡片应用保留原光标的待输入格式，标题改变之后输入仍使用显式字号", () => {
  const editor = createEditor()
  try {
    select(editor, 2)
    editor.commands.setFontSize("18pt")
    const target = captureParagraphStyleTarget(editor)
    assert.equal(applyParagraphStyle(editor, target, 4).ok, true)
    assert.equal(editor.getAttributes("textStyle").fontSize, "18pt")
    editor.commands.insertContent("新字")
    const text = editor.getJSON().content[0].content.find(node => node.text.includes("新字"))
    assert.equal(text.marks.find(mark => mark.type === "textStyle").attrs.fontSize, "18pt")
  } finally { editor.destroy() }
})

test("混合样式无假选中，结束只触及下一段起点时不统一该段，代码块无适用目标", () => {
  const editor = createEditor("<p>one</p><h2>two</h2><pre><code>code</code></pre><p></p>")
  try {
    const records = blocks(editor)
    select(editor, 1, records[1].pos + 2)
    assert.equal(readParagraphStyle(editor), "mixed")
    select(editor, 1, records[1].pos + 1)
    assert.equal(readParagraphStyle(editor), 0)
    assert.equal(applyParagraphStyle(editor, captureParagraphStyleTarget(editor), 3).ok, true)
    assert.equal(blocks(editor)[0].node.attrs.level, 3)
    assert.equal(blocks(editor)[1].node.attrs.level, 2)
    let codePosition
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "codeBlock") codePosition = pos })
    select(editor, codePosition + 1)
    assert.equal(readParagraphStyle(editor), null)
    assert.equal(captureParagraphStyleTarget(editor), null)
    assert.equal(applyParagraphStyle(editor, null, 1).ok, false)
    select(editor, blocks(editor).at(-1).pos + 1)
    assert.equal(applyParagraphStyle(editor, captureParagraphStyleTarget(editor), 6).ok, true)
    assert.equal(blocks(editor).at(-1).node.attrs.level, 6)
  } finally { editor.destroy() }
})

test("全选和段落NodeSelection支持样式，单次撤销不吞并之前输入", () => {
  const editor = createEditor("<p>a</p><h2>b</h2><pre><code>code</code></pre>")
  try {
    editor.commands.insertContentAt(1, "前次输入")
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    const before = editor.getJSON()
    assert.equal(applyParagraphStyle(editor, captureParagraphStyleTarget(editor), 5).ok, true)
    assert.deepEqual(blocks(editor).map(({ node }) => node.attrs.level), [5, 5])
    assert.equal(editor.getJSON().content[2].type, "codeBlock")
    assert.ok(editor.state.selection instanceof AllSelection)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    assert.match(editor.state.doc.firstChild.textContent, /前次输入/)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    assert.equal(applyParagraphStyle(editor, captureParagraphStyleTarget(editor), 6).ok, true)
    assert.ok(editor.state.selection instanceof NodeSelection)
    assert.equal(editor.state.selection.node.attrs.level, 6)
  } finally { editor.destroy() }
})

test("CellSelection仅改实际选中单元格段落，保留表格结构和选区", () => {
  const editor = createEditor("<table><tr><td><p>a</p></td><td><p>b</p></td></tr><tr><td><p>c</p></td><td><p>d</p></td></tr></table>")
  try {
    const table = editor.state.doc.firstChild
    const map = TableMap.get(table)
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, 1 + map.map[0], 1 + map.map[2])))
    const beforeText = editor.getText()
    const target = captureParagraphStyleTarget(editor)
    assert.equal(target.positions.length, 2)
    assert.equal(applyParagraphStyle(editor, target, 4).ok, true)
    assert.deepEqual(blocks(editor).map(({ node }) => node.type.name === "heading" ? node.attrs.level : 0), [4, 0, 4, 0])
    assert.ok(editor.state.selection instanceof CellSelection)
    assert.equal(editor.state.doc.firstChild.childCount, 2)
    assert.equal(editor.state.doc.firstChild.firstChild.childCount, 2)
    assert.equal(editor.getText(), beforeText)
  } finally { editor.destroy() }
})

test("打开图库后移动光标仍应用原目标，普通和追加事务都映射原段落", () => {
  const editor = createEditor()
  let stop
  try {
    editor.registerPlugin(new Plugin({
      appendTransaction(transactions, _before, state) {
        if (!transactions.some(transaction => transaction.getMeta("style-target-preface"))) return null
        return state.tr.insert(0, state.schema.nodes.paragraph.create(null, state.schema.text("追加段落")))
      }
    }))
    select(editor, 2)
    const tracked = track(editor)
    stop = tracked.stop
    const target = tracked.target
    editor.commands.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "前方插入" }] })
    let appended = 0
    editor.on("transaction", event => { appended += event.appendedTransactions.length })
    editor.view.dispatch(editor.state.tr.setMeta("style-target-preface", true))
    assert.ok(appended > 0)
    select(editor, blocks(editor).at(-1).pos + 1)
    assert.equal(applyParagraphStyle(editor, target, 6).ok, true)
    assert.equal(blocks(editor).find(({ node }) => node.textContent === "第一段").node.attrs.level, 6)
    assert.equal(blocks(editor).find(({ node }) => node.textContent === "第二段").node.type.name, "paragraph")
    assert.equal(editor.state.selection.$from.parent.textContent, "第一段")
  } finally { stop?.(); editor.destroy() }
})

// 最终位置和文本可能与原段一致，仍须跟踪实际 token 删除而永久失效，撤销也不能复活旧弹层草稿。
test("整段同位置替换、删除再插入及追加事务替换均不能收到旧样式目标", () => {
  for (const mode of ["replace", "delete-insert", "append-replace"]) {
    const editor = createEditor()
    let stop
    try {
      select(editor, 2)
      const tracked = track(editor)
      stop = tracked.stop
      const target = tracked.target
      const original = editor.state.doc.firstChild
      if (mode === "replace") editor.view.dispatch(editor.state.tr.replaceWith(0, original.nodeSize, original))
      if (mode === "delete-insert") {
        editor.view.dispatch(editor.state.tr.delete(0, original.nodeSize))
        editor.view.dispatch(editor.state.tr.insert(0, original))
      }
      if (mode === "append-replace") {
        editor.registerPlugin(new Plugin({
          appendTransaction(transactions, _before, state) {
            if (!transactions.some(transaction => transaction.getMeta("replace-style-paragraph"))) return null
            return state.tr.replaceWith(0, state.doc.firstChild.nodeSize, state.doc.firstChild)
          }
        }))
        editor.view.dispatch(editor.state.tr.setMeta("replace-style-paragraph", true))
      }
      const before = editor.getJSON()
      assert.equal(target.valid, false, mode)
      assert.equal(applyParagraphStyle(editor, target, 2).ok, false, mode)
      assert.deepEqual(editor.getJSON(), before, mode)
    } finally { stop?.(); editor.destroy() }
  }
})

test("只读、切换、组合输入、销毁、非法级别与过期doc拒绝写入", () => {
  const editor = createEditor()
  try {
    const target = captureParagraphStyleTarget(editor)
    const before = editor.getJSON()
    for (const value of [null, "2", -1, 1.5, 7, NaN]) assert.equal(applyParagraphStyle(editor, target, value).ok, false)
    assert.equal(applyParagraphStyle(editor, target, 2, true).ok, false)
    editor.setEditable(false, false)
    assert.equal(captureParagraphStyleTarget(editor), null)
    assert.equal(applyParagraphStyle(editor, target, 2).ok, false)
    editor.setEditable(true, false)
    Object.defineProperty(editor.view, "composing", { configurable: true, value: true })
    assert.equal(captureParagraphStyleTarget(editor), null)
    assert.equal(applyParagraphStyle(editor, target, 2).ok, false)
    delete editor.view.composing
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.insertContentAt(1, "变化")
    assert.equal(applyParagraphStyle(editor, target, 2).ok, false)
    editor.destroy()
    assert.equal(applyParagraphStyle(editor, target, 2).ok, false)
    assert.equal(readParagraphStyle(editor), null)
  } finally { if (!editor.isDestroyed) editor.destroy() }
})

test("相同样式不增加正文更新，仍恢复图库打开前的原选区", () => {
  const editor = createEditor()
  try {
    select(editor, 2)
    const target = captureParagraphStyleTarget(editor)
    const bookmark = target.bookmark.resolve(editor.state.doc)
    select(editor, blocks(editor)[1].pos + 2)
    let updates = 0
    editor.on("update", () => { updates += 1 })
    assert.deepEqual(applyParagraphStyle(editor, target, 0), { ok: true, changed: false })
    assert.equal(updates, 0)
    assert.ok(editor.state.selection.eq(bookmark))
  } finally { editor.destroy() }
})

// 使用完整扩展默认的自动末尾段行为，验证主事务之后追加节点既参与映射又保持同一次撤销。
test("最后一段切标题后的自动末尾段追加事务保持原目标且跟本次样式一起撤销", () => {
  const editor = new Editor({ element: document.createElement("div"), extensions: createExtensions(), content: "<p>末尾段</p>" })
  let stop
  try {
    const before = editor.getJSON()
    const tracked = track(editor)
    stop = tracked.stop
    assert.equal(applyParagraphStyle(editor, tracked.target, 6).ok, true)
    assert.equal(editor.state.doc.firstChild.type.name, "heading")
    assert.equal(editor.state.doc.lastChild.type.name, "paragraph")
    assert.equal(tracked.target.valid, true)
    assert.equal(tracked.target.doc, editor.state.doc)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
  } finally { stop?.(); editor.destroy() }
})

// 先检查所有目标的父 schema 能力，任一不合法必须拒绝整批，不能先转换可用段落再返回错误。
test("列表首段不能换成标题时整批操作拒绝，重新选择正文后仍能应用新样式且保持列表", () => {
  const editor = createEditor("<p>外段</p><ul><li><p>列表文字</p></li></ul>")
  try {
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    const before = editor.getJSON()
    assert.equal(applyParagraphStyle(editor, captureParagraphStyleTarget(editor), 2).ok, false)
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(applyParagraphStyle(editor, captureParagraphStyleTarget(editor), 0).ok, true)
    assert.equal(editor.getJSON().content[1].type, "bulletList")
    select(editor, 1)
    assert.equal(applyParagraphStyle(editor, captureParagraphStyleTarget(editor), 3).ok, true)
    assert.equal(editor.state.doc.firstChild.attrs.level, 3)
    assert.equal(editor.getJSON().content[1].type, "bulletList")
    assert.equal(editor.state.doc.child(1).firstChild.firstChild.type.name, "paragraph")
  } finally { editor.destroy() }
})

test("方向键能展开并遍历全部卡片，Home/End定位且上下按两行关系移动", () => {
  assert.deepEqual(getNextParagraphStyleLevel(3, "ArrowRight", false), { level: 4, expanded: true })
  assert.deepEqual(getNextParagraphStyleLevel(0, "ArrowLeft", false), { level: 6, expanded: true })
  assert.deepEqual(getNextParagraphStyleLevel(1, "ArrowDown", false), { level: 5, expanded: true })
  assert.deepEqual(getNextParagraphStyleLevel(6, "ArrowUp", true), { level: 2, expanded: true })
  assert.deepEqual(getNextParagraphStyleLevel(5, "Home", true), { level: 0, expanded: true })
  assert.deepEqual(getNextParagraphStyleLevel(0, "End", false), { level: 6, expanded: true })
  assert.equal(getNextParagraphStyleLevel(2, "Escape", true), null)
})
