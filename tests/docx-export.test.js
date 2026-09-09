import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import test from "node:test"
import { JSDOM } from "jsdom"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { createComplexDocxDocument, createLongDocxTable } from "./docx-fixture.js"

const JSZip = createRequire(createRequire(import.meta.url).resolve("docx"))("jszip")
const dom = new JSDOM("")
globalThis.DOMParser = dom.window.DOMParser
const fixture = JSON.parse(await readFile(new URL("./fixtures/m5-current-document.mewoc.json", import.meta.url), "utf8"))
const assets = new Map(fixture.document.assets.map(asset => [asset.id, {
  ...asset, blob: new Blob([Buffer.from(fixture.assetData[asset.id].split(",")[1], "base64")], { type: asset.mimeType })
}]))
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const source = createComplexDocxDocument(fixture.document)

async function unpack(document, entries = assets, signal) {
  const result = await createDocumentDocx(document, entries, signal)
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml").async("string")
  const parsed = new dom.window.DOMParser().parseFromString(xml, "application/xml")
  assert.equal(parsed.querySelector("parsererror"), null)
  return { ...result, zip, xml, parsed }
}

test("Word：混合内容、嵌套列表、重启编号、超链接与源码不可变", async () => {
  const before = JSON.stringify(source)
  const result = await unpack(source)
  assert.equal(JSON.stringify(source), before)
  assert.equal(result.blob.type, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  assert.match(result.xml, /w:sz w:val="28"/)
  assert.match(result.xml, /w:firstLine="480"/)
  assert.match(result.xml, /w:line="360"/)
  assert.match(result.xml, /w:fill="fff1ad"/)
  const pageHeading = [...result.parsed.getElementsByTagName("w:p")].find(node => node.textContent === "公式、图片与合并表格")
  assert.equal(pageHeading.getElementsByTagName("w:pageBreakBefore")[0].getAttribute("w:val"), null)
  assert.doesNotMatch(result.xml, /w:br w:type="page"/)
  assert.match(result.xml, /w:left[^>]+B6ABD9/)
  const numbering = await result.zip.file("word/numbering.xml").async("string")
  assert.match(numbering, /w:start w:val="3"/)
  assert.match(numbering, /w:numFmt w:val="upperLetter"/)
  assert.match(numbering, /w:ilvl="1"/)
  const paragraphs = [...result.parsed.getElementsByTagName("w:p")]
  const second = paragraphs.find(node => node.textContent.includes("同一列表项的第二段"))
  assert.equal(second.getElementsByTagName("w:numPr").length, 0)
  const relations = await result.zip.file("word/_rels/document.xml.rels").async("string")
  assert.match(relations, /Target="https:\/\/docx.js.org\/" TargetMode="External"/)
  assert.doesNotMatch(result.xml, /blob:http|contenteditable|data-resize-handle/)
})

test("Word：横纵合并续行、同列宽度、复杂单元格与末尾段落", async () => {
  const { parsed, warnings } = await unpack(source)
  const cells = [...parsed.getElementsByTagName("w:tc")]
  const start = cells.find(cell => cell.textContent.startsWith("纵向合并"))
  assert.equal(start.getElementsByTagName("w:vMerge")[0].getAttribute("w:val"), "restart")
  const continuation = cells.find(cell => cell.getElementsByTagName("w:vMerge")[0]?.getAttribute("w:val") === "continue")
  assert.ok(continuation)
  assert.equal(continuation.getElementsByTagName("w:tcW")[0].getAttribute("w:w"), start.getElementsByTagName("w:tcW")[0].getAttribute("w:w"))
  assert.equal(cells.find(cell => cell.textContent.startsWith("横向合并")).getElementsByTagName("w:gridSpan")[0].getAttribute("w:val"), "2")
  cells.forEach(cell => assert.equal(cell.lastElementChild.tagName, "w:p"))
  assert.equal(parsed.getElementsByTagName("w:tbl").length, 2)
  assert.ok(warnings.some(text => text.includes("图片已等比缩小")))
})

test("Word：常用公式保持可编辑结构，矩阵和重音不丢符号", async () => {
  const document = createDocument()
  document.content.content = ["\\frac{a_1+\\sqrt{x}}{b^2}", "\\sqrt[3]{x}", "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", "\\hat{x}+\\vec{v}", "\\sum_{i=1}^{n}i", "\\int_0^1 x^2 dx"].map(latex => ({ type: "blockMath", attrs: { latex } }))
  const { xml, parsed, warnings } = await unpack(document, new Map())
  assert.deepEqual(warnings, [])
  assert.equal(parsed.getElementsByTagName("m:oMath").length, 6)
  for (const tag of ["m:f", "m:rad", "m:sSub", "m:sSup", "m:m", "m:acc", "m:limLow", "m:limUpp"]) assert.ok(xml.includes(`<${tag}>`), tag)
  assert.equal(parsed.getElementsByTagName("m:mr").length, 2)
})

test("Word：不支持或不合法的公式整式保留源码，XML 字符安全转义", async () => {
  const document = createDocument()
  document.content.content = ["\\phantom{x}+y", "\\href{https://example.com}{x}", "<unsafe>&"].map(latex => ({ type: "blockMath", attrs: { latex } }))
  const { xml, warnings } = await unpack(document, new Map())
  assert.equal(warnings.length, 1)
  assert.match(xml, /phantom/)
  assert.doesNotMatch(xml, /<unsafe>/)
})

test("Word：语法高亮不改变空行、中文和源码字符", async () => {
  const document = createDocument()
  const code = "// 中文\nconst value = '<b>&'\n\n\tvalue++\n"
  document.content.content = [{ type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: code }] }]
  const { parsed, xml, warnings } = await unpack(document, new Map())
  let text = ""
  for (const run of parsed.getElementsByTagName("w:r")) {
    for (const child of run.children) {
      if (child.tagName === "w:br") text += "\n"
      if (child.tagName === "w:t") text += child.textContent
    }
  }
  assert.equal(text, code)
  assert.match(xml, /w:color w:val="6942A3"/)
  assert.deepEqual(warnings, [])
})

