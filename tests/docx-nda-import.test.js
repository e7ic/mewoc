/** 脱敏协议样例：空页码域与组合条款编号必须在完整生产导入链路中同时通过。 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"

const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships"
const text = value => `<w:r><w:t>${value}</w:t></w:r>`
const paragraph = (value, level) => `<w:p>${level === undefined ? "" : `<w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="2"/></w:numPr></w:pPr>`}${text(value)}</w:p>`
const emptyPageField = instruction => `<w:r><w:fldChar w:fldCharType="begin"/><w:instrText>${instruction}</w:instrText><w:fldChar w:fldCharType="separate"/><w:fldChar w:fldCharType="end"/></w:r>`
const read = async bytes => createDocxImportRecord(await convertDocxImport(new Uint8Array(bytes)), "脱敏协议回归")
const getText = node => node.text || (node.content || []).map(getText).join("")

test("协议的空页脚页码和复合条款编号共同导入，正文与静态编号再次导出仍保持", async () => {
  const source = await fs.readFile(new URL("./fixtures/docx-compatibility/tiny-picture.docx", import.meta.url))
  const zip = await JSZip.loadAsync(source)
  const body = paragraph("合成协议") + paragraph("范围", 0) + paragraph("条款甲", 1) + paragraph("条款乙", 1) +
    paragraph("补充说明") + paragraph("条款丙", 1) + paragraph("期限", 0) + paragraph("条款丁", 1) + paragraph("签署区")
  zip.file("word/document.xml", `<w:document xmlns:w="${WORD_XML}" xmlns:r="${REL}"><w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="footer"/></w:sectPr></w:body></w:document>`)
  zip.file("word/numbering.xml", `<w:numbering xmlns:w="${WORD_XML}"><w:abstractNum w:abstractNumId="6"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl></w:abstractNum><w:num w:numId="2"><w:abstractNumId w:val="6"/></w:num></w:numbering>`)
  zip.file("word/footer1.xml", `<w:ftr xmlns:w="${WORD_XML}"><w:p>${emptyPageField("PAGE")}${text(" of ")}${emptyPageField("NUMPAGES")}</w:p></w:ftr>`)
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="${PACKAGE}"><Relationship Id="numbering" Type="${REL}/numbering" Target="numbering.xml"/><Relationship Id="footer" Type="${REL}/footer" Target="footer1.xml"/></Relationships>`)
  const bytes = await zip.generateAsync({ type: "uint8array" })
  const untouched = bytes.slice()
  const result = await read(bytes)
  assert.deepEqual(bytes, untouched)
  assert.deepEqual(result.record.document.content.content.map(getText), [
    "合成协议", "1. 范围", "1.1. 条款甲", "1.2. 条款乙", "补充说明", "1.3. 条款丙", "2. 期限", "2.1. 条款丁", "签署区",
    "原文页脚（静态内容）", "[页码] of [总页数]"
  ])
  assert.ok(result.warnings.some(value => /页码/.test(value) && /未保存/.test(value)))
  assert.ok(result.warnings.some(value => /组合编号|复合编号/.test(value) && /不会自动/.test(value)))
  const exported = await createDocumentDocx(result.record.document, result.record.assets)
  const repeated = await read(await exported.blob.arrayBuffer())
  assert.deepEqual(repeated.record.document.content.content.map(getText), result.record.document.content.content.map(getText))
  assert.deepEqual(repeated.record.document.page, result.record.document.page)
})
