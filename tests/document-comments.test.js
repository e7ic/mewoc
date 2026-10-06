/**
 * 验证批注元数据契约、文字定位、选区限制、事务撤销与实时引用计算。
 * 分别检查 ProseMirror 和 JSON 读取结果、孤立线程以及只读定位，避免元数据与正文 marks 脱节。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor, Node } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { TextSelection, NodeSelection } from "@tiptap/pm/state"
import { DocumentComments, CommentAnchor } from "../src/pages/editor/extensions/document-comments.js"
import {
  MAX_COMMENTS, MAX_COMMENT_LENGTH, MAX_COMMENT_QUOTE_LENGTH,
  validateCommentThreads, getCommentThreads, getCommentEntries, getCommentSelectionError,
  addDocumentComment, updateDocumentComment, setCommentResolved, removeDocumentComment, focusDocumentComment
} from "../src/pages/editor/tools/document-comments.js"

// 安装编辑器需要的浏览器对象和帧调度，让 Node 测试执行真实 schema/事务逻辑；JSDOM 不承担原生版式验收。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// 用最小行内原子节点模拟图片/公式等非文字对象，检出范围包含原子内容时被错误允许批注。
const InlineAtom = Node.create({
  name: "inlineAtom", group: "inline", inline: true, atom: true,
  parseHTML: () => [{ tag: "span[data-atom]" }], renderHTML: () => ["span", { "data-atom": "yes" }]
})
// 每个场景创建独立编辑器并在 finally 销毁，隔离正文、插件和撤销历史；扩展组合只提供该组验证所需能力。
const createEditor = (content = "<p>abcdef</p>") => new Editor({
  element: document.createElement("div"),
  extensions: [StarterKit.configure({ trailingNode: false }), TableKit, InlineAtom, DocumentComments, CommentAnchor], content
})
// 直接在当前文档创建文字选区并返回实际选区，供添加、过期选区和边界映射场景复用。
const select = (editor, from, to = from) => {
  const selection = TextSelection.create(editor.state.doc, from, to)
  editor.view.dispatch(editor.state.tr.setSelection(selection))
  return editor.state.selection
}
const add = (editor, from = 2, to = 5, text = "请补充说明") => addDocumentComment(editor, select(editor, from, to), text)
// 固定合法线程作为校验基线，每次只覆盖待测字段，让失败原因来自指定契约变化。
const thread = (overrides = {}) => ({
  id: "comment-1", text: "说明", quote: "正文", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", resolved: false, ...overrides
})

test("严格校验批注数组，兼容缺省，拒绝重复和非法字段", () => {
  assert.equal(validateCommentThreads(null), null)
  assert.equal(validateCommentThreads(undefined), undefined)
  assert.deepEqual(validateCommentThreads([]), [])
  assert.deepEqual(validateCommentThreads([thread()]), [thread()])
  const invalid = [
    {}, "bad", [null], [thread({ id: "unsafe:id" })], [thread(), thread()],
    [thread({ text: " " })], [thread({ text: "x".repeat(MAX_COMMENT_LENGTH + 1) })],
    [thread({ text: "hello\u0000" })], [thread({ quote: "x".repeat(MAX_COMMENT_QUOTE_LENGTH + 1) })],
    [thread({ createdAt: "yesterday" })], [thread({ updatedAt: "2026-99-01T00:00:00Z" })],
    [thread({ createdAt: "2026-02-30T00:00:00Z" })],
    [thread({ resolved: 1 })], [thread({ replies: [] })],
    Array.from({ length: MAX_COMMENTS + 1 }, (_, index) => thread({ id: `comment-${index}` }))
  ]
  for (const value of invalid) assert.throws(() => validateCommentThreads(value), /批注/)
})

// 同时核对线程、文字范围及更新次数，再 undo/redo 完整比对，证明批注两个存储部分是同一编辑步骤。
test("新增批注在一次文档事务中保存锚点与元数据，统一撤销和重做", () => {
  const editor = createEditor()
  let documentChanges = 0
  editor.on("transaction", ({ transaction }) => { if (transaction.docChanged) documentChanges += 1 })
  try {
    const id = add(editor, 5, 2, "  请补充说明  ")
    assert.equal(typeof id, "string")
    assert.equal(documentChanges, 1)
    const entry = getCommentEntries(editor.state.doc)[0]
    assert.equal(entry.id, id)
    assert.equal(entry.text, "请补充说明")
    assert.equal(entry.quote, "bcd")
    assert.equal(entry.anchorText, "bcd")
    assert.deepEqual(entry.ranges, [{ from: 2, to: 5 }])
    assert.equal(entry.orphaned, false)
    assert.equal(editor.state.doc.textContent, "abcdef")
    assert.equal(editor.commands.undo(), true)
    assert.deepEqual(getCommentThreads(editor.state.doc), [])
    assert.equal(editor.state.doc.firstChild.firstChild.marks.length, 0)
    assert.equal(editor.commands.redo(), true)
    assert.equal(getCommentEntries(editor.state.doc)[0].id, id)
  } finally { editor.destroy() }
})

test("新增批注与前后输入分别撤销，不吞掉相邻输入", () => {
  const editor = createEditor()
  try {
    select(editor, 1)
    editor.commands.insertContent("x")
    const id = add(editor, 3, 6)
    select(editor, 8)
    editor.commands.insertContent("y")
    editor.commands.undo()
    assert.equal(editor.state.doc.textContent, "xabcdef")
    assert.equal(getCommentThreads(editor.state.doc)[0].id, id)
    editor.commands.undo()
    assert.deepEqual(getCommentThreads(editor.state.doc), [])
    assert.equal(editor.state.doc.textContent, "xabcdef")
    editor.commands.undo()
    assert.equal(editor.state.doc.textContent, "abcdef")
  } finally { editor.destroy() }
})

// 边界与内部插入具有不同归属语义，分别检查范围与引用，避免标记自动扩展把后续无关输入包含进来。
test("文本编辑自动映射锚点，边界输入不扩入批注，内部输入仍保留锚点", () => {
  const editor = createEditor()
  try {
    add(editor, 2, 5)
    select(editor, 1)
    editor.commands.insertContent("x")
    assert.deepEqual(getCommentEntries(editor.state.doc)[0].ranges, [{ from: 3, to: 6 }])
    select(editor, 4)
    editor.commands.insertContent("内")
    assert.equal(getCommentEntries(editor.state.doc)[0].anchorText, "b内cd")
    select(editor, 3)
    editor.commands.insertContent("前")
    assert.equal(getCommentEntries(editor.state.doc)[0].anchorText, "b内cd")
    const end = getCommentEntries(editor.state.doc)[0].ranges[0].to
    select(editor, end)
    editor.commands.insertContent("后")
    assert.equal(getCommentEntries(editor.state.doc)[0].anchorText, "b内cd")
    assert.equal(getCommentEntries(editor.state.doc)[0].quote, "bcd")
  } finally { editor.destroy() }
})

test("删除全部锚点后保留批注为孤立项，撤销删除恢复定位", () => {
  const editor = createEditor()
  try {
    const id = add(editor)
    select(editor, 2, 5)
    editor.commands.deleteSelection()
    const entry = getCommentEntries(editor.state.doc)[0]
    assert.equal(entry.orphaned, true)
    assert.equal(entry.anchorText, "")
    assert.equal(entry.quote, "bcd")
    assert.equal(focusDocumentComment(editor, id), false)
    editor.commands.undo()
    assert.equal(getCommentEntries(editor.state.doc)[0].orphaned, false)
    assert.equal(focusDocumentComment(editor, id), true)
  } finally { editor.destroy() }
})

test("重叠选区拒绝，毗邻选区可建立独立批注", () => {
  const editor = createEditor()
  try {
    const first = add(editor, 2, 4)
    for (const [from, to] of [[1, 3], [2, 4], [3, 5], [1, 6]]) {
      const selection = select(editor, from, to)
      assert.match(getCommentSelectionError(editor, selection), /已有批注/)
      assert.equal(addDocumentComment(editor, selection, "重叠"), false)
    }
    const second = add(editor, 4, 6)
    assert.notEqual(second, first)
    assert.equal(getCommentThreads(editor.state.doc).length, 2)
    assert.deepEqual(getCommentEntries(editor.state.doc).map(entry => entry.ranges), [[{ from: 2, to: 4 }], [{ from: 4, to: 6 }]])
  } finally { editor.destroy() }
})

test("拒绝空选区、节点选区、旧文档选区及其他编辑器的选区", () => {
  const editor = createEditor()
  const other = createEditor()
  try {
    assert.equal(addDocumentComment(editor, select(editor, 2), "说明"), false)
    const nodeSelection = NodeSelection.create(editor.state.doc, 0)
    assert.equal(addDocumentComment(editor, nodeSelection, "说明"), false)
    const stale = select(editor, 2, 4)
    editor.commands.insertContent("变化")
    assert.equal(addDocumentComment(editor, stale, "旧选区"), false)
    assert.equal(addDocumentComment(editor, select(other, 2, 4), "其他文档"), false)
    assert.deepEqual(getCommentThreads(editor.state.doc), [])
  } finally { editor.destroy(); other.destroy() }
})

test("跨段落、标题和列表文字可批注，格式分片仍合并相邻范围", () => {
  const editor = createEditor("<h2>a<strong>bc</strong>d</h2><p>ef</p><ul><li><p>gh</p></li></ul>")
  try {
    const end = editor.state.doc.content.size - 3
    const id = add(editor, 1, end)
    const entry = getCommentEntries(editor.state.doc)[0]
    assert.equal(entry.id, id)
    assert.deepEqual(entry.ranges, [{ from: 1, to: 5 }, { from: 7, to: 9 }, { from: 13, to: 15 }])
    assert.equal(entry.anchorText, "abcd\nef\ngh")
    assert.deepEqual(getCommentEntries(editor.getJSON()), getCommentEntries(editor.state.doc))
    assert.equal(editor.state.doc.firstChild.child(1).marks.some(mark => mark.type.name === "bold"), true)
  } finally { editor.destroy() }
})

// 单元格多层容器改变文档坐标，比较 JSON 和真实节点计算结果，检出递归 token 长度偏差。
test("表格单元格的文字允许批注且 JSON 与实际位置一致", () => {
  const editor = createEditor("<table><tbody><tr><td><p>one</p></td><td><p>two</p></td></tr></tbody></table>")
  try {
    const positions = []
    editor.state.doc.descendants((node, pos) => { if (node.isText) positions.push({ from: pos, to: pos + node.nodeSize }) })
    const id = add(editor, positions[0].from, positions[1].to)
    assert.equal(typeof id, "string")
    assert.equal(getCommentEntries(editor.state.doc)[0].anchorText, "one\ntwo")
    assert.deepEqual(getCommentEntries(editor.getJSON()), getCommentEntries(editor.state.doc))
  } finally { editor.destroy() }
})

test("代码块和选区内的非文本叶节点拒绝，但选区外的原子节点不影响", () => {
  for (const content of ["<pre><code>abc</code></pre>", "<p>a<br>b</p>", "<p>a<span data-atom='yes'></span>b</p>"]) {
    const editor = createEditor(content)
    try {
      const selection = select(editor, 1, editor.state.doc.content.size - 1)
      assert.equal(addDocumentComment(editor, selection, "说明"), false)
      assert.match(getCommentSelectionError(editor, selection), /普通文字/)
    } finally { editor.destroy() }
  }
  const editor = createEditor("<p>abc<span data-atom='yes'></span>d</p>")
  try { assert.equal(typeof add(editor, 1, 4), "string") } finally { editor.destroy() }
})

test("批注编辑、解决、重新打开和删除均支持独立撤销，删除同时清理锚点", () => {
  const editor = createEditor()
  try {
    const id = add(editor)
    assert.equal(updateDocumentComment(editor, id, "  修改后的说明  "), true)
    assert.equal(getCommentThreads(editor.state.doc)[0].text, "修改后的说明")
    assert.equal(setCommentResolved(editor, id, true), true)
    assert.equal(getCommentThreads(editor.state.doc)[0].resolved, true)
    assert.equal(setCommentResolved(editor, id, false), true)
    assert.equal(removeDocumentComment(editor, id), true)
    assert.deepEqual(getCommentEntries(editor.state.doc), [])
    editor.state.doc.descendants(node => { if (node.isText) assert.equal(node.marks.some(mark => mark.type.name === "commentAnchor"), false) })
    editor.commands.undo()
    assert.equal(getCommentEntries(editor.state.doc)[0].orphaned, false)
    assert.equal(getCommentThreads(editor.state.doc)[0].resolved, false)
    editor.commands.undo()
    assert.equal(getCommentThreads(editor.state.doc)[0].resolved, true)
    editor.commands.undo()
    assert.equal(getCommentThreads(editor.state.doc)[0].resolved, false)
    editor.commands.undo()
    assert.equal(getCommentThreads(editor.state.doc)[0].text, "请补充说明")
  } finally { editor.destroy() }
})

// 无变化不能制造保存或历史；容量与非法字段测试同时保证拒绝后没有半条线程留在根属性。
test("同值修改无文档更新，校验字符串和操作目标，批注数量有上限", () => {
  const editor = createEditor()
  let updates = 0
  editor.on("update", () => { updates += 1 })
  try {
    const id = add(editor)
    const addedUpdates = updates
    assert.equal(updateDocumentComment(editor, id, "请补充说明"), true)
    assert.equal(setCommentResolved(editor, id, false), true)
    assert.equal(updates, addedUpdates)
    for (const text of [null, " ", "a".repeat(MAX_COMMENT_LENGTH + 1), "hi\u0000"]) {
      assert.equal(updateDocumentComment(editor, id, text), false)
      assert.equal(add(editor, 5, 7, text), false)
    }
    assert.equal(updateDocumentComment(editor, "missing", "说明"), false)
    assert.equal(removeDocumentComment(editor, "missing"), false)
    assert.equal(setCommentResolved(editor, id, "true"), false)
    editor.view.dispatch(editor.state.tr.setDocAttribute("commentThreads", Array.from({ length: MAX_COMMENTS }, (_, index) => thread({ id: `comment-${index}` }))))
    assert.equal(add(editor, 5, 7), false)
    assert.match(getCommentSelectionError(editor), /200 条/)
  } finally { editor.destroy() }
})

test("只读和输入法组合期间拒绝写入，定位只改选区不修改文档", () => {
  const editor = createEditor()
  let updates = 0
  editor.on("update", () => { updates += 1 })
  try {
    const id = add(editor)
    select(editor, 1)
    editor.setEditable(false)
    const before = editor.state.doc
    const beforeUpdates = updates
    assert.equal(focusDocumentComment(editor, id), true)
    assert.deepEqual({ from: editor.state.selection.from, to: editor.state.selection.to }, { from: 2, to: 5 })
    assert.equal(editor.state.doc, before)
    assert.equal(updates, beforeUpdates)
    assert.equal(add(editor, 5, 7), false)
    assert.equal(updateDocumentComment(editor, id, "不能写"), false)
    assert.equal(setCommentResolved(editor, id, true), false)
    assert.equal(removeDocumentComment(editor, id), false)
    editor.setEditable(true)
    editor.view.input.composing = true
    assert.equal(add(editor, 5, 7), false)
    assert.equal(updateDocumentComment(editor, id, "不能写"), false)
    assert.equal(setCommentResolved(editor, id, true), false)
    assert.equal(removeDocumentComment(editor, id), false)
    assert.equal(focusDocumentComment(editor, id), false)
    editor.view.input.composing = false
  } finally { editor.destroy() }
})

test("元数据和锚点可 JSON 保存重开，返回副本，HTML 不泄露批注正文也不接纳锚点", () => {
  const editor = createEditor()
  let reopened
  let htmlCopy
  try {
    const id = add(editor)
    const saved = structuredClone(editor.getJSON())
    reopened = createEditor(saved)
    assert.deepEqual(getCommentEntries(reopened.state.doc), getCommentEntries(editor.state.doc))
    const copy = getCommentThreads(editor.state.doc)
    copy[0].text = "外部修改"
    assert.equal(getCommentThreads(editor.state.doc)[0].text, "请补充说明")
    assert.equal(editor.getHTML().includes(`data-mewoc-comment-id="${id}"`), true)
    assert.equal(editor.getHTML().includes("请补充说明"), false)
    htmlCopy = createEditor(editor.getHTML())
    assert.deepEqual(getCommentThreads(htmlCopy.state.doc), [])
    htmlCopy.state.doc.descendants(node => { if (node.isText) assert.equal(node.marks.some(mark => mark.type.name === "commentAnchor"), false) })
    reopened.commands.setContent(editor.getHTML())
    assert.equal(getCommentEntries(reopened.state.doc)[0].orphaned, true)
  } finally { editor.destroy(); reopened?.destroy(); htmlCopy?.destroy() }
})

test("长选区截取引用但完整锚点保留，批注正文按纯文字保存", () => {
  const editor = createEditor(`<p>${"a".repeat(600)}</p>`)
  try {
    add(editor, 1, 601, "<script>alert(1)</script>\n正文")
    const entry = getCommentEntries(editor.state.doc)[0]
    assert.equal(entry.quote.length, MAX_COMMENT_QUOTE_LENGTH)
    assert.equal(entry.anchorText.length, 600)
    assert.equal(entry.text, "<script>alert(1)</script>\n正文")
    assert.equal(editor.getHTML().includes("<script>"), false)
  } finally { editor.destroy() }
})

test("选中文字包含非法控制字符时不生成无法持久化的批注", () => {
  const editor = createEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a\u0000bc" }] }] })
  try {
    assert.equal(add(editor, 1, 5), false)
    assert.match(getCommentSelectionError(editor), /控制字符/)
    assert.deepEqual(getCommentThreads(editor.state.doc), [])
  } finally { editor.destroy() }
})
