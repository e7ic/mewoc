/**
 * M22 以正式导出生成的 DOCX 包做页面往返，验证元数据与正文的所有权分离。
 * Node 在 JSDOM 中执行主线程记录组装；真实 Worker 与浏览器 UI 另由页面专项验证。
 */
import test from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { PAGE_SIZES } from "../src/pages/editor/tools/page-settings.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"

const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const fixture = (size = "A5", orientation = "landscape") => ({ ...createDocument(), title: "M22 页面往返",
  page: { size, orientation, marginsMm: { top: 12.345, right: 17.125, bottom: 19.675, left: 23.875 } },
  content: { type: "doc", content: [paragraph("正文与水印分别保留。"), paragraph("第二段有完整文字。") ] } })
const watermark = { text: "M22 验收 <&> \"内容\"", color: "#AB12EF", opacity: 0.27, angle: -35 }
const getText = node => node.text || (node.content || []).map(getText).join("")
const exportBytes = async document => new Uint8Array(await (await createDocumentDocx(document, new Map())).blob.arrayBuffer())
const importBytes = async bytes => createDocxImportRecord(await convertDocxImport(bytes), "页面导入")
// OOXML 用整数 twips，边距可发生不超过半 twip 的毫米量化；纸型和方向必须精确恢复。
const assertPage = (actual, expected) => {
  assert.equal(actual.size, expected.size)
  assert.equal(actual.orientation, expected.orientation)
  for (const side of ["top", "right", "bottom", "left"]) assert.ok(Math.abs(actual.marginsMm[side] - expected.marginsMm[side]) <= 0.02, `${side}: ${actual.marginsMm[side]} / ${expected.marginsMm[side]}`)
  assert.deepEqual(actual.watermark, expected.watermark)
}
// 只覆写内存归档的页眉，不改变源 Blob；不使用外部文件、Office 或被测解析器构造预期结果。
const changeHeader = async (bytes, change) => {
  const zip = await JSZip.loadAsync(bytes)
  const header = zip.file(/^word\/header\d+\.xml$/)[0]
  assert.ok(header, "正式水印导出应带原生页眉")
  zip.file(header.name, change(await header.async("string")))
  return zip.generateAsync({ type: "uint8array" })
}

test("正式 DOCX 往返保留四种纸型、横竖方向与非对称边距，源文档及压缩字节不变", async () => {
  for (const size of Object.keys(PAGE_SIZES)) for (const orientation of ["portrait", "landscape"]) {
    const source = fixture(size, orientation)
    const before = structuredClone(source)
    const bytes = await exportBytes(source)
    const bytesBefore = bytes.slice()
    const { record, preview, warnings } = await importBytes(bytes)
    assertPage(record.document.page, source.page)
    assert.equal(validateDocument(record.document), record.document)
    assert.equal(record.assets.size, 0)
    assert.match(preview, /正文与水印分别保留/)
    assert.equal(getText(record.document.content), getText(source.content))
    assert.ok(!warnings.some(message => message.includes("纸张布局使用编辑器默认值")))
    assert.deepEqual(source, before)
    assert.deepEqual(bytes, bytesBefore)
  }
})

test("本项目原生页眉水印保持转义文字、颜色、透明度和旋转，正文与预览均不混入装饰", async () => {
  const source = fixture("Letter", "landscape")
  source.page.watermark = { ...watermark }
  const { record, preview, warnings } = await importBytes(await exportBytes(source))
  assertPage(record.document.page, source.page)
  assert.ok(!preview.includes(watermark.text) && !getText(record.document.content).includes(watermark.text))
  assert.ok(!preview.includes("原文页眉（静态内容）"), "纯水印不应制造静态页眉正文")
  assert.ok(!warnings.some(message => message.includes("Word 导入暂不支持这种水印")))
})

test("80 个 emoji 在正负 90 度水印中完整往返，Unicode 码点不按 UTF-16 半段截断", async () => {
  for (const angle of [-90, 90]) {
    const source = fixture()
    source.page.watermark = { ...watermark, text: "😀".repeat(80), angle }
    const { record } = await importBytes(await exportBytes(source))
    assertPage(record.document.page, source.page)
    assert.equal([...record.document.page.watermark.text].length, 80)
    assert.equal(record.document.page.watermark.text.length, 160)
    assert.ok(!getText(record.document.content).includes("😀"))
  }
})

test("连续三轮 DOCX 导出导入保持量化边距与水印，不积累静态页眉或正文副本", async () => {
  const source = fixture("A3", "portrait")
  source.page.watermark = { ...watermark }
  let document = source
  let quantizedPage
  for (let index = 0; index < 3; index += 1) {
    const { record, preview } = await importBytes(await exportBytes(document))
    if (!quantizedPage) quantizedPage = structuredClone(record.document.page)
    else assert.deepEqual(record.document.page, quantizedPage)
    assertPage(record.document.page, source.page)
    assert.equal(getText(record.document.content), getText(source.content))
    assert.equal(record.document.content.content.filter(node => node.type === "paragraph").length, 2)
    assert.ok(!preview.includes("原文页眉（静态内容）"))
    document = record.document
  }
})

