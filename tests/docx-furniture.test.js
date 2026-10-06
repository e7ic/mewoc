/** M23 正式 DOCX 页眉页脚往返：检查真实包关系、原生字段、装饰与正文的所有权及拒绝边界。 */
import test from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { convertDocxImport as convertRawDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { readDocxXml, writeDocxXml, getWordChild, WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"
import { getDocxFurnitureDistances } from "../src/pages/editor/tools/docx-page-furniture.js"

const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
const REL_XML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const PACKAGE_XML = "http://schemas.openxmlformats.org/package/2006/relationships"
const HEADER = { text: "M23 页眉 <&> 😀", alignment: "left", pageNumber: "page" }
const FOOTER = { text: "M23 页脚", alignment: "right", pageNumber: "page-total" }
const WATERMARK = { text: "M23 内部资料", color: "#6554C0", opacity: 0.18, angle: -35 }
const getText = node => node.text || (node.content || []).map(getText).join("")
const fixture = (page = {}) => ({ ...createDocument(), title: "M23 页眉页脚往返", page: {
  size: "A4", orientation: "portrait", marginsMm: { top: 20, right: 20, bottom: 20, left: 20 }, header: { ...HEADER }, footer: { ...FOOTER }, ...page
}, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "完整正文，与页眉页脚无关。" }] }] } })
const exportBytes = async source => new Uint8Array(await (await createDocumentDocx(source, new Map())).blob.arrayBuffer())
const convertDocxImport = async bytes => {
  const converted = await convertRawDocxImport(bytes)
  const { record } = await createDocxImportRecord(converted, "M23 页面导入")
  return { ...converted, content: record.document.content }
}
const changePart = async (bytes, name, transform) => {
  const zip = await JSZip.loadAsync(bytes)
  zip.file(name, transform(await zip.file(name).async("string")))
  return zip.generateAsync({ type: "uint8array" })
}
const transformParts = async (bytes, transform) => {
  const zip = await JSZip.loadAsync(bytes)
  const parts = new Map()
  for (const part of zip.file(/\.(xml|rels)$/)) parts.set(part.name, readDocxXml(await part.async("string"), part.name))
  transform(parts)
  for (const part of zip.file(/\.(xml|rels)$/)) if (!parts.has(part.name)) zip.remove(part.name)
  for (const [name, xml] of parts) zip.file(name, writeDocxXml(xml))
  return zip.generateAsync({ type: "uint8array" })
}
const body = parts => getWordChild(parts.get("word/document.xml").documentElement, "body")
const section = parts => getWordChild(body(parts), "sectPr")
const references = (parts, kind, parent = section(parts)) => Array.from(parent.getElementsByTagNameNS(WORD_XML, `${kind}Reference`))
const relationFor = (parts, reference) => Array.from(parts.get("word/_rels/document.xml.rels").getElementsByTagNameNS(PACKAGE_XML, "Relationship"))
  .find(node => node.getAttribute("Id") === reference.getAttributeNS(REL_XML, "id"))
