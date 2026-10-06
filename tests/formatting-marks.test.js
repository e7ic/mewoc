/** 格式标记回归：覆盖复杂容器、原文/导出不变、权限、组合输入、历史与装饰缓存。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import JSZip from "jszip"
import { Editor, Node } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { Slice } from "@tiptap/pm/model"
import { undoDepth } from "@tiptap/pm/history"
import { FormattingMarks, FORMATTING_MARKS_KEY, getFormattingMarksVisible } from "../src/pages/editor/extensions/formatting-marks.js"
import { DocumentTaskList, DocumentTaskItem } from "../src/pages/editor/extensions/document-task-list.js"
import { collectFormattingMarkRanges } from "../src/pages/editor/tools/formatting-marks.js"
import { getDocumentStatistics } from "../src/pages/editor/tools/document-statistics.js"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// 有内部正文的 atom 仍整体选取，不能因为其 schema 容许 text/paragraph 就深入装饰。
const InlineToken = Node.create({ name: "inlineToken", group: "inline", inline: true, atom: true,
  content: "text*", renderHTML: () => ["span", { "data-opaque-inline": "true" }, 0] })
const BlockToken = Node.create({ name: "blockToken", group: "block", atom: true,
  content: "paragraph+", renderHTML: () => ["div", { "data-opaque-block": "true" }, 0] })
const text = value => ({ type: "text", text: value })
const paragraph = value => ({ type: "paragraph", ...(value ? { content: [text(value)] } : {}) })
const createEditor = (...content) => new Editor({
  element: document.body.appendChild(document.createElement("div")),
  extensions: [StarterKit.configure({ trailingNode: false }), TableKit, DocumentTaskList, DocumentTaskItem, InlineToken, BlockToken, FormattingMarks],
  editorProps: { handleScrollToSelection: () => true }, content: { type: "doc", content }
})
const state = editor => FORMATTING_MARKS_KEY.getState(editor.state)
const marks = (editor, kind) => [...editor.view.dom.querySelectorAll(`[data-mewoc-format-mark${kind ? `="${kind}"` : ""}]`)]
const destroy = editor => {
  const host = editor.options.element
  editor.destroy()
  host.remove()
}
const pause = () => new Promise(resolve => setTimeout(resolve, 60))

test("工具按正文/标题、列表和单元格收集标记，空段与显式换行都有独立位置", () => {
  const editor = createEditor(
    { type: "paragraph", content: [text("正文  空格\u00a0\u00a0换\t\t行"), { type: "hardBreak" }, text("末尾")] },
    { type: "heading", attrs: { level: 2 }, content: [text("标题 空间")] },
    { type: "blockquote", content: [paragraph("")] },
    { type: "bulletList", content: [{ type: "listItem", content: [paragraph("列表 x")] }] },
    { type: "orderedList", content: [{ type: "listItem", content: [paragraph("编号 x")] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("待办 x")] }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph("单元 x")] }] }] },
    { type: "codeBlock", content: [text("code \u00a0\t")] }, { type: "horizontalRule" }
  )
  try {
    const ranges = collectFormattingMarkRanges(editor.state.doc)
    assert.equal(ranges.filter(range => range.kind === "paragraph").length, 7)
    assert.equal(ranges.filter(range => range.kind === "space").length, 6)
    assert.equal(ranges.filter(range => range.kind === "nbsp").length, 1)
    assert.equal(ranges.filter(range => range.kind === "tab").length, 1)
    assert.equal(ranges.filter(range => range.kind === "hardBreak").length, 1)
    assert.equal(ranges.find(range => range.kind === "space").count, 2)
    assert.equal(ranges.find(range => range.kind === "nbsp").count, 2)
    assert.equal(ranges.find(range => range.kind === "tab").count, 2)
    for (const range of ranges.filter(item => item.kind === "hardBreak")) assert.equal(editor.state.doc.nodeAt(range.from).type.name, "hardBreak")
    assert.equal(marks(editor).length, 0)
    editor.commands.setFormattingMarksVisible(true)
    assert.equal(marks(editor, "paragraph").length, 7)
    assert.equal(marks(editor, "hardBreak").length, 1)
    assert.equal(marks(editor).length, ranges.length)
    assert.equal(marks(editor, "paragraph").filter(mark => mark.parentElement.tagName === "H2").length, 1)
    assert.equal(editor.view.dom.querySelector("pre [data-mewoc-format-mark]"), null)
  } finally { destroy(editor) }
})

test("代码 mark 与带内部内容的 atom 不被装饰，同类空白不跨文字格式边界合并", () => {
  const editor = createEditor({ type: "paragraph", content: [
    text("a  "), { type: "text", text: "  b", marks: [{ type: "bold" }] },
    { type: "text", text: "c \t d", marks: [{ type: "code" }] },
    { type: "inlineToken", content: [text("opaque \u00a0\t")] }
  ] }, { type: "blockToken", content: [paragraph("opaque \u00a0\t")] })
  try {
    editor.commands.setFormattingMarksVisible(true)
    assert.deepEqual(collectFormattingMarkRanges(editor.state.doc).map(range => range.kind), ["space", "space", "paragraph"])
    assert.equal(marks(editor, "space").length, 2)
    assert.equal(editor.view.dom.querySelector("code [data-mewoc-format-mark], [data-opaque-inline] [data-mewoc-format-mark], [data-opaque-block] [data-mewoc-format-mark]"), null)
  } finally { destroy(editor) }
})

test("开启关闭仅更新视图，JSON/HTML/文本/统计/选区/保存 revision 与撤销深度不变", () => {
  const editor = createEditor({ type: "paragraph", content: [text("a b\u00a0c\td"), { type: "hardBreak" }, text("末尾")] })
  try {
    editor.commands.setTextSelection({ from: 2, to: 5 })
    const json = editor.getJSON()
    const html = editor.getHTML()
    const domText = editor.view.dom.textContent
    const selection = editor.state.selection.toJSON()
    const statistics = getDocumentStatistics(editor.state.doc, editor.state.selection)
    const doc = editor.state.doc
    let revisions = 0
    const transactions = []
    editor.on("update", () => { revisions += 1 })
    editor.on("transaction", ({ transaction }) => { transactions.push(transaction) })
    assert.equal(editor.can().setFormattingMarksVisible(true), true)
    assert.equal(getFormattingMarksVisible(editor), false)
    assert.equal(marks(editor).length, 0)
    editor.commands.setFormattingMarksVisible(true)
    assert.equal(marks(editor).length, 5)
    assert.equal(undoDepth(editor.state), 0)
    assert.equal(editor.view.dom.textContent, domText)
    assert.deepEqual(getDocumentStatistics(editor.state.doc, editor.state.selection), statistics)
    assert.equal(editor.getHTML(), html)
    editor.commands.setFormattingMarksVisible(false)
    assert.equal(marks(editor).length, 0)
    assert.equal(revisions, 0)
    assert.equal(editor.state.doc, doc)
    assert.deepEqual(editor.getJSON(), json)
    assert.deepEqual(editor.state.selection.toJSON(), selection)
    assert.equal(undoDepth(editor.state), 0)
    assert.equal(transactions.filter(transaction => transaction.docChanged).length, 0)
    assert.equal(transactions.filter(transaction => transaction.getMeta(FORMATTING_MARKS_KEY)).every(transaction => transaction.getMeta("addToHistory") === false), true)
  } finally { destroy(editor) }
})

test("只读无事务切换立即隐藏，偏好保留且恢复编辑后显示，命令也可在只读同步偏好", () => {
  const editor = createEditor(paragraph("a b"))
  try {
    editor.commands.setFormattingMarksVisible(true)
    const cached = state(editor)
    editor.setEditable(false, false)
    assert.equal(marks(editor).length, 0)
    assert.equal(getFormattingMarksVisible(editor), true)
    assert.equal(state(editor), cached)
    editor.setEditable(true, false)
    assert.equal(marks(editor).length, 2)
    editor.setEditable(false, false)
    editor.commands.setFormattingMarksVisible(false)
    assert.equal(getFormattingMarksVisible(editor), false)
    editor.commands.setFormattingMarksVisible(true)
    assert.equal(marks(editor).length, 0)
    editor.setEditable(true, false)
    assert.equal(marks(editor).length, 2)
  } finally { destroy(editor) }
})

test("选区或重复偏好同步复用缓存，长正文和空白串不会创建逐字符 span", () => {
  const editor = createEditor(paragraph("a".repeat(80000) + " ".repeat(40000) + "b"))
  try {
    editor.commands.setFormattingMarksVisible(true)
    const cached = state(editor)
    assert.equal(cached.decorations.find().length, 2)
    assert.equal(marks(editor).length, 2)
    editor.commands.setTextSelection(2)
    assert.equal(state(editor), cached)
    editor.commands.setFormattingMarksVisible(true)
    assert.equal(state(editor), cached)
    editor.commands.insertContent(" ")
    assert.notEqual(state(editor), cached)
    assert.equal(marks(editor, "space").length, 2)
    editor.commands.setFormattingMarksVisible(false)
    const hiddenDecorations = state(editor).decorations
    editor.commands.insertContent(" ")
    assert.equal(state(editor).decorations, hiddenDecorations)
    assert.equal(state(editor).decorations.find().length, 0)
  } finally { destroy(editor) }
})

test("普通输入/换行和撤销重建正确标记，开关不占正文撤销或重做步骤", () => {
  const editor = createEditor(paragraph("原文"))
  try {
    const original = editor.getJSON()
    editor.commands.setTextSelection(3)
    editor.commands.insertContent(" a\u00a0b\tc")
    const changed = editor.getJSON()
    const depth = undoDepth(editor.state)
    editor.commands.setFormattingMarksVisible(true)
    assert.equal(marks(editor).length, 4)
    editor.commands.setFormattingMarksVisible(false)
    editor.commands.setFormattingMarksVisible(true)
    assert.equal(undoDepth(editor.state), depth)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), original)
    assert.equal(marks(editor).length, 1)
    editor.commands.redo()
    assert.deepEqual(editor.getJSON(), changed)
    assert.equal(marks(editor).length, 4)
    editor.commands.setHardBreak()
    assert.equal(marks(editor, "hardBreak").length, 1)
    assert.equal(marks(editor, "paragraph").length, 1)
  } finally { destroy(editor) }
})

test("组合输入期间只映射旧装饰，确认后安全刷新，偏好更改也等候选结束", async () => {
  const editor = createEditor(paragraph("a b"))
  try {
    editor.commands.setFormattingMarksVisible(true)
    Object.defineProperty(editor.view, "composing", { configurable: true, value: true })
    editor.commands.insertContentAt(4, " 新 文")
    assert.equal(state(editor).pending, true)
    assert.equal(marks(editor, "space").length, 1)
    assert.equal(getFormattingMarksVisible(editor), true)
    delete editor.view.composing
    editor.view.dom.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }))
    await pause()
    assert.equal(state(editor).pending, false)
    assert.equal(marks(editor, "space").length, 3)
    Object.defineProperty(editor.view, "composing", { configurable: true, value: true })
    editor.commands.setFormattingMarksVisible(false)
    assert.equal(getFormattingMarksVisible(editor), false)
    assert.equal(marks(editor, "space").length, 3)
    delete editor.view.composing
    editor.view.dom.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }))
    await pause()
    assert.equal(marks(editor).length, 0)
    assert.equal(state(editor).pending, false)
  } finally { destroy(editor) }
})

test("标记自身不可编辑/不可朗读，实际复制序列化只含原文和原始空白", () => {
  const editor = createEditor({ type: "paragraph", content: [text("a  b\u00a0c\td"), { type: "hardBreak" }, text("tail")] })
  try {
    const before = editor.view.serializeForClipboard(new Slice(editor.state.doc.content, 0, 0))
    editor.commands.setFormattingMarksVisible(true)
    for (const mark of [...marks(editor, "paragraph"), ...marks(editor, "hardBreak")]) {
      assert.equal(mark.getAttribute("aria-hidden"), "true")
      assert.equal(mark.contentEditable, "false")
      assert.equal(mark.textContent, "")
      assert.equal(editor.view.posAtDOM(mark, 0), mark.dataset.mewocFormatMark === "paragraph" ? editor.state.doc.content.size - 1 : 9)
    }
    for (const mark of [...marks(editor, "space"), ...marks(editor, "nbsp"), ...marks(editor, "tab")]) {
      assert.equal(mark.getAttribute("aria-hidden"), null)
      assert.equal(mark.getAttribute("contenteditable"), null)
    }
    const copied = editor.view.serializeForClipboard(new Slice(editor.state.doc.content, 0, 0))
    assert.equal(copied.dom.innerHTML, before.dom.innerHTML)
    assert.equal(copied.text, before.text)
    assert.doesNotMatch(copied.dom.innerHTML, /data-mewoc-format-mark|ProseMirror-widget|¶|↵|·/)
  } finally { destroy(editor) }
})

test("Markdown、Word 与 HTML 导出不受编辑标记偏好影响，不生成标记或附加字符", async () => {
  const editor = createEditor({ type: "paragraph", content: [text("alpha beta\u00a0gamma\tdelta"), { type: "hardBreak" }, text("tail")] })
  try {
    const snapshot = { ...createDocument(), content: editor.getJSON() }
    const beforeHtml = editor.getHTML()
    const beforeMarkdown = await createDocumentMarkdown(snapshot)
    const beforeWord = await createDocumentDocx(snapshot, new Map())
    const readXml = async result => (await JSZip.loadAsync(await result.blob.arrayBuffer())).file("word/document.xml").async("string")
    const beforeXml = await readXml(beforeWord)
    editor.commands.setFormattingMarksVisible(true)
    const active = { ...snapshot, content: editor.getJSON() }
    assert.deepEqual(active, snapshot)
    assert.equal(editor.getHTML(), beforeHtml)
    assert.deepEqual(await createDocumentMarkdown(active), beforeMarkdown)
    const xml = await readXml(await createDocumentDocx(active, new Map()))
    assert.equal(xml, beforeXml)
    assert.doesNotMatch(xml + editor.getHTML() + beforeMarkdown.source, /data-mewoc-format-mark|¶|↵|·/)
    assert.match(xml, /alpha beta/)
    assert.match(xml, /gamma/)
    assert.ok(xml.includes("gamma\tdelta"))
  } finally { destroy(editor) }
})

test("销毁清理候选结束监听/定时器，新会话默认关闭，错误参数不改偏好", async () => {
  const editor = createEditor(paragraph("old text"))
  editor.commands.setFormattingMarksVisible(true)
  Object.defineProperty(editor.view, "composing", { configurable: true, value: true })
  editor.commands.insertContentAt(2, " ")
  delete editor.view.composing
  const oldDom = editor.view.dom
  let transactions = 0
  editor.on("transaction", () => { transactions += 1 })
  oldDom.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }))
  destroy(editor)
  const count = transactions
  oldDom.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }))
  await pause()
  assert.equal(transactions, count)
  assert.equal(getFormattingMarksVisible(editor), false)
  const next = createEditor(paragraph("new text"))
  try {
    assert.equal(getFormattingMarksVisible(next), false)
    assert.equal(marks(next).length, 0)
    assert.equal(next.commands.setFormattingMarksVisible("true"), false)
    assert.equal(next.commands.setFormattingMarksVisible(null), false)
    assert.equal(getFormattingMarksVisible(next), false)
    next.chain().setFormattingMarksVisible(true).setFormattingMarksVisible(false).run()
    assert.equal(getFormattingMarksVisible(next), false)
    assert.equal(marks(next).length, 0)
  } finally { destroy(next) }
})
