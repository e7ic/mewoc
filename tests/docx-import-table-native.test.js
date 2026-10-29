/** Word 原生回存的行级单元格边距例外可降级，未知正文不能借布局节点被吞掉。 */
import test from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"

const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
const EXCEPTION = '<w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx>'
const getText = node => node.text || (node.content || []).map(getText).join("")
const source = createDocument()
source.content = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [
  { type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "完整表格正文" }] }] }
] }] }] }
const original = new Uint8Array(await (await createDocumentDocx(source, new Map())).blob.arrayBuffer())
const fixture = async transform => {
  const zip = await JSZip.loadAsync(original)
  zip.file("word/document.xml", transform(await zip.file("word/document.xml").async("string")))
  return zip.generateAsync({ type: "uint8array" })
}

test("Word 回存的行级零边距例外不阻止导入，保留全部表格正文且明确提示布局降级", async () => {
  const bytes = await fixture(xml => xml.replace("<w:tr>", `<w:tr>${EXCEPTION}`))
  const before = bytes.slice()
  const converted = await convertDocxImport(bytes)
  const { record } = await createDocxImportRecord(converted, "Word 原生表格")
  assert.equal(getText(record.document.content), "完整表格正文")
  assert.equal(record.document.content.content[0].type, "table")
  assert.equal(record.document.content.content[0].content[0].content.length, 1)
  assert.ok(converted.warnings.some(warning => warning.includes("行级单元格边距")))
  assert.deepEqual(bytes, before)
})

test("行级布局例外中的未知内容、属性、重复节点及错误归属均拒绝，不能吞掉正文", async () => {
  for (const exception of [
    EXCEPTION.replace("<w:tblPrEx>", '<w:tblPrEx unknown="1">'),
    EXCEPTION.replace("<w:tblCellMar>", '<w:tblCellMar unknown="1">'),
    EXCEPTION.replace('w:w="0"', 'w:w="0" unknown="1"'),
    EXCEPTION.replace("</w:tblPrEx>", "<w:p><w:r><w:t>不能丢失</w:t></w:r></w:p></w:tblPrEx>"),
    EXCEPTION.replace("</w:tblPrEx>", "不能丢失</w:tblPrEx>"),
    EXCEPTION.replace("</w:tblCellMar>", '<w:top w:w="0" w:type="dxa"/></w:tblCellMar>'),
    EXCEPTION.replace("</w:tblCellMar>", '<w:bottom w:w="0" w:type="dxa"><w:t>不能丢失</w:t></w:bottom></w:tblCellMar>'),
    EXCEPTION.replace('w:w="0"', 'w:w="10"'),
    EXCEPTION + EXCEPTION
  ]) {
    const bytes = await fixture(xml => xml.replace("<w:tr>", `<w:tr>${exception}`))
    await assert.rejects(convertDocxImport(bytes), /表格行级布局|未能完整转换/)
  }
  const misplaced = await fixture(xml => xml.replace("<w:body>", `<w:body>${EXCEPTION}`))
  await assert.rejects(convertDocxImport(misplaced), /表格行级布局|未能完整转换/)
})

test("其他未知元素仍触发 Mammoth 的整份拒绝，不因表格兼容而屏蔽警告", async () => {
  const bytes = await fixture(xml => xml.replace("<w:body>", "<w:body><w:unknown>不能丢失</w:unknown>"))
  await assert.rejects(convertDocxImport(bytes), /未能完整转换/)
})