const addPart = (parts, kind, path, xml, id) => {
  parts.set(path, xml)
  const relations = parts.get("word/_rels/document.xml.rels")
  const node = relations.createElementNS(PACKAGE_XML, "Relationship")
  node.setAttribute("Id", id); node.setAttribute("Type", `${REL_XML}/${kind}`); node.setAttribute("Target", path.replace(/^word\//, ""))
  relations.documentElement.appendChild(node)
}
const addReference = (parts, kind, type, id, parent = section(parts)) => {
  const node = parent.ownerDocument.createElementNS(WORD_XML, `w:${kind}Reference`)
  node.setAttributeNS(WORD_XML, "w:type", type); node.setAttributeNS(REL_XML, "r:id", id)
  parent.appendChild(node)
  return node
}
const firstSection = parts => {
  const first = section(parts).cloneNode(true)
  const paragraph = first.ownerDocument.createElementNS(WORD_XML, "w:p")
  const properties = first.ownerDocument.createElementNS(WORD_XML, "w:pPr")
  properties.appendChild(first); paragraph.appendChild(properties); body(parts).insertBefore(paragraph, body(parts).firstChild)
  return first
}

test("正式 DOCX 同时恢复页眉、页脚、动态页码与 M22 水印，正文和原字节不污染", async () => {
  const source = fixture({ watermark: { ...WATERMARK } })
  const before = structuredClone(source)
  const bytes = await exportBytes(source)
  const bytesBefore = bytes.slice()
  const zip = await JSZip.loadAsync(bytes)
  const header = await zip.file("word/header1.xml").async("string")
  assert.ok(header.includes("MewocWatermarkShape_") && header.includes("MewocPageHeader_v1"))
  const main = readDocxXml(await zip.file("word/document.xml").async("string"), "document")
  assert.equal(main.getElementsByTagNameNS(WORD_XML, "headerReference").length, 1)
  assert.equal(main.getElementsByTagNameNS(WORD_XML, "footerReference").length, 1)
  const settings = readDocxXml(await zip.file("word/settings.xml").async("string"), "settings")
  const updateFields = getWordChild(settings.documentElement, "updateFields")
  assert.ok(updateFields && (!updateFields.hasAttributeNS(WORD_XML, "val") || ["true", "1", "on"].includes(updateFields.getAttributeNS(WORD_XML, "val"))))
  const converted = await convertDocxImport(bytes)
  assert.deepEqual(converted.page.header, HEADER)
  assert.deepEqual(converted.page.footer, FOOTER)
  assert.deepEqual(converted.page.watermark, WATERMARK)
  assert.equal(getText(converted.content), getText(source.content))
  assert.ok(!converted.warnings.some(warning => warning.includes("页码为原文件保存值") || warning.includes("目录、页码")))
  assert.deepEqual(source, before); assert.deepEqual(bytes, bytesBefore)
})

test("三个对齐及无页码、当前页、页数形式生成原生字段并分别往返", async () => {
  for (const alignment of ["left", "center", "right"]) for (const pageNumber of ["none", "page", "page-total"]) {
    const source = fixture({ header: { text: "第 1 / 1 页也是普通文案", alignment, pageNumber }, footer: null })
    const bytes = await exportBytes(source)
    const zip = await JSZip.loadAsync(bytes)
    const xml = readDocxXml(await zip.file("word/header1.xml").async("string"), "header")
    const instructions = Array.from(xml.getElementsByTagNameNS(WORD_XML, "fldSimple")).map(node => node.getAttributeNS(WORD_XML, "instr"))
    assert.deepEqual(instructions, pageNumber === "none" ? [] : pageNumber === "page" ? ["PAGE"] : ["PAGE", "NUMPAGES"])
    const converted = await convertDocxImport(bytes)
    assert.deepEqual(converted.page.header, source.page.header)
    assert.equal(converted.page.footer, undefined)
    assert.equal(getText(converted.content), getText(source.content))
  }
})

test("无文字的纯页码有中文格式且恢复空文案，不把缓存 1 当作正文", async () => {
  for (const pageNumber of ["page", "page-total"]) {
    const source = fixture({ header: { text: "", alignment: "center", pageNumber }, footer: null })
    const converted = await convertDocxImport(await exportBytes(source))
    assert.deepEqual(converted.page.header, source.page.header)
    assert.equal(getText(converted.content), getText(source.content))
  }
})

test("四种纸型横竖方向及非对称边距的装饰均由正式文件恢复", async () => {
  for (const size of ["A3", "A4", "A5", "Letter"]) for (const orientation of ["portrait", "landscape"]) {
    const source = fixture({ size, orientation, marginsMm: { top: 12.7, right: 13.5, bottom: 19, left: 18.5 } })
    const converted = await convertDocxImport(await exportBytes(source))
    assert.equal(converted.page.size, size); assert.equal(converted.page.orientation, orientation)
    assert.deepEqual(converted.page.header, HEADER); assert.deepEqual(converted.page.footer, FOOTER)
    assert.equal(getText(converted.content), getText(source.content))
  }
})

test("80 Unicode 码点及 XML 转义文本安全往返，单行文案从不作为活动 OOXML", async () => {
  const text = '<script>&"\'😀'.padEnd(79, "中") + "😀"
  assert.equal(Array.from(text).length <= 80, true)
  const source = fixture({ size: "A3", orientation: "landscape", header: { text, alignment: "center", pageNumber: "none" }, footer: { text: "😀".repeat(80), alignment: "left", pageNumber: "page-total" } })
  const converted = await convertDocxImport(await exportBytes(source))
  assert.deepEqual(converted.page.header, source.page.header); assert.deepEqual(converted.page.footer, source.page.footer)
  assert.equal(getText(converted.content), getText(source.content))
})

test("Word 已更新的字段缓存数字可恢复字段格式，不使用缓存作为编辑器分页", async () => {
  const bytes = await changePart(await exportBytes(fixture()), "word/footer1.xml", xml => xml.replaceAll(">1</w:t>", ">234</w:t>"))
  const converted = await convertDocxImport(bytes)
  assert.deepEqual(converted.page.footer, FOOTER)
  assert.ok(!getText(converted.content).includes("234"))
})

test("激活页眉页脚的精确 12 mm 边界三次往返稳定，清楚提示整数单位量化", async () => {
  let source = fixture({ marginsMm: { top: 12, right: 20, bottom: 12, left: 20 } })
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const bytes = await exportBytes(source)
    const zip = await JSZip.loadAsync(bytes)
    const main = readDocxXml(await zip.file("word/document.xml").async("string"), "page distances")
    const margins = main.getElementsByTagNameNS(WORD_XML, "pgMar")[0]
    for (const [kind, side] of [["header", "top"], ["footer", "bottom"]]) {
      assert.ok(Number(margins.getAttributeNS(WORD_XML, kind)) >= 0 && Number(margins.getAttributeNS(WORD_XML, kind)) < Number(margins.getAttributeNS(WORD_XML, side)))
    }
    const converted = await convertDocxImport(bytes)
    assert.equal(converted.page.marginsMm.top, 12); assert.equal(converted.page.marginsMm.bottom, 12)
    assert.deepEqual(converted.page.header, HEADER); assert.deepEqual(converted.page.footer, FOOTER)
    assert.ok(converted.warnings.some(warning => warning.includes("12 mm") && warning.includes("量化")))
    source = { ...source, page: converted.page, content: converted.content }
  }
  const distances = getDocxFurnitureDistances(source.page)
  assert.ok(distances.header >= 0 && distances.header < Math.round(12 * 1440 / 25.4))
  assert.ok(distances.footer >= 0 && distances.footer < Math.round(12 * 1440 / 25.4))
})

test("缺省、null 和空白无页码均不导出空白页内容，水印单独启用仍保持原契约", async () => {
  for (const off of [undefined, null, { text: "   ", alignment: "left", pageNumber: "none" }]) {
    const source = fixture({ header: off, footer: off })
    if (off === undefined) { delete source.page.header; delete source.page.footer }
    const zip = await JSZip.loadAsync(await exportBytes(source))
    assert.equal(zip.file(/^word\/(header|footer)\d+\.xml$/).length, 0)
  }
  const source = fixture({ header: null, footer: null, watermark: WATERMARK })
  const converted = await convertDocxImport(await exportBytes(source))
  assert.deepEqual(converted.page.watermark, WATERMARK)
  assert.equal(converted.page.header, undefined); assert.equal(converted.page.footer, undefined)
})

test("普通第三方页眉页脚继续静态附加，未识别文案不冒充动态设置", async () => {
  const bytes = await transformParts(await exportBytes(fixture()), parts => {
    for (const kind of ["header", "footer"]) {
      const part = parts.get(`word/${kind}1.xml`)
      const control = part.getElementsByTagNameNS(WORD_XML, "sdt")[0]
      const paragraph = getWordChild(getWordChild(control, "sdtContent"), "p")
      part.documentElement.replaceChild(paragraph, control)
    }
  })
  const converted = await convertDocxImport(bytes)
  assert.equal(converted.page.header, undefined); assert.equal(converted.page.footer, undefined)
  assert.ok(getText(converted.content).includes("原文页眉（静态内容）") && getText(converted.content).includes("原文页脚（静态内容）"))
  assert.ok(getText(converted.content).includes(`${FOOTER.text} · 第 1 / 1 页`))
  assert.ok(converted.warnings.some(warning => warning.includes("目录、页码")))
})

test("同一页眉附带的普通段落保留，移除仅限已验证的自有 SDT", async () => {
  const bytes = await changePart(await exportBytes(fixture({ watermark: WATERMARK })), "word/header1.xml", xml => xml.replace("</w:hdr>", "<w:p><w:r><w:t>不能丢失的普通页眉</w:t></w:r></w:p></w:hdr>"))
  const converted = await convertDocxImport(bytes)
  assert.deepEqual(converted.page.header, HEADER); assert.deepEqual(converted.page.watermark, WATERMARK)
  assert.ok(getText(converted.content).endsWith("原文页眉（静态内容）不能丢失的普通页眉"))
  assert.ok(!getText(converted.content).includes(HEADER.text))
})

test("无首节默认的首页或偶数页专用设置不会扩展到全局或污染正文", async () => {
  for (const type of ["first", "even"]) {
    const bytes = await transformParts(await exportBytes(fixture()), parts => {
      for (const kind of ["header", "footer"]) references(parts, kind)[0].setAttributeNS(WORD_XML, "w:type", type)
      if (type === "first") section(parts).appendChild(section(parts).ownerDocument.createElementNS(WORD_XML, "w:titlePg"))
      else { const settings = parts.get("word/settings.xml"); settings.documentElement.appendChild(settings.createElementNS(WORD_XML, "w:evenAndOddHeaders")) }
    })
    const converted = await convertDocxImport(bytes)
    assert.equal(converted.page.header, undefined); assert.equal(converted.page.footer, undefined)
    assert.equal(getText(converted.content), getText(fixture().content))
    assert.ok(converted.warnings.some(warning => warning.includes("首节默认页眉") && warning.includes("未保留")))
    assert.ok(converted.warnings.some(warning => warning.includes("首节默认页脚") && warning.includes("未保留")))
  }
})

test("首页独立内容不同明确警告，首节默认设置仍为全局可表示的依据", async () => {
  const bytes = await transformParts(await exportBytes(fixture()), parts => {
    const other = readDocxXml(writeDocxXml(parts.get("word/header1.xml")).replace("M23 页眉", "独立首页"), "first header")
    addPart(parts, "header", "word/header2.xml", other, "firstHeader")
    addReference(parts, "header", "first", "firstHeader")
    section(parts).appendChild(section(parts).ownerDocument.createElementNS(WORD_XML, "w:titlePg"))
  })
  const converted = await convertDocxImport(bytes)
  assert.deepEqual(converted.page.header, HEADER)
  assert.equal(getText(converted.content), getText(fixture().content))
  assert.ok(converted.warnings.some(warning => warning.includes("首/偶页页眉不同")))
})

test("多节相同且后节继承不制造装饰差异，真正不同的后节按首节默认并警告", async () => {
  for (const different of [false, true]) {
    const bytes = await transformParts(await exportBytes(fixture()), parts => {
      firstSection(parts)
      for (const kind of ["header", "footer"]) for (const ref of references(parts, kind)) ref.parentNode.removeChild(ref)
      if (different) {
        const other = readDocxXml(writeDocxXml(parts.get("word/footer1.xml")).replace("M23 页脚", "第二节页脚"), "second footer")
        addPart(parts, "footer", "word/footer2.xml", other, "secondFooter")
        addReference(parts, "footer", "default", "secondFooter")
      }
    })
    const converted = await convertDocxImport(bytes)
    assert.deepEqual(converted.page.header, HEADER); assert.deepEqual(converted.page.footer, FOOTER)
    assert.equal(getText(converted.content), getText(fixture().content))
    assert.equal(converted.warnings.some(warning => warning.includes("首/偶页页脚不同")), different)
  }
})

test("历史 sectPrChange 中旧自有页内容不当作当前正文，也不先被静态控件守卫误拒绝", async () => {
  const bytes = await transformParts(await exportBytes(fixture({ watermark: WATERMARK })), parts => {
    const historical = readDocxXml(writeDocxXml(parts.get("word/header1.xml")).replace("M23 页眉", "历史页眉"), "historical header")
    addPart(parts, "header", "word/header2.xml", historical, "historicalHeader")
    const change = section(parts).ownerDocument.createElementNS(WORD_XML, "w:sectPrChange")
    change.setAttributeNS(WORD_XML, "w:id", "1")
    const old = section(parts).ownerDocument.createElementNS(WORD_XML, "w:sectPr")
    addReference(parts, "header", "default", "historicalHeader", old)
    change.appendChild(old); section(parts).appendChild(change)
  })
  const converted = await convertDocxImport(bytes)
  assert.deepEqual(converted.page.header, HEADER); assert.deepEqual(converted.page.watermark, WATERMARK)
  assert.equal(getText(converted.content), getText(fixture().content))
  assert.ok(converted.warnings.some(warning => warning.includes("修订快照")))
})

test("页脚真实关系缺失、重复、错误类型、包外路径、错根或缺件均明确拒绝", async () => {
  for (const mutate of [
    (parts, ref) => ref.setAttributeNS(REL_XML, "r:id", "missing"),
    (parts, ref) => { const relation = relationFor(parts, ref); relation.parentNode.appendChild(relation.cloneNode(true)) },
    (parts, ref) => relationFor(parts, ref).setAttribute("Type", `${REL_XML}/header`),
    (parts, ref) => relationFor(parts, ref).setAttribute("Target", "../../outside.xml"),
    (parts, ref) => relationFor(parts, ref).setAttribute("Target", "https://example.invalid/footer.xml"),
    (parts, ref) => { relationFor(parts, ref).setAttribute("TargetMode", "External") },
    parts => parts.delete("word/footer1.xml"),
    parts => parts.set("word/footer1.xml", readDocxXml(`<w:hdr xmlns:w="${WORD_XML}"/>`, "wrong root")),
    (parts, ref) => ref.parentNode.appendChild(ref.cloneNode(true))
  ]) {
    const bytes = await transformParts(await exportBytes(fixture()), parts => mutate(parts, references(parts, "footer")[0]))
    await assert.rejects(convertDocxImport(bytes), /节引用|资源关系|外部图片|缺失|无效/)
  }
})

test("孤立 canonical 部件不会先被移除再绕过原文归属守卫", async () => {
  const bytes = await transformParts(await exportBytes(fixture()), parts => {
    const ref = references(parts, "footer")[0]; ref.parentNode.removeChild(ref)
  })
  await assert.rejects(convertDocxImport(bytes), /未被正文引用|内容控件/)
})

test("孤立的空未知控件或缺缓存页码域仍按旧规则拒绝，不能以空白页部件略过", async () => {
  for (const xml of [
    `<w:ftr xmlns:w="${WORD_XML}"><w:sdt><w:sdtPr><w:tag w:val="UnknownEmptyControl"/></w:sdtPr><w:sdtContent/></w:sdt></w:ftr>`,
    `<w:ftr xmlns:w="${WORD_XML}"><w:p><w:fldSimple w:instr="PAGE"/></w:p></w:ftr>`
  ]) {
    const zip = await JSZip.loadAsync(await exportBytes(fixture({ header: null, footer: null })))
    zip.file("word/footer2.xml", xml)
    await assert.rejects(convertDocxImport(await zip.generateAsync({ type: "uint8array" })), /内容控件|没有已保存的显示值/)
  }
})

test("marker 并不足以放行：损坏内容、格式、字段或嵌套控件绝不静默删掉正文", async () => {
  const source = await exportBytes(fixture())
  for (const mutate of [
    xml => xml.replace("<w:sdt>", '<w:sdt onclick="bad">'),
    xml => xml.replace("</w:sdtPr>", '<w:alias w:val="未知用途"/></w:sdtPr>'),
    xml => xml.replace("</w:sdtContent>", "<w:p><w:r><w:t>不能丢失</w:t></w:r></w:p></w:sdtContent>"),
    xml => xml.replace('w:ascii="Arial"', 'w:ascii="OtherFont"'),
    xml => xml.replace('w:val="626777"', 'w:val="FF0000"'),
    xml => xml.replace('w:val="18"', 'w:val="72"'),
    xml => xml.replace('w:lineRule="exact"', 'w:lineRule="auto"'),
    xml => xml.replace('w:val="left"', 'w:val="both"'),
    xml => xml.replace('w:instr="PAGE"', 'w:instr="INCLUDETEXT secret"'),
    xml => xml.replace('w:instr="PAGE"', 'w:instr="NUMPAGES"'),
    xml => xml.replace(">1</w:t>", ">not-a-page</w:t>"),
    xml => xml.replace(">1</w:t>", "></w:t>"),
    xml => xml.replace("第 </w:t>", "额外文字</w:t>"),
    xml => xml.replace("MewocPageHeader_v1", "MewocPageFooter_v1"),
    xml => xml.replace("MewocPageHeader_v1", "UnknownControl"),
    xml => xml.replace("M23 页眉 &lt;&amp;&gt; 😀", "长".repeat(81)),
    xml => xml.replace("M23 页眉 &lt;&amp;&gt; 😀", "&#10;换行"),
    xml => xml.replace("<w:sdt>", "<w:p><w:sdt>").replace("</w:sdt>", "</w:sdt></w:p>")
  ]) {
    const bytes = await changePart(source, "word/header1.xml", mutate)
    await assert.rejects(convertDocxImport(bytes), /页眉、页脚|内容控件/)
  }
})

test("当前未知 VML 不因自有页眉或水印支持被放行", async () => {
  const bytes = await changePart(await exportBytes(fixture({ watermark: WATERMARK })), "word/header1.xml", xml =>
    xml.replace("</w:hdr>", '<w:p><w:r><w:pict><v:shape id="Unknown"><v:textpath on="t" string="未知艺术字"/></v:shape></w:pict></w:r></w:p></w:hdr>'))
  await assert.rejects(convertDocxImport(bytes), /旧式图形|文本框/)
})

test("Word 命名空间别名不改变恢复结果，识别依 URI 而非 w: 字符串", async () => {
  let bytes = await exportBytes(fixture())
  for (const name of ["word/header1.xml", "word/footer1.xml"]) bytes = await changePart(bytes, name, xml => xml.replaceAll("xmlns:w=", "xmlns:word=").replaceAll("w:", "word:"))
  const converted = await convertDocxImport(bytes)
  assert.deepEqual(converted.page.header, HEADER); assert.deepEqual(converted.page.footer, FOOTER)
})
