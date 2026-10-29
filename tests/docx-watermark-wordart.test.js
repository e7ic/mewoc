/** 原生 Word 实际可见的 WordArt 水印：回存样本与严格内容识别边界。 */
import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { extractDocxWatermark } from "../src/pages/editor/tools/docx-import-watermark.js"
import { readDocxXml, writeDocxXml, WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"

const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]

const PAGE = { size: "A5", orientation: "portrait", marginsMm: { top: 15, right: 15, bottom: 15, left: 15 } }
const fixture = async () => {
  const bytes = await readFile(new URL("../docs/m25-word-roundtrip-evidence/display-fix/watermark-probe-word-resaved.docx", import.meta.url))
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "89c1b13de58127ad6c842a58a8d63a519ca310591c6b895853ab95baf0d6d15a")
  const zip = await JSZip.loadAsync(bytes)
  const parts = new Map()
  for (const part of zip.file(/\.(xml|rels)$/)) parts.set(part.name, readDocxXml(await part.async("string"), part.name))
  return { parts, bytes, header: parts.get("word/header1.xml"), warnings: new Set() }
}
const read = value => extractDocxWatermark(value.parts, PAGE, value.warnings)

test("正式导出使用 Word 实测可见的标准 136 模板及原字号，不能退回不可见单线/自定义类型", async () => {
  const source = createDocument()
  source.page = { ...structuredClone(PAGE), watermark: { text: "M25 原生验收", color: "#6554C0", opacity: 0.12, angle: -35 } }
  const output = await createDocumentDocx(source, new Map())
  const zip = await JSZip.loadAsync(await output.blob.arrayBuffer())
  const header = readDocxXml(await zip.file("word/header1.xml").async("string"), "export header")
  const type = header.getElementsByTagName("v:shapetype")[0]
  assert.equal(type.getAttribute("id"), "_x0000_t136")
  assert.equal(type.getAttribute("path"), "m@7,l@8,m@5,21600l@6,21600e")
  assert.equal(type.getAttribute("adj"), "10800")
  assert.deepEqual(Array.from(type.getElementsByTagName("v:f")).map(node => node.getAttribute("eqn")), [
    "sum #0 0 10800", "prod #0 2 1", "sum 21600 0 @1", "sum 0 0 @2", "sum 21600 0 @3",
    "if @0 @3 0", "if @0 21600 @1", "if @0 0 @2", "if @0 @4 21600", "mid @5 @6",
    "mid @8 @5", "mid @7 @8", "mid @6 @7", "sum @6 0 @5"
  ])
  const shape = header.getElementsByTagName("v:shape")[0]
  assert.equal(shape.getAttribute("type"), "#_x0000_t136")
  assert.match(shape.getAttribute("id"), /^MewocWatermarkShape_[a-f\d]{32}$/)
  assert.equal(shape.getElementsByTagName("v:textpath")[0].getAttribute("fitshape"), "f")
  assert.equal(header.getElementsByTagName("w:t").length, 0)
})

test("Word 原生可见 WordArt 回存恢复文字、颜色、旋转和固定点透明度，正文及压缩字节不变", async () => {
  const value = await fixture()
  const bytes = value.bytes.slice()
  const body = writeDocxXml(value.parts.get("word/document.xml"))
  assert.deepEqual(read(value), { text: "M25 原生验收", color: "#6554c0", opacity: 7864 / 65536, angle: -35 })
  assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "pict").length, 0)
  assert.equal(writeDocxXml(value.parts.get("word/document.xml")), body)
  assert.deepEqual(value.bytes, bytes)
  assert.equal(value.warnings.size, 0)
})

test("原生可见样本走正式转换、会话组装及再导出导入，不产生静态页眉或水印正文", async () => {
  const value = await fixture()
  const result = await createDocxImportRecord(await convertDocxImport(new Uint8Array(value.bytes)), "水印原生回存")
  const text = node => node.text || (node.content || []).map(text).join("")
  assert.equal(text(result.record.document.content), "M25 watermark diagnostic. Body starts here.Only one header variable changes in each candidate. 水印原生显示验收。")
  assert.equal(result.record.document.page.watermark.text, "M25 原生验收")
  assert.ok(!result.warnings.some(warning => /静态页眉|水印.*不支持/.test(warning)))
  const output = await createDocumentDocx(result.record.document, result.record.assets)
  const again = await createDocxImportRecord(await convertDocxImport(new Uint8Array(await output.blob.arrayBuffer())), "再次导回")
  assert.deepEqual(again.record.document.content, result.record.document.content)
  assert.deepEqual(again.record.document.page.watermark, result.record.document.page.watermark)
})

test("标准类型 ID 的重复定义只有完全一致才安全，重复形状或未知同名类型不被移除", async () => {
  for (const mode of ["different-type", "duplicate-shape"]) {
    const value = await fixture()
    const picture = value.header.getElementsByTagNameNS(WORD_XML, "pict")[0]
    const copy = picture.cloneNode(true)
    if (mode === "different-type") {
      copy.getElementsByTagName("v:shape")[0].setAttribute("id", "MewocWatermarkShape_11111111111111111111111111111111")
      copy.getElementsByTagName("v:f")[0].setAttribute("eqn", "sum #0 0 10801")
    }
    picture.parentNode.appendChild(copy)
    const before = writeDocxXml(value.header)
    assert.equal(read(value), undefined)
    assert.equal(writeDocxXml(value.header), before)
  }
})

test("原生 WordArt 只有完整已确认模板和本项目形状可恢复，任意公式、额外内容及活动引用均拒绝", async () => {
  for (const transform of [
    xml => xml.replace("sum #0 0 10800", "sum #0 0 10801"),
    xml => xml.replace("xrange=\"6629,14971\"", "xrange=\"0,21600\""),
    xml => xml.replace("o:connectangles=\"270,180,90,0\"", "o:connectangles=\"0,0,0,0\""),
    xml => xml.replace("shapetype=\"t\"", "shapetype=\"f\""),
    xml => xml.replace("MewocWatermarkShape_", "OtherWatermarkShape_"),
    xml => xml.replace("type=\"#_x0000_t136\"", "type=\"#missing\""),
    xml => xml.replace("<v:shape id=", "<v:shape href=\"https://example.invalid/\" id="),
    xml => xml.replace("width:361.5pt", "width:500pt"),
    xml => xml.replace("font-family:&quot;Arial&quot;", "font-family:&quot;OtherFont&quot;"),
    xml => xml.replace("opacity=\"7864f\"", "opacity=\"7864f other\""),
    xml => xml.replace("</w:pict>", "不能丢失</w:pict>"),
    xml => xml.replace("</v:shape>", "<v:textbox><w:txbxContent><w:p><w:r><w:t>不能丢失</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape>")
  ]) {
    const value = await fixture()
    value.header = readDocxXml(transform(writeDocxXml(value.header)), "wordart mutation")
    value.parts.set("word/header1.xml", value.header)
    const before = writeDocxXml(value.header)
    assert.equal(read(value), undefined)
    assert.equal(writeDocxXml(value.header), before)
  }
})
