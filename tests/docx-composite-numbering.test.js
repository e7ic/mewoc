/** 合成脱敏组合编号：锁住源计数、静态前缀、层级及未知定义的拒绝边界。 */
import test from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { readDocxParagraphs } from "../src/pages/editor/tools/docx-import-numbering.js"
import { createDocxLists } from "../src/pages/editor/tools/docx-import-lists.js"
import { readDocxXml, WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"

const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
const level = (depth, text, extra = "", start = 1, format = "decimal") => `<w:lvl w:ilvl="${depth}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/>${extra}</w:lvl>`
const instance = (id = 1, extra = "") => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/>${extra}</w:num>`
const definitions = (levels = level(0, "%1.") + level(1, "%1.%2."), instances = instance()) => `<w:abstractNum w:abstractNumId="1">${levels}</w:abstractNum>${instances}`
const paragraph = (depth, text = "正文", id = 1) => `<w:p><w:pPr>${depth === null ? "" : `<w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="${id}"/></w:numPr>`}</w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>${text}</w:t></w:r></w:p>`
const doc = body => readDocxXml(`<w:document xmlns:w="${WORD_XML}"><w:body>${body}</w:body></w:document>`, "synthetic document")
const read = (body, source = definitions()) => {
  const warnings = new Set()
  const xml = doc(body)
  const metadata = readDocxParagraphs(xml, readDocxXml(`<w:numbering xmlns:w="${WORD_XML}">${source}</w:numbering>`, "synthetic numbering"), undefined, warnings)
  const paragraphs = Array.from(xml.getElementsByTagNameNS(WORD_XML, "p"))
  const content = createDocxLists(metadata.map((value, index) => ({ metadata: value, blocks: [
    { type: "paragraph", content: [{ type: "text", text: paragraphs[index].textContent, marks: [{ type: "bold" }] }] }
  ] })), warnings)
  return { metadata, content, warnings }
}
const text = node => node.text || (node.content || []).map(text).join("")

test("父子十进制组合实例整组静态化，保留层级、正文marks及源编号标点", () => {
  const result = read([0, 1, 1, 0, 1].map(depth => paragraph(depth)).join(""))
  assert.deepEqual(result.content.map(text), ["1. 正文", "1.1. 正文", "1.2. 正文", "2. 正文", "2.1. 正文"])
  assert.ok(result.content.every(node => node.type === "paragraph"))
  assert.deepEqual(result.content.map(node => node.attrs.leftIndent), [0, 1, 1, 0, 1])
  assert.deepEqual(result.content[1].content.at(-1).marks, [{ type: "bold" }])
  assert.ok([...result.warnings].some(value => value.includes("静态编号") && value.includes("不会自动续编")))
})

test("组合编号跨普通段落和表格续编，不同num实例各自计数", () => {
  const body = paragraph(0) + paragraph(1) + paragraph(null, "中断") +
    `<w:tbl><w:tr><w:tc>${paragraph(1)}</w:tc></w:tr></w:tbl>` + paragraph(0, "独立", 2) + paragraph(1, "独立子", 2)
  assert.deepEqual(read(body, definitions(undefined, instance() + instance(2))).content.map(text),
    ["1. 正文", "1.1. 正文", "中断", "1.2. 正文", "1. 独立", "1.1. 独立子"])
})

test("startOverride覆盖lvlOverride起点和模板，重启继续使用覆盖起点且保留右括号", () => {
  const overrides = '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride>' +
    `<w:lvlOverride w:ilvl="1"><w:startOverride w:val="5"/>${level(1, "%1-%2)", "", 3)}</w:lvlOverride>`
  const result = read([0, 1, 1, 0, 1].map(depth => paragraph(depth)).join(""), definitions(undefined, instance(1, overrides)))
  assert.deepEqual(result.content.map(text), ["7. 正文", "7-5) 正文", "7-6) 正文", "8. 正文", "8-5) 正文"])
  assert.ok(![...result.warnings].some(value => value.includes("右括号已转换")))
})

test("组合lvlRestart=0永不随父项重启，显式更高祖先触发层级正确", () => {
  const never = definitions(level(0, "%1.") + level(1, "%1.%2.", '<w:lvlRestart w:val="0"/>'))
  assert.deepEqual(read([0, 1, 0, 1].map(depth => paragraph(depth)).join(""), never).content.map(text),
    ["1. 正文", "1.1. 正文", "2. 正文", "2.2. 正文"])
  const levels = level(0, "%1.") + level(1, "%1.%2.") + level(2, "%1.%2.%3.", '<w:lvlRestart w:val="1"/>')
  assert.deepEqual(read([0, 1, 2, 1, 2, 0, 1, 2].map(depth => paragraph(depth)).join(""), definitions(levels)).content.map(text),
    ["1. 正文", "1.1. 正文", "1.1.1. 正文", "1.2. 正文", "1.2.2. 正文", "2. 正文", "2.1. 正文", "2.1.1. 正文"])
})

test("组合引用缺失或重置后未再次出现的祖先时拒绝，不能沿用旧current", () => {
  const source = definitions(level(0, "%1.") + level(1, "%1.%2.") + level(2, "%1.%2.%3."))
  for (const sequence of [[1], [0, 2], [0, 1, 2, 0, 2]]) {
    assert.throws(() => read(sequence.map(depth => paragraph(depth)).join(""), source), /祖先|父级/)
  }
})

test("未使用的组合层不改变简单列表，简单右括号和字母仍走动态路径", () => {
  const result = read(paragraph(0) + paragraph(0), definitions(level(0, "%1)", "", 3, "lowerLetter") + level(1, "%1.%2.")))
  assert.equal(result.content[0].type, "orderedList")
  assert.deepEqual(result.content[0].attrs, { start: 3, type: "a" })
  assert.ok(![...result.warnings].some(value => value.includes("静态编号")))
})

test("前向占位符、未知格式、重复定义及不能确定的编号语义明确拒绝", () => {
  const badLevels = [
    level(0, "%1.") + level(1, "%1.%3."),
    level(0, "%1.") + level(1, "%0.%2."),
    level(0, "%1.") + level(1, "%1.%10."),
    level(0, "%1.") + level(1, "%1.%2.", "", 1, "ordinal"),
    level(0, "%1.", "", 1, "lowerLetter") + level(1, "%1.%2."),
    level(0, "%1.") + level(1, "%1.%2.", '<w:lvlRestart w:val="2"/>'),
    level(0, "%1.") + level(1, "%1.%2.", "<w:isLgl/>"),
    level(0, "%1.") + level(1, "%1.%2.", "<w:legacy/>"),
    level(0, "%1.") + level(1, "%1.%2.", '<w:lvlText w:val="%2."/>'),
    level(0, "%1.") + level(1, "%1.%2.") + level(1, "%1.%2."),
    level(0, "%1.") + level(1, "%1.%2.", '<w:suff w:val="unknown"/>'),
    level(0, "%1.") + level(1, "%1.%2.", "<w:rPr><w:vanish/></w:rPr>"),
    level(0, "%1.") + level(1, "%1.%2.").replace('w:ilvl="1"', 'w:ilvl="1" w:unknown="1"')
  ]
  for (const levels of badLevels) assert.throws(() => read(paragraph(0) + paragraph(1), definitions(levels)), /编号/)
  assert.throws(() => read(paragraph(0) + paragraph(1), definitions(undefined, instance() + instance())), /编号/)
  const override = `<w:lvlOverride w:ilvl="1">${level(1, "%1.%2.", '<w:lvlRestart w:val="0"/>')}</w:lvlOverride>`
  assert.throws(() => read(paragraph(0) + paragraph(1), definitions(undefined, instance(1, override))), /编号/)
})

test("静态组合支持零起点、缺省start及明确的编号后缀，文案不吞掉边界字符", () => {
  const zero = definitions(level(0, "%1.", "", 0) + level(1, "%1.%2)", '<w:suff w:val="nothing"/>', 0))
  assert.deepEqual(read(paragraph(0) + paragraph(1) + paragraph(1), zero).content.map(text),
    ["0. 正文", "0.0)正文", "0.1)正文"])
  const omitted = definitions(level(0, "%1.").replace('<w:start w:val="1"/>', "") +
    level(1, "%1.%2.", '<w:suff w:val="space"/>').replace('<w:start w:val="1"/>', ""))
  assert.deepEqual(read(paragraph(0) + paragraph(1), omitted).content.map(text), ["0. 正文", "0.0. 正文"])
})

test("生产转换及再导出回导保留静态编号一次，不变成双重自动编号", async () => {
  const source = createDocument()
  const exported = await createDocumentDocx(source, new Map())
  const zip = await JSZip.loadAsync(await exported.blob.arrayBuffer())
  zip.file("word/document.xml", `<w:document xmlns:w="${WORD_XML}"><w:body>${paragraph(0, "公开条款")}${paragraph(1, "合成子条款")}</w:body></w:document>`)
  zip.file("word/numbering.xml", `<w:numbering xmlns:w="${WORD_XML}">${definitions()}</w:numbering>`)
  const result = await createDocxImportRecord(await convertDocxImport(await zip.generateAsync({ type: "uint8array" })), "组合编号")
  assert.equal(validateDocument(result.record.document), result.record.document)
  assert.deepEqual(result.record.document.content.content.map(text), ["1. 公开条款", "1.1. 合成子条款"])
  const again = await createDocumentDocx(result.record.document, result.record.assets)
  const imported = await createDocxImportRecord(await convertDocxImport(new Uint8Array(await again.blob.arrayBuffer())), "再次导入")
  assert.deepEqual(imported.record.document.content.content.map(text), ["1. 公开条款", "1.1. 合成子条款"])
})