test("Word：大代码块超预算仍保留全文", async () => {
  const document = createDocument()
  const code = "x".repeat(20001)
  document.content.content = [{ type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: code }] }]
  const { parsed, warnings } = await unpack(document, new Map())
  assert.ok(parsed.documentElement.textContent.includes(code))
  assert.ok(warnings.some(text => text.includes("着色限额")))
})

test("Word：长表格重复表头并允许行跨页", async () => {
  const { parsed } = await unpack(createLongDocxTable(fixture.document), new Map())
  const rows = [...parsed.getElementsByTagName("w:tr")]
  assert.equal(rows.length, 49)
  assert.equal(rows[0].getElementsByTagName("w:tblHeader").length, 1)
  assert.equal(rows[1].getElementsByTagName("w:tblHeader")[0].getAttribute("w:val"), "false")
  assert.equal(rows[1].getElementsByTagName("w:cantSplit")[0].getAttribute("w:val"), "false")
})

test("Word：超宽表格按可用宽度收窄，横版纸张与页边距正确", async () => {
  const document = createLongDocxTable(fixture.document)
  document.page.orientation = "landscape"
  document.page.marginsMm.left = 30
  document.content.content[1].content.forEach(row => row.content.forEach(cell => { cell.attrs.colwidth = [800] }))
  const { xml, parsed, warnings } = await unpack(document, new Map())
  assert.match(xml, /w:w="16838" w:h="11906"/)
  assert.match(xml, /w:left="1701"/)
  const width = Number(parsed.getElementsByTagName("w:tblW")[0].getAttribute("w:w"))
  assert.ok(width <= (297 - 30 - document.page.marginsMm.right) * 1440 / 25.4)
  assert.ok(warnings.some(text => text.includes("表格已等比收窄")))
})

test("Word：无效表格网格明确拒绝，不自动修复后丢单元格", async () => {
  const document = createLongDocxTable(fixture.document)
  document.content.content[1].content[1].content.pop()
  await assert.rejects(() => createDocumentDocx(document, new Map()), /缺失单元格/)
})

test("Word：缺失资源、伪造 MIME 与未知 Schema 拒绝导出", async () => {
  await assert.rejects(() => createDocumentDocx(source, new Map()), /资源.*缺失/)
  const invalid = new Map(assets)
  invalid.set("m5-image", { ...assets.get("m5-image"), blob: new Blob([new Uint8Array(assets.get("m5-image").byteLength)], { type: "image/png" }) })
  await assert.rejects(() => createDocumentDocx(source, invalid), /图片内容与文件类型不一致/)
  await assert.rejects(() => createDocumentDocx({ ...source, schemaVersion: 2 }, assets), /不支持此文档版本/)
})

test("Word：分页只作用于后续列表首段，连续和末尾分页不被吞掉", async () => {
  const document = createDocument()
  document.content.content = [paragraph("第一页"), { type: "pageBreak" }, {
    type: "bulletList", content: [
      { type: "listItem", content: [paragraph("第二页首项")] },
      { type: "listItem", content: [paragraph("第二页次项")] }
    ]
  }, { type: "pageBreak" }, { type: "pageBreak" }, paragraph("连续分页之后"), { type: "pageBreak" }]
  const { parsed } = await unpack(document, new Map())
  const paragraphs = [...parsed.getElementsByTagName("w:p")]
  const startsPage = node => node.getElementsByTagName("w:pageBreakBefore")[0]?.getAttribute("w:val") !== "false" && node.getElementsByTagName("w:pageBreakBefore").length > 0
  assert.equal(paragraphs.filter(startsPage).length, 4)
  assert.ok(startsPage(paragraphs.find(node => node.textContent === "第二页首项")))
  assert.ok(!startsPage(paragraphs.find(node => node.textContent === "第二页次项")))
  assert.ok(startsPage(paragraphs.at(-1)))
})

test("Word：异步读取固定快照和资源，删除会话引用不改变导出结果", async () => {
  const document = structuredClone(source)
  const entries = new Map(assets)
  const result = unpack(document, entries)
  document.title = "后改标题"
  document.content.content = [paragraph("后改内容")]
  entries.clear()
  const exported = await result
  assert.equal(exported.title, source.title)
  assert.match(exported.xml, /Word 复杂内容转换/)
  assert.doesNotMatch(exported.xml, /后改内容/)
})

test("Word：取消发生在加载前、转换中或压缩期间时均不返回下载结果", async () => {
  const before = new AbortController()
  before.abort()
  await assert.rejects(() => createDocumentDocx(source, assets, before.signal), { name: "AbortError" })
  const during = new AbortController()
  const document = createDocument()
  document.content.content = Array.from({ length: 300 }, () => paragraph("取消验收"))
  const result = createDocumentDocx(document, new Map(), during.signal)
  setTimeout(() => during.abort(), 0)
  await assert.rejects(() => result, { name: "AbortError" })
})
