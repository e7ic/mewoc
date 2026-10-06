/**
 * 验证批注与完整编辑扩展、schema、清除格式、格式刷、复制粘贴和便携文件的协作。
 * 审阅身份只随原文档保留；文字格式操作不得复制或删除线程定位，文件备份则需完整恢复。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { addDocumentComment, getCommentEntries } from "../src/pages/editor/tools/document-comments.js"
import { stripCommentAnchors, clearTextFormatting } from "../src/pages/editor/tools/comment-clipboard.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"

// 安装编辑器需要的浏览器对象和帧调度，让 Node 测试执行真实 schema/事务逻辑；JSDOM 不承担原生版式验收。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
// 使用实际完整扩展组和来源/目标两段文字，使格式操作经过与产品一致的命令链。
const makeEditor = () => new Editor({ element: document.createElement("div"), extensions: createExtensions(), content: "<p><strong>来源</strong></p><p>目标</p>" })
// 通过真实批注命令生成有效锚点/线程 JSON 后销毁编辑器，后续校验与文件往返不依赖活跃 UI。
const annotated = () => {
  const editor = makeEditor()
  editor.commands.setTextSelection({ from: 1, to: 3 })
  addDocumentComment(editor, editor.state.selection, "需要补充依据")
  const content = editor.getJSON()
  editor.destroy()
  return { ...createDocument(), content }
}

test("批注文档严格校验锚点归属，同时兼容旧文档和原文已删除的批注", () => {
  assert.doesNotThrow(() => validateDocument(createDocument()))
  const source = annotated()
  assert.doesNotThrow(() => validateDocument(source))
  const orphan = structuredClone(source)
  delete orphan.content.content[0].content[0].marks
  assert.doesNotThrow(() => validateDocument(orphan))
  const dangling = structuredClone(source)
  dangling.content.attrs.commentThreads = []
  assert.throws(() => validateDocument(dangling), /批注锚点/)
  const repeated = structuredClone(source)
  repeated.content.content[0].content[0].marks.push({ type: "commentAnchor", attrs: { id: source.content.attrs.commentThreads[0].id } })
  assert.throws(() => validateDocument(repeated), /批注锚点重复/)
  const invalid = structuredClone(source)
  invalid.content.attrs.commentThreads[0].unknown = true
  assert.throws(() => validateDocument(invalid), /批注/)
})

test("清除格式保留批注和正文，撤销恢复文字样式", () => {
  const editor = makeEditor()
  try {
    editor.commands.setTextSelection({ from: 1, to: 3 })
    const id = addDocumentComment(editor, editor.state.selection, "保留定位")
    assert.equal(clearTextFormatting(editor), true)
    assert.equal(editor.isActive("bold"), false)
    assert.equal(getCommentEntries(editor.state.doc)[0].id, id)
    assert.equal(getCommentEntries(editor.state.doc)[0].orphaned, false)
    editor.commands.undo()
    assert.equal(editor.isActive("bold"), true)
    assert.equal(getCommentEntries(editor.state.doc)[0].id, id)
  } finally { editor.destroy() }
})

// 来源与目标各有自己的批注 ID，样式迁移后分别检查，防止格式刷把定位当成可复制外观。
test("格式刷不复制源批注或移除目标批注", () => {
  const editor = makeEditor()
  try {
    editor.commands.setTextSelection({ from: 1, to: 3 })
    const sourceId = addDocumentComment(editor, editor.state.selection, "来源批注")
    editor.commands.setTextSelection({ from: 5, to: 7 })
    const targetId = addDocumentComment(editor, editor.state.selection, "目标批注")
    editor.commands.setTextSelection({ from: 1, to: 3 })
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 5, to: 7 })
    editor.commands.applyFormat()
    const entries = getCommentEntries(editor.state.doc)
    assert.equal(entries.find(entry => entry.id === sourceId).anchorText, "来源")
    assert.equal(entries.find(entry => entry.id === targetId).anchorText, "目标")
    assert.equal(editor.isActive("bold"), true)
    assert.doesNotThrow(() => validateDocument({ ...createDocument(), content: editor.getJSON() }))
  } finally { editor.destroy() }
})

test("复制和外部 HTML 粘贴保留文字格式并移除批注 ID", () => {
  const editor = makeEditor()
  try {
    editor.commands.setTextSelection({ from: 1, to: 3 })
    addDocumentComment(editor, editor.state.selection, "不复制这条批注")
    const slice = editor.state.doc.slice(1, 3)
    const stripped = stripCommentAnchors(slice)
    assert.equal(stripped.content.firstChild.text, "来源")
    assert.deepEqual(stripped.content.firstChild.marks.map(mark => mark.type.name), ["bold"])
    assert.equal(stripped.openStart, slice.openStart)
    assert.equal(stripped.openEnd, slice.openEnd)
    const html = cleanPastedHtml('<p><span data-mewoc-comment-id="foreign"><strong>外部文字</strong></span></p>')
    assert.equal(html.includes("foreign"), false)
    editor.commands.insertContentAt(7, html)
    assert.equal(getCommentEntries(editor.state.doc).length, 1)
    assert.equal(getCommentEntries(editor.state.doc)[0].anchorText, "来源")
  } finally { editor.destroy() }
})

// 导入创建新文档身份，但文档内线程 ID 和文字锚点仍共同对应，验证两种身份的职责分离。
test("Mewoc 文件往返保留批注内容、状态与锚点，新 ID 不影响定位", async () => {
  const source = annotated()
  const portable = await createPortableFile(source, new Map())
  const restored = await readPortableFile(new File([JSON.stringify(portable)], "批注.mewoc.json", { type: "application/json" }))
  assert.notEqual(restored.document.id, source.id)
  assert.deepEqual(restored.document.content, JSON.parse(JSON.stringify(source.content)))
  assert.equal(getCommentEntries(restored.document.content)[0].anchorText, "来源")
  assert.doesNotThrow(() => validateDocument(restored.document))
})
