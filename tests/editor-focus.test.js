/** 段落聚焦视图回归：焦点、anchor 和选区类型共同决定单段装饰，文档/历史/保存保持独立。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state"
import { EditorFocus, EDITOR_FOCUS_CLASS, EDITOR_FOCUS_KEY } from "../src/pages/editor/extensions/editor-focus.js"

// 提供可聚焦的 DOM 环境以触发内建 focus/blur 事务，测试不模拟真实视觉排版。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// 最小 schema 同时包含普通块与表格，关闭额外尾段便于精确比较选区位置。
const createEditor = content => new Editor({
  element: document.body.appendChild(document.createElement("div")),
  extensions: [StarterKit.configure({ trailingNode: false }), TableKit, EditorFocus],
  editorProps: { attributes: { class: "mewoc-content" }, handleScrollToSelection: () => true }, content
})
// 显式构造 anchor/head，覆盖正向与反向跨段选择，而非只检查 from/to。
const select = (editor, anchor, head = anchor) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)))
// 从实际 DOM 读取装饰类，证明插件已更新编辑视图。
const highlighted = editor => [...editor.view.dom.querySelectorAll(`.${EDITOR_FOCUS_CLASS}`)]
// 收集实际段落边界，避免列表/表格嵌套中的位置用硬编码推断。
const blocks = editor => {
  const paragraphs = []
  editor.state.doc.descendants((node, pos) => { if (["paragraph", "heading"].includes(node.type.name)) paragraphs.push({ node, pos }) })
  return paragraphs
}
// 销毁编辑器并移除挂载壳，便于验证旧 DOM 事件不再回写新会话。
const destroy = editor => {
  const host = editor.options.element
  editor.destroy()
  host.remove()
}

test("正文 focus/blur 立即更新单段装饰，返回正文后恢复，不依赖额外事务或 listener", () => {
  const editor = createEditor("<p>one</p><h2>two</h2>")
  const button = document.body.appendChild(document.createElement("button"))
  try {
    const doc = editor.state.doc
    assert.equal(highlighted(editor).length, 0)
    editor.view.dom.focus()
    assert.equal(editor.view.hasFocus(), true)
    assert.equal(highlighted(editor).length, 1)
    assert.equal(highlighted(editor)[0].tagName, "P")
    button.focus()
    assert.equal(editor.isFocused, false)
    assert.equal(highlighted(editor).length, 0)
    editor.view.dom.focus()
    assert.equal(highlighted(editor).length, 1)
    editor.view.dom.blur()
    assert.equal(document.activeElement, document.body)
    assert.equal(highlighted(editor).length, 0)
    assert.equal(editor.state.doc, doc)
    const plugin = EDITOR_FOCUS_KEY.get(editor.state)
    assert.equal(plugin.spec.props.handleDOMEvents, undefined)
    assert.equal(plugin.spec.view, undefined)
  } finally { button.remove(); destroy(editor) }
})

test("跨段正反文字选择只标记 anchor 所在段落，选区变化不涂满全选范围", () => {
  const editor = createEditor("<p>one</p><h2>two</h2><p>three</p>")
  try {
    editor.view.dom.focus()
    const paragraphs = blocks(editor)
    select(editor, 2, paragraphs[2].pos + 3)
    assert.deepEqual(highlighted(editor).map(element => element.textContent), ["one"])
    select(editor, paragraphs[2].pos + 3, 2)
    assert.deepEqual(highlighted(editor).map(element => element.textContent), ["three"])
    select(editor, paragraphs[1].pos + 1)
    assert.deepEqual(highlighted(editor).map(element => element.tagName), ["H2"])
    assert.equal(EDITOR_FOCUS_KEY.get(editor.state).props.decorations(editor.state).find().length, 1)
  } finally { destroy(editor) }
})

test("列表、引用和表格内只装饰最近段落；祖先列表/单元格没有聚焦 class", () => {
  const editor = createEditor("<ul><li><p>list</p></li></ul><blockquote><p>quote</p></blockquote><table><tr><td><p>cell</p></td></tr></table>")
  try {
    editor.view.dom.focus()
    for (const { node, pos } of blocks(editor)) {
      select(editor, pos + 1)
      assert.deepEqual(highlighted(editor).map(element => element.textContent), [node.textContent])
      assert.equal(highlighted(editor)[0].tagName, "P")
    }
    assert.equal(editor.view.dom.querySelector(`li.${EDITOR_FOCUS_CLASS}, blockquote.${EDITOR_FOCUS_CLASS}, td.${EDITOR_FOCUS_CLASS}, table.${EDITOR_FOCUS_CLASS}`), null)
  } finally { destroy(editor) }
})

test("H6 与已有标题共享聚焦装饰，标题级别及导出内容保留", () => {
  const editor = createEditor("<p>before</p><h6>sixth</h6>")
  try {
    const heading = blocks(editor).find(({ node }) => node.type.name === "heading")
    assert.equal(heading.node.attrs.level, 6)
    select(editor, heading.pos + 1)
    editor.view.dom.focus()
    assert.deepEqual(highlighted(editor).map(element => element.tagName), ["H6"])
    assert.equal(editor.state.doc.nodeAt(heading.pos).attrs.level, 6)
    assert.match(editor.getHTML(), /<h6>sixth<\/h6>/)
    assert.equal(editor.getHTML().includes(EDITOR_FOCUS_CLASS), false)
  } finally { destroy(editor) }
})

test("只读即使仍有 DOM 焦点也不装饰，失焦状态不会被 isFocused 残值重新装饰", () => {
  const editor = createEditor("<p>text</p>")
  try {
    editor.view.dom.focus()
    assert.equal(highlighted(editor).length, 1)
    editor.setEditable(false, false)
    assert.equal(highlighted(editor).length, 0)
    editor.setEditable(true, false)
    editor.view.dom.focus()
    assert.equal(highlighted(editor).length, 1)
    editor.view.dom.blur()
    editor.isFocused = true
    editor.view.dispatch(editor.state.tr)
    assert.equal(editor.view.hasFocus(), false)
    assert.equal(highlighted(editor).length, 0)
  } finally { destroy(editor) }
})

test("NodeSelection、CellSelection、AllSelection 和代码选区不误标记相邻段落", () => {
  const editor = createEditor("<p>before</p><table><tr><td><p>a</p></td><td><p>b</p></td></tr></table><pre><code>code</code></pre><p>after</p>")
  try {
    editor.view.dom.focus()
    assert.equal(highlighted(editor).length, 1)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    assert.equal(highlighted(editor).length, 0)
    let table
    let codePos
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "table") table = { node, pos }
      if (node.type.name === "codeBlock") codePos = pos
    })
    const map = TableMap.get(table.node)
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, table.pos + 1 + map.map[0], table.pos + 1 + map.map[1])))
    assert.equal(highlighted(editor).length, 0)
    assert.equal(editor.view.dom.querySelectorAll(".selectedCell").length, 2)
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    assert.equal(highlighted(editor).length, 0)
    select(editor, codePos + 1)
    assert.equal(highlighted(editor).length, 0)
    select(editor, blocks(editor).at(-1).pos + 1)
    assert.deepEqual(highlighted(editor).map(element => element.textContent), ["after"])
  } finally { destroy(editor) }
})

// 视觉变化必须与正文变更区分，联合检查 JSON、HTML、revision 和撤销历史。
test("聚焦装饰不进入文档 JSON/HTML，不触发保存 revision 或创建撤销步骤", () => {
  const editor = createEditor("<p>one</p><p>two</p>")
  try {
    const json = editor.getJSON()
    const html = editor.getHTML()
    const doc = editor.state.doc
    let revision = 0
    editor.on("update", () => { revision += 1 })
    editor.view.dom.focus()
    select(editor, blocks(editor)[1].pos + 1)
    editor.view.dom.blur()
    editor.view.dom.focus()
    assert.equal(revision, 0)
    assert.equal(editor.can().undo(), false)
    assert.equal(editor.state.doc, doc)
    assert.deepEqual(editor.getJSON(), json)
    assert.equal(editor.getHTML(), html)
    assert.match(editor.view.dom.innerHTML, new RegExp(EDITOR_FOCUS_CLASS))
    editor.commands.insertContent("x")
    assert.equal(revision, 1)
    editor.view.dom.blur()
    editor.view.dom.focus()
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), json)
    assert.equal(editor.can().undo(), false)
    assert.equal(editor.getHTML().includes(EDITOR_FOCUS_CLASS), false)
  } finally { destroy(editor) }
})

test("销毁后旧 DOM 的 focus/blur 不派发事件，新会话没有残留聚焦反馈", () => {
  const editor = createEditor("<p>old</p>")
  const oldDom = editor.view.dom
  let transactions = 0
  editor.on("transaction", () => { transactions += 1 })
  oldDom.focus()
  assert.equal(highlighted(editor).length, 1)
  destroy(editor)
  const count = transactions
  oldDom.dispatchEvent(new window.FocusEvent("focus"))
  oldDom.dispatchEvent(new window.FocusEvent("blur"))
  assert.equal(transactions, count)
  const next = createEditor("<p>new</p>")
  try {
    assert.equal(highlighted(next).length, 0)
    next.view.dom.focus()
    assert.deepEqual(highlighted(next).map(element => element.textContent), ["new"])
  } finally { destroy(next) }
})
