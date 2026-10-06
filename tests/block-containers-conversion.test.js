/** 富文本容器跨剪贴板、纯文本、Markdown 与真实 DOCX 的转换回归；核验正文和文件结构。 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocumentText } from "../src/pages/editor/tools/document-text.js"
import { createMarkdownTree } from "../src/pages/editor/tools/markdown-export.js"
import { createDocumentMarkdown, readMarkdownDocument } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { TEXT_BOX_DEFAULTS } from "../src/pages/editor/tools/block-containers.js"

const dom = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const JSZip = createRequire(createRequire(import.meta.url).resolve("docx"))("jszip")
const portable = JSON.parse(await readFile(new URL("./fixtures/m5-current-document.mewoc.json", import.meta.url), "utf8"))
const image = portable.document.assets[0]
const attachment = { id: "container-attachment", kind: "attachment", fileName: "附件.txt", mimeType: "text/plain", byteLength: 3 }
const assets = new Map([
  [image.id, { ...image, blob: new Blob([Buffer.from(portable.assetData[image.id].split(",")[1], "base64")], { type: image.mimeType }) }],
  [attachment.id, { ...attachment, blob: new Blob(["abc"], { type: attachment.mimeType }) }]
])
const text = (value, marks) => ({ type: "text", text: value, ...(marks && { marks }) })
const paragraph = (value, attrs) => ({ type: "paragraph", ...(attrs && { attrs }), content: typeof value === "string" ? value ? [text(value)] : [] : value })
const textBox = (content, attrs = TEXT_BOX_DEFAULTS) => ({ type: "textBox", attrs: { ...attrs }, content })
const details = (content, summary = "详细内容") => ({ type: "details", attrs: { summary }, content })
const table = content => ({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content }] }] })
const record = (content, resources = []) => ({ ...createDocument(), content: { type: "doc", content }, assets: resources })
const makeEditor = content => new Editor({ element: document.createElement("div"), content, extensions: createExtensions(id => assets.has(id) ? "data:image/png;base64,AA==" : "", id => assets.get(id)) })
const nodes = (editor, type) => {
  const found = []
  editor.state.doc.descendants(node => { if (node.type.name === type) found.push(node) })
  return found
}
const unpack = async source => {
  const result = await createDocumentDocx(source, assets)
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml").async("string")
  const parsed = new DOMParser().parseFromString(xml, "application/xml")
  assert.equal(parsed.querySelector("parsererror"), null)
  return { ...result, zip, xml, parsed }
}
const richBody = () => [
  paragraph([text("粗体", [{ type: "bold" }]), { type: "hardBreak" }, text("换行")]),
  { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("已完成事项")] }] },
  { type: "codeBlock", attrs: { language: "plaintext" }, content: [text("<code>&\n下一行")] },
  { type: "blockMath", attrs: { latex: "x^2" } },
  table([paragraph("内嵌表格")]),
  { type: "image", attrs: { assetId: image.id, width: 100, height: 80, align: "center", alt: "图片说明" } },
  { type: "attachment", attrs: { assetId: attachment.id } }
]

test("Markdown 展开容器但完整保留标题、富文本、任务、代码、公式和资源说明，不改原稿", async () => {
  const source = record([textBox(richBody()), details([paragraph("详情第一段"), paragraph("详情第二段")], "标题 * <>&")], [image, attachment])
  const before = structuredClone(source)
  const result = await createDocumentMarkdown(source)
  assert.match(result.source, /粗体/)
  assert.match(result.source, /已完成事项/)
  assert.match(result.source, /内嵌表格/)
  assert.match(result.source, /图片说明/)
  assert.match(result.source, /附件\.txt/)
  assert.match(result.source, /详情第一段/)
  assert.match(result.source, /详情第二段/)
  assert.ok(result.warnings.some(value => value.includes("文本框已展开")))
  assert.ok(result.warnings.some(value => value.includes("折叠详情已展开")))
  const imported = await readMarkdownDocument(result.source)
  const readable = createDocumentText(imported.record.document)
  assert.match(readable, /标题 \* <>&/)
  assert.match(readable, /\[x\] 已完成事项/)
  assert.deepEqual(source, before)
})

test("纯文本保留详情属性标题、全部分段和任务状态；默认属性与未知节点边界继续有效", () => {
  const source = record([{ type: "textBox", content: [paragraph("框第一段"), paragraph("框第二段")] },
    { type: "details", content: [paragraph("正文"), { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph("待办")] }] }] }])
  const before = structuredClone(source)
  const value = createDocumentText(source)
  assert.match(value, /框第一段\n\n框第二段/)
  assert.match(value, /详细内容\n\n正文/)
  assert.match(value, /\[ \] 待办/)
  assert.deepEqual(source, before)
  assert.throws(() => createDocumentText(record([{ type: "unknown", content: [paragraph("保留未知拒绝")] }])), /Unknown|unknown|不支持/)
  assert.throws(() => createMarkdownTree(record([details([{ type: "unknown" }])])), /不支持节点 unknown/)
})

test("真实 HTML 序列化经清理后保留容器属性及内部六级标题、表格和任务清单", () => {
  const source = makeEditor(record([textBox([
    { type: "heading", attrs: { level: 6, textAlign: "right", lineHeight: 2, firstLineIndent: 2, leftIndent: 3 }, content: [text("六级标题")] },
    table([paragraph("格内文字")]),
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("完成")] }] }
  ], { backgroundColor: "#000000", borderColor: "#123456", borderWidth: 0, padding: 0 }), details([paragraph("详情正文")], "安全 <标题> & 说明")]).content)
  let restored
  try {
    const cleaned = cleanPastedHtml(source.getHTML())
    restored = makeEditor(cleaned)
    assert.deepEqual(restored.getJSON(), source.getJSON())
    validateDocument(record(restored.getJSON().content))
  } finally { source.destroy(); restored?.destroy() }
})

test("内部容器重建白名单外观并展开详情，事件、URL、任意定位和隐藏样式不随粘贴恢复", () => {
  const html = '<div data-type="text-box" data-background-color="#ffeeaa" data-border-color="#123456" data-border-width="6" data-padding="40" onclick="unsafe()" style="position:fixed;background-image:url(https://evil.invalid);display:none;padding:999px"><p>完整正文</p></div><details data-type="details" onclick="unsafe()" style="display:none"><summary onmouseover="unsafe()"><b>详情标题</b></summary><div data-details-content="true" style="display:none"><p>隐藏正文</p></div></details>'
  const cleaned = cleanPastedHtml(html)
  assert.doesNotMatch(cleaned, /onclick|onmouseover|evil\.invalid|position:|display:|999px/)
  assert.match(cleaned, /open=""/)
  const restored = makeEditor(cleaned)
  try {
    assert.deepEqual({ ...nodes(restored, "textBox")[0].attrs }, { backgroundColor: "#ffeeaa", borderColor: "#123456", borderWidth: 6, padding: 40 })
    assert.equal(nodes(restored, "details")[0].attrs.summary, "详情标题")
    assert.match(restored.getText(), /隐藏正文/)
    validateDocument(record(restored.getJSON().content))
  } finally { restored.destroy() }
})

test("外部和畸形详情、非法文本框均展开保留所有标题和正文，不截取或静默丢弃额外内容", () => {
  const longTitle = "长".repeat(121)
  const html = `<div data-type="text-box" data-border-width="" data-padding="-1"><p>非法框正文</p></div><details><summary>外部标题</summary><p>外部正文</p></details><details data-type="details"><summary>${longTitle}</summary><div data-details-content><p>长标题正文</p></div></details><details data-type="details"><summary>重复正文标题</summary><div data-details-content><p>第一份正文</p></div><div data-details-content><p>第二份正文</p></div>额外尾文</details><details data-type="details"><div data-details-content><p>顺序正文</p></div><summary>顺序标题</summary></details>`
  const cleaned = cleanPastedHtml(html)
  assert.doesNotMatch(cleaned, /data-type="(?:text-box|details)"|<details|<summary/)
  const restored = makeEditor(cleaned)
  try {
    for (const value of ["非法框正文", "外部标题", "外部正文", longTitle, "长标题正文", "重复正文标题", "第一份正文", "第二份正文", "额外尾文", "顺序正文", "顺序标题"]) assert.ok(restored.getText().includes(value), value)
    assert.equal(nodes(restored, "details").length, 0)
    assert.equal(nodes(restored, "textBox").length, 0)
    validateDocument(record(restored.getJSON().content))
  } finally { restored.destroy() }
})

test("DOCX 文本框为保留外观的单格表格，完整富文本、内嵌表格、图片和附件说明进入最终文件", async () => {
  const source = record([textBox(richBody(), { backgroundColor: "#ffeeaa", borderColor: "#123456", borderWidth: 3, padding: 18 })], [image, attachment])
  const before = structuredClone(source)
  const result = await unpack(source)
  assert.equal(result.parsed.getElementsByTagName("w:tbl").length, 2)
  const outerCell = result.parsed.getElementsByTagName("w:tc")[0]
  const properties = outerCell.firstElementChild
  assert.equal(properties.getElementsByTagName("w:shd")[0].getAttribute("w:fill"), "FFEEAA")
  assert.equal(properties.getElementsByTagName("w:top")[0].getAttribute("w:color"), "123456")
  assert.equal(properties.getElementsByTagName("w:top")[0].getAttribute("w:sz"), "18")
  const margins = properties.getElementsByTagName("w:tcMar")[0]
  for (const side of ["top", "bottom", "left", "right"]) assert.equal(margins.getElementsByTagName(`w:${side}`)[0].getAttribute("w:w"), "270")
  assert.equal(outerCell.lastElementChild.tagName, "w:p")
  for (const value of ["粗体", "换行", "已完成事项", "<code>&", "内嵌表格", "附件.txt"]) assert.ok(result.parsed.documentElement.textContent.includes(value), value)
  assert.equal(result.parsed.getElementsByTagName("m:oMath").length, 1)
  assert.equal(result.parsed.getElementsByTagName("w:drawing").length, 1)
  assert.ok(result.warnings.some(value => value.includes("单格表格")))
  assert.ok(result.warnings.some(value => value.includes("附件保留")))
  assert.deepEqual(source, before)
})

test("DOCX 详情为独立加粗标题和完整正文，外部分页只应用一次并保留内部列表编号", async () => {
  const source = record([paragraph("第一页"), { type: "pageBreak" }, details([
    paragraph("详情正文"), { type: "orderedList", attrs: { start: 4, type: "A" }, content: [{ type: "listItem", content: [paragraph("详情条目")] }] }
  ], "详情 <标题> &"), { type: "pageBreak" }, textBox([paragraph("框正文")]), paragraph("尾段")])
  const result = await unpack(source)
  const paragraphs = [...result.parsed.getElementsByTagName("w:p")]
  const title = paragraphs.find(node => node.textContent === "详情 <标题> &")
  assert.ok(title)
  assert.ok(title.getElementsByTagName("w:b").length)
  assert.ok(title.getElementsByTagName("w:keepNext").length)
  const startsPage = node => node.getElementsByTagName("w:pageBreakBefore").length > 0 && node.getElementsByTagName("w:pageBreakBefore")[0].getAttribute("w:val") !== "false"
  assert.equal(paragraphs.filter(startsPage).length, 2)
  assert.ok(startsPage(title))
  assert.ok(!startsPage(paragraphs.find(node => node.textContent === "详情正文")))
  assert.ok(!startsPage(paragraphs.find(node => node.textContent === "框正文")))
  const numbering = await result.zip.file("word/numbering.xml").async("string")
  assert.match(numbering, /w:start w:val="4"/)
  assert.match(numbering, /w:numFmt w:val="upperLetter"/)
  assert.ok(result.warnings.some(value => value.includes("折叠详情已展开")))
})

test("DOCX 兼容容器缺省属性与零边框，嵌入狭窄表格或列表时完整保留内容并约束宽度", async () => {
  const source = record([
    { type: "textBox", content: [paragraph("缺省框")] },
    table([textBox([paragraph("狭窄框")], { backgroundColor: "#000000", borderColor: "#000000", borderWidth: 0, padding: 40 }), details([paragraph("格内详情")], "格内标题")]),
    { type: "bulletList", content: [{ type: "listItem", content: [paragraph("外层列表"), textBox([paragraph("列表框")])] }] }
  ])
  source.content.content[1].content[0].content[0].attrs = { colwidth: [45] }
  const result = await unpack(source)
  for (const value of ["缺省框", "狭窄框", "格内标题", "格内详情", "外层列表", "列表框"]) assert.ok(result.parsed.documentElement.textContent.includes(value), value)
  assert.match(result.xml, /w:fill="F5F3FF"/)
  assert.match(result.xml, /w:val="nil" w:color="000000" w:sz="0"/)
  assert.ok(result.warnings.some(value => value.includes("内边距在 Word 中已缩小")))
})
