/** 待办与上下标的真实文件链路回归：验证语义往返、明确降级和原快照不可变。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import JSZip from "jszip"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentMarkdown, readMarkdownDocument } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { createDocumentText } from "../src/pages/editor/tools/document-text.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
const text = (value, marks = []) => ({ type: "text", text: value, ...(marks.length && { marks }) })
const paragraph = (value, marks) => ({ type: "paragraph", content: value ? [text(value, marks)] : [] })
const task = (value, checked, rest = []) => ({ type: "taskItem", attrs: { checked }, content: [paragraph(value), ...rest] })
const tasks = content => ({ type: "taskList", content })
const ordinary = value => ({ type: "listItem", content: [paragraph(value)] })
const makeDocument = content => ({ ...createDocument(), content: { type: "doc", content } })
const find = (node, type) => [...(node.type === type ? [node] : []), ...(node.content || []).flatMap(child => find(child, type))]
const allText = node => node.text || (node.content || []).map(allText).join("")
const status = node => find(node, "taskItem").map(item => item.attrs.checked)

async function unpack(source) {
  const result = await createDocumentDocx(source, new Map())
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml").async("string")
  return { ...result, zip, xml, parsed: new DOMParser().parseFromString(xml, "application/xml") }
}

test("Markdown 混合普通/任务项按原顺序拆分，嵌套勾选状态经导出再次导入仍保留", async () => {
  const input = "- 普通甲\n- [ ] 待办甲\n  - [x] 子任务\n  - 子说明\n- 普通乙\n- [x] 待办乙\n"
  const imported = await readMarkdownDocument(input)
  const content = imported.record.document.content
  assert.deepEqual(content.content.map(node => node.type), ["bulletList", "taskList", "bulletList", "taskList"])
  assert.deepEqual(status(content), [false, true, true])
  assert.equal(allText(content), "普通甲待办甲子任务子说明普通乙待办乙")
  assert.deepEqual(imported.warnings, [])
  assert.equal(validateDocument(imported.record.document), imported.record.document)
  const exported = await createDocumentMarkdown(imported.record.document)
  const restored = await readMarkdownDocument(exported.source)
  assert.deepEqual(status(restored.record.document.content), status(content))
  assert.equal(allText(restored.record.document.content), allText(content))
  assert.deepEqual(restored.record.document.content.content.map(node => node.type), content.content.map(node => node.type))
})

test("Markdown 带编号的混合任务列表保留普通项的续编号，任务编号降级明确说明", async () => {
  const { record, warnings } = await readMarkdownDocument("3. 普通三\n4. [ ] 待办四\n5. 普通五\n6. [x] 待办六\n")
  assert.deepEqual(record.document.content.content.map(node => node.type), ["orderedList", "taskList", "orderedList", "taskList"])
  assert.deepEqual(find(record.document.content, "orderedList").map(node => node.attrs.start), [3, 5])
  assert.deepEqual(status(record.document.content), [false, true])
  assert.equal(allText(record.document.content), "普通三待办四普通五待办六")
  assert.equal(warnings.filter(value => value.includes("带编号的任务项")).length, 1)
})

test("Markdown 待办多段、空项、普通子列表和字面复选框文字均不丢失或误解析", async () => {
  const source = makeDocument([tasks([
    task("[x] 用户原文", false, [paragraph("补充段落"), { type: "orderedList", attrs: { start: 4 }, content: [ordinary("子编号")] }]),
    task("", true),
    task("父任务", true, [tasks([task("子任务", false)])])
  ])])
  const before = structuredClone(source)
  const exported = await createDocumentMarkdown(source)
  assert.match(exported.source, /\[ \]/)
  assert.match(exported.source, /\[x\]/)
  const { record, warnings } = await readMarkdownDocument(exported.source)
  assert.deepEqual(status(record.document.content), [false, true, true, false])
  assert.equal(allText(record.document.content), "[x] 用户原文补充段落子编号（空待办）父任务子任务")
  assert.ok(exported.warnings.some(value => value.includes("（空待办）")))
  assert.equal(find(record.document.content, "orderedList")[0].attrs.start, 4)
  assert.deepEqual(warnings, [])
  assert.deepEqual(source, before)
})

test("Markdown 上下标只降级格式且保留兼容 marks，HTML 标签仍按源码保留", async () => {
  const source = makeDocument([{ type: "paragraph", content: [
    text("x"), text("2", [{ type: "superscript" }, { type: "bold" }]),
    text(" H"), text("2", [{ type: "subscript" }]), text("O")
  ] }])
  const exported = await createDocumentMarkdown(source)
  assert.equal(exported.warnings.filter(value => value.includes("上下标")).length, 1)
  assert.doesNotMatch(exported.source, /<sup|<sub/)
  const restored = await readMarkdownDocument(exported.source)
  assert.equal(allText(restored.record.document.content), "x2 H2O")
  assert.ok(find(restored.record.document.content, "text").some(node => node.text === "2" && node.marks?.some(mark => mark.type === "bold")))
  const html = await readMarkdownDocument("x<sup>2</sup> H<sub>2</sub>O")
  assert.equal(allText(html.record.document.content), "x<sup>2</sup> H<sub>2</sub>O")
  assert.ok(html.warnings.some(value => value.includes("HTML 源码")))
  assert.equal(find(html.record.document.content, "text").flatMap(node => node.marks || []).length, 0)
})

test("DOCX 用原生 vertAlign 输出文字上下标，正式导入保留粗体和超链接组合", async () => {
  const source = makeDocument([{ type: "paragraph", content: [
    text("x"), text("上标", [{ type: "superscript" }, { type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }]),
    text("H"), text("下标", [{ type: "subscript" }, { type: "italic" }]), text("O")
  ] }])
  const before = structuredClone(source)
  const result = await unpack(source)
  const alignments = [...result.parsed.getElementsByTagName("w:vertAlign")].map(node => node.getAttribute("w:val"))
  assert.deepEqual(alignments, ["superscript", "subscript"])
  assert.deepEqual(result.warnings, [])
  const converted = await convertDocxImport(new Uint8Array(await result.blob.arrayBuffer()))
  const imported = await createDocxImportRecord(converted, "上下标")
  const nodes = find(imported.record.document.content, "text")
  assert.deepEqual(nodes.find(node => node.text === "上标").marks.map(mark => mark.type).sort(), ["bold", "link", "superscript", "underline"])
  assert.deepEqual(nodes.find(node => node.text === "下标").marks.map(mark => mark.type).sort(), ["italic", "subscript"])
  assert.equal(allText(imported.record.document.content), allText(source.content))
  assert.equal(imported.warnings.some(value => value.includes("上下标按普通")), false)
  assert.deepEqual(source, before)
})

test("DOCX 待办状态输出为可读静态标记，嵌套内容、续段和首项分页完整保留", async () => {
  const source = makeDocument([{ type: "pageBreak" }, tasks([
    task("已办", true, [paragraph("后续说明"), tasks([task("嵌套待办", false)])]),
    task("未办", false, [{ type: "orderedList", attrs: { start: 5 }, content: [ordinary("编号子项")] }])
  ])])
  const before = structuredClone(source)
  const result = await unpack(source)
  const paragraphs = [...result.parsed.getElementsByTagName("w:p")]
  assert.deepEqual(paragraphs.map(node => node.textContent), ["[x] 已办", "后续说明", "[ ] 嵌套待办", "[ ] 未办", "编号子项"])
  assert.equal(result.parsed.getElementsByTagName("w:pageBreakBefore").length, 1)
  assert.equal(result.parsed.getElementsByTagName("w:sdt").length, 0)
  assert.equal(result.warnings.filter(value => value.includes("交互式复选框")).length, 1)
  assert.match(await result.zip.file("word/numbering.xml").async("string"), /w:start w:val="5"/)
  const imported = await createDocxImportRecord(await convertDocxImport(new Uint8Array(await result.blob.arrayBuffer())), "静态待办")
  assert.match(allText(imported.record.document.content), /\[x\] 已办后续说明\[ \] 嵌套待办\[ \] 未办编号子项/)
  assert.deepEqual(source, before)
})

test("纯文本在副本中保留待办状态，公式、附件、硬换行与正文顺序沿用原规则", () => {
  const source = makeDocument([tasks([
    task("父项", true, [paragraph("补充"), tasks([task("子项", false)])]), task("", false)
  ]), { type: "paragraph", content: [text("公式 "), { type: "inlineMath", attrs: { latex: "x^2" } }, { type: "hardBreak" }, text("H"), text("2", [{ type: "subscript" }]), text("O")] },
  { type: "attachment", attrs: { assetId: "attachment-1" } }])
  source.assets = [{ id: "attachment-1", kind: "attachment", fileName: "说明.txt", mimeType: "text/plain", byteLength: 12 }]
  const before = structuredClone(source)
  const output = createDocumentText(source)
  assert.match(output, /\[x\] 父项[\s\S]*补充[\s\S]*\[ \] 子项[\s\S]*\[ \] /)
  assert.match(output, /公式 \$x\^2\$\nH2O/)
  assert.match(output, /\[附件：说明.txt（12 B）\]/)
  assert.deepEqual(source, before)
})
