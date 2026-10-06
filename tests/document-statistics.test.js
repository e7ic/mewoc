/**
 * 验证正文与选区统计的字符口径、Unicode 码点、段落覆盖和非连续表格范围。
 * 全选是纯选区操作，即使只读也可用，但切换/组合输入/销毁期间必须拦截。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { getDocumentStatistics, selectDocumentContents } from "../src/pages/editor/tools/document-statistics.js"

// 安装编辑器需要的浏览器对象和帧调度，让 Node 测试执行真实 schema/事务逻辑；JSDOM 不承担原生版式验收。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// 每个场景创建独立编辑器并在 finally 销毁，隔离正文、插件和撤销历史；扩展组合只提供该组验证所需能力。
const createEditor = (content = "<p>one</p><p>two</p>") => new Editor({
  element: document.createElement("div"),
  extensions: createExtensions().map(extension => extension.name === "starterKit" ? extension.configure({ trailingNode: false }) : extension), content
})
// 统一从当前真实文档和选区读取，位置选择 helper 可精确设置段落起点和边界。
const read = editor => getDocumentStatistics(editor.state.doc, editor.state.selection)
const select = (editor, from, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))

test("字符按码点及实际空白统计，段落覆盖标题、代码块、空段和表格内段落", () => {
  const editor = createEditor({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "A 😀 \tB" }, { type: "hardBreak" }, { type: "text", text: "C" }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
    { type: "codeBlock", content: [{ type: "text", text: "x\ny" }] },
    { type: "table", content: [{ type: "tableRow", content: [
      { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "左 格" }] }] },
      { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "右" }] }] }
    ] }] }, { type: "paragraph" }
  ] })
  try {
    assert.deepEqual(read(editor).document, { characters: 17, charactersWithoutWhitespace: 11, paragraphs: 6 })
    assert.equal(read(editor).selection, null)
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    assert.deepEqual(read(editor).selection, read(editor).document)
  } finally { editor.destroy() }
})

test("部分文字选区精确截取，下一段内容起点不计入段落，光标不生成选区统计", () => {
  const editor = createEditor("<p>one</p><p>two</p>")
  try {
    select(editor, 2, 4)
    assert.deepEqual(read(editor).selection, { characters: 2, charactersWithoutWhitespace: 2, paragraphs: 1 })
    select(editor, 1, editor.state.doc.firstChild.nodeSize + 1)
    assert.deepEqual(read(editor).selection, { characters: 3, charactersWithoutWhitespace: 3, paragraphs: 1 })
    select(editor, 2)
    assert.equal(read(editor).selection, null)
    editor.commands.insertContent("😀")
    assert.deepEqual(read(editor).document, { characters: 7, charactersWithoutWhitespace: 7, paragraphs: 2 })
  } finally { editor.destroy() }
})

// 选格范围不连续，用包围盒会把未选列算进去；期望数字依据实际单元格内容而非全表文本。
test("跨行的CellSelection仅统计所选单元格，不统计包围盒内其他单元格", () => {
  const editor = createEditor("<table><tr><td><p>a</p></td><td><p>unselected</p></td></tr><tr><td><p>bc</p></td><td><p>other</p></td></tr></table>")
  try {
    const map = TableMap.get(editor.state.doc.firstChild)
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, 1 + map.map[0], 1 + map.map[2])))
    assert.deepEqual(read(editor).selection, { characters: 3, charactersWithoutWhitespace: 3, paragraphs: 2 })
    assert.deepEqual(read(editor).document, { characters: 18, charactersWithoutWhitespace: 18, paragraphs: 4 })
  } finally { editor.destroy() }
})

// 同时检查 JSON、update 和 undo，证明可读定位不会被误记为文档编辑或触发自动保存。
test("只读全选仅改变选区，不改正文、不产生update和撤销记录", () => {
  const editor = createEditor()
  let updates = 0
  editor.on("update", () => { updates += 1 })
  try {
    editor.setEditable(false, false)
    const before = editor.getJSON()
    assert.equal(selectDocumentContents(editor), true)
    assert.ok(editor.state.selection instanceof AllSelection)
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(updates, 0)
    assert.equal(editor.can().undo(), false)
  } finally { editor.destroy() }
})

test("切换、输入法组合和销毁阻止全选，节点选区统计所选文本块", () => {
  const editor = createEditor()
  try {
    const selection = editor.state.selection.toJSON()
    assert.equal(selectDocumentContents(editor, true), false)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionstart", { bubbles: true }))
    assert.equal(selectDocumentContents(editor), false)
    assert.deepEqual(editor.state.selection.toJSON(), selection)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionend", { bubbles: true }))
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    assert.deepEqual(read(editor).selection, { characters: 3, charactersWithoutWhitespace: 3, paragraphs: 1 })
  } finally { editor.destroy() }
  assert.equal(selectDocumentContents(editor), false)
})
