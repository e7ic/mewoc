/**
 * 验证批注在静态输出中转换为可读附录，并保留原始/当前引用、解决状态和孤立线程。
 * HTML、Markdown 与 Word 均使用含语法特殊字符的同一快照，检出丢失内容或意外解释用户文本。
 */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
import { JSDOM } from "jsdom"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { createDocumentMarkdown, readMarkdownDocument } from "../src/pages/editor/tools/markdown-file.js"
import {
  appendCommentText, createCommentAppendixHtml, getCommentAppendix,
  COMMENT_WORD_WARNING, COMMENT_MARKDOWN_WARNING
} from "../src/pages/editor/tools/comment-export.js"

// 使用 docx 实际依赖的 ZIP 实现读取导出包，直接核对 Word XML，而不只判断文件生成成功。
const JSZip = createRequire(createRequire(import.meta.url).resolve("docx"))("jszip")
const time = "2026-10-01T12:00:00.000Z"
const quote = "原始 <script>alert('quote')</script> & 引用"
const comment = "补充 <img src=x onerror=alert(1)> & 说明\n第二行 **不是粗体**"

// 同时构造有锚点未解决线程和无锚点已解决线程，引用故意不同于当前正文且包含 HTML/Markdown 外形文本。
function createCommentDocument() {
  const document = createDocument()
  document.content = {
    type: "doc",
    attrs: { commentThreads: [
      { id: "comment-active", text: comment, quote, createdAt: time, updatedAt: time, resolved: false },
      { id: "comment-orphan", text: "已经处理，原文字被删除", quote: "已删除的原始文字", createdAt: time, updatedAt: time, resolved: true }
    ] },
    content: [{ type: "paragraph", content: [
      { type: "text", text: "编辑后的引用 <b>文字</b>", marks: [{ type: "commentAnchor", attrs: { id: "comment-active" } }] },
      { type: "text", text: "，后续正文。" }
    ] }]
  }
  return document
}

test("批注导出：原始与当前引用、解决状态及失去引用的批注均保留", () => {
  const document = createCommentDocument()
  const before = JSON.stringify(document)
  const rows = getCommentAppendix(document)
  assert.equal(rows.length, 2)
  assert.match(rows[0].heading, /未解决/)
  assert.ok(rows[0].paragraphs.includes(`原始引用：${quote}`))
  assert.ok(rows[0].paragraphs.includes("当前引用：编辑后的引用 <b>文字</b>"))
  assert.ok(rows[0].paragraphs.includes(`批注内容：${comment}`))
  assert.match(rows[1].heading, /已解决 · 引用文字已不在正文中/)
  assert.ok(rows[1].paragraphs.includes("原始引用：已删除的原始文字"))
  assert.equal(rows[1].paragraphs.some(text => text.startsWith("当前引用：")), false)
  const text = appendCommentText(document, "最新正文")
  assert.ok(text.startsWith("最新正文\n\n批注说明\n"))
  assert.ok(text.includes(comment))
  assert.ok(text.includes(quote))
  assert.ok(text.includes("已经处理，原文字被删除"))
  assert.equal(JSON.stringify(document), before)
})

// 检查可见文字和活动节点两个维度，证明字符完整显示且未因拼接 HTML 变成标签执行。
test("批注 HTML：所有用户文字转义，附录为可阅读的语义列表", () => {
  const html = createCommentAppendixHtml(createCommentDocument())
  const dom = new JSDOM(html)
  const section = dom.window.document.querySelector('section[aria-label="批注说明"]')
  assert.ok(section)
  assert.equal(section.querySelector("h2").textContent, "批注说明")
  assert.equal(section.querySelectorAll("ol > li").length, 2)
  assert.ok(section.textContent.includes(quote))
  assert.ok(section.textContent.includes(comment))
  assert.ok(section.textContent.includes("编辑后的引用 <b>文字</b>"))
  assert.equal(section.querySelectorAll("script, img, b, [contenteditable], [onerror]").length, 0)
  assert.equal([...section.querySelectorAll("p")].find(node => node.textContent.includes("第二行")).style.whiteSpace, "pre-wrap")
})

test("没有批注的导出不生成附录，也不改变纯文本", async () => {
  const document = createDocument()
  document.content.content = [{ type: "paragraph", content: [{ type: "text", text: "原来的正文" }] }]
  assert.deepEqual(getCommentAppendix(document), [])
  assert.equal(createCommentAppendixHtml(document), "")
  assert.equal(appendCommentText(document, "原来的正文"), "原来的正文")
  const markdown = await createDocumentMarkdown(document)
  assert.doesNotMatch(markdown.source, /批注说明/)
  assert.equal(markdown.warnings.includes(COMMENT_MARKDOWN_WARNING), false)
  const word = await createDocumentDocx(document, new Map())
  assert.equal(word.warnings.includes(COMMENT_WORD_WARNING), false)
})

// 再导入生成 Markdown，验证用户星号和 HTML 外形没有变成格式/节点，比只比字符串更接近实际阅读语义。
test("批注 Markdown：导出正文与完整附录，用户 Markdown/HTML 语法仍是文字", async () => {
  const document = createCommentDocument()
  const before = JSON.stringify(document)
  const result = await createDocumentMarkdown(document)
  assert.ok(result.warnings.includes(COMMENT_MARKDOWN_WARNING))
  assert.match(result.source, /## 批注说明/)
  const imported = await readMarkdownDocument(result.source, "批注静态导出")
  assert.ok(imported.preview.includes(quote))
  assert.ok(imported.preview.includes(comment))
  assert.ok(imported.preview.includes("编辑后的引用 <b>文字</b>"))
  assert.ok(imported.preview.includes("已解决 · 引用文字已不在正文中"))
  assert.equal(imported.warnings.some(text => text.includes("HTML")), false)
  assert.equal(JSON.stringify(document), before)
})

// 通过最终 XML 的段落/文字检查确认多行及特殊字符已进入文件，且提示用户批注交互被转为文末说明。
test("批注 Word：明确转换说明，附录保留多行内容与 XML 特殊字符", async () => {
  const document = createCommentDocument()
  const before = JSON.stringify(document)
  const result = await createDocumentDocx(document, new Map())
  assert.ok(result.warnings.includes(COMMENT_WORD_WARNING))
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml").async("string")
  const dom = new JSDOM("")
  const parsed = new dom.window.DOMParser().parseFromString(xml, "application/xml")
  assert.equal(parsed.querySelector("parsererror"), null)
  const text = parsed.documentElement.textContent
  assert.ok(text.includes("批注说明"))
  assert.ok(text.includes(quote))
  assert.ok(text.includes(comment.replace("\n", "")))
  assert.ok(text.includes("原始引用：已删除的原始文字"))
  assert.ok(text.includes("已解决 · 引用文字已不在正文中"))
  assert.ok(parsed.getElementsByTagName("w:br").length > 0)
  assert.equal(parsed.getElementsByTagName("w:commentRangeStart").length, 0)
  assert.equal(parsed.getElementsByTagName("w:commentReference").length, 0)
  assert.doesNotMatch(xml, /<script>|<img /)
  assert.equal(JSON.stringify(document), before)
})