test("普通页眉仍按静态内容附加一次，与纸张恢复及不带水印的导入兼容", async () => {
  const source = fixture("A4", "portrait")
  source.page.watermark = { ...watermark }
  const bytes = await changeHeader(await exportBytes(source), xml => xml.replace(/<w:hdr([^>]*)>[\s\S]*<\/w:hdr>/, "<w:hdr$1><w:p><w:r><w:t>普通页眉保留</w:t></w:r></w:p></w:hdr>"))
  const { record, preview, warnings } = await importBytes(bytes)
  const expected = structuredClone(source.page)
  delete expected.watermark
  assertPage(record.document.page, expected)
  assert.equal(preview.split("普通页眉保留").length - 1, 1)
  assert.match(preview, /原文页眉（静态内容）/)
  assert.ok(warnings.some(message => message.includes("各保留一次")))
})

test("水印与普通文字同处一个页眉时只提取水印，普通内容仍附加且不会重复", async () => {
  const source = fixture()
  source.page.watermark = { ...watermark }
  const bytes = await changeHeader(await exportBytes(source), xml => xml.replace("</w:hdr>", "<w:p><w:r><w:t>混合页眉文字保留</w:t></w:r></w:p></w:hdr>"))
  const { record, preview } = await importBytes(bytes)
  assertPage(record.document.page, source.page)
  assert.equal(preview.split("混合页眉文字保留").length - 1, 1)
  assert.match(preview, /原文页眉（静态内容）/)
  assert.ok(!preview.includes(watermark.text))
})

test("可识别水印不放宽未知旧式绘图守卫，混入未支持 VML 的整个文件仍拒绝", async () => {
  const source = fixture()
  source.page.watermark = { ...watermark }
  const bytes = await changeHeader(await exportBytes(source), xml => xml.replace("</w:hdr>", "<w:p><w:r><w:pict><v:rect style=\"width:100pt;height:20pt\"/></w:pict></w:r></w:p></w:hdr>"))
  await assert.rejects(importBytes(bytes), /旧式|图形|水印/)
  // 拒绝不影响独立的后续好文件，转换器不缓存上一轮的水印或错误。
  assertPage((await importBytes(await exportBytes(source))).record.document.page, source.page)
})

test("导入记录和 Mewoc 文件保有独立的页面快照，后续转换数据修改不串入已完成记录", async () => {
  const source = fixture()
  source.page.watermark = { ...watermark }
  const converted = await convertDocxImport(await exportBytes(source))
  const { record } = await createDocxImportRecord(converted, "独立页面快照")
  const page = structuredClone(record.document.page)
  converted.page.marginsMm.left = 1
  converted.page.watermark.text = "后续改动"
  assert.deepEqual(record.document.page, page)
  const portable = await createPortableFile(record.document, record.assets)
  const reopened = await readPortableFile(new File([JSON.stringify(portable)], "页面.mewoc.json"))
  assert.notEqual(reopened.document.id, record.document.id)
  assert.deepEqual(reopened.document.page, page)
  assert.equal(getText(reopened.document.content), getText(record.document.content))
})

test("页面修订快照引用的旧水印不附加进正文，正式导入只恢复当前有效节", async () => {
  const source = fixture()
  source.page.watermark = { ...watermark, text: "当前水印" }
  const zip = await JSZip.loadAsync(await exportBytes(source))
  const previous = structuredClone(source)
  previous.page.watermark.text = "历史水印"
  const oldZip = await JSZip.loadAsync(await exportBytes(previous))
  // sectPrChange 保存旧节属性，属于修订历史，不能按实际有效节页眉追加到当前正文。
  // 两个页眉都来自正式导出，避免把不支持的旧 VML 本身误当作被测导入缺陷。
  zip.file("word/header2.xml", await oldZip.file("word/header1.xml").async("string"))
  const relation = "<Relationship Id=\"previousHeader\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/header\" Target=\"header2.xml\"/>"
  zip.file("word/_rels/document.xml.rels", (await zip.file("word/_rels/document.xml.rels").async("string")).replace("</Relationships>", `${relation}</Relationships>`))
  zip.file("[Content_Types].xml", (await zip.file("[Content_Types].xml").async("string")).replace("</Types>", "<Override PartName=\"/word/header2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml\"/></Types>"))
  const history = "<w:sectPrChange w:id=\"1\" w:author=\"M22\" w:date=\"2026-10-06T00:00:00Z\"><w:sectPr><w:headerReference w:type=\"default\" r:id=\"previousHeader\"/></w:sectPr></w:sectPrChange>"
  zip.file("word/document.xml", (await zip.file("word/document.xml").async("string")).replace("</w:sectPr>", `${history}</w:sectPr>`))
  const { record, preview } = await importBytes(await zip.generateAsync({ type: "uint8array" }))
  assertPage(record.document.page, source.page)
  assert.equal(getText(record.document.content), getText(source.content))
  assert.ok(!preview.includes("当前水印") && !preview.includes("历史水印"))
})
