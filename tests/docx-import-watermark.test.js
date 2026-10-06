/** 本项目原生水印往返及拒绝边界：使用真实导出 XML，不用仅含 marker 的伪水印替代结构验证。 */
import test from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { extractDocxWatermark } from "../src/pages/editor/tools/docx-import-watermark.js"
import { appendDocxPageContent } from "../src/pages/editor/tools/docx-import-report.js"
import { normalizeDocxLegacyContent } from "../src/pages/editor/tools/docx-import-drawings.js"
import { readDocxXml, writeDocxXml, getWordChild, WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"

const REL_XML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const PACKAGE_XML = "http://schemas.openxmlformats.org/package/2006/relationships"
const VML_XML = "urn:schemas-microsoft-com:vml"
const WATERMARK = { text: "内部资料", color: "#AB12EF", opacity: 0.18, angle: -35 }
const PAGE = { size: "A5", orientation: "landscape", marginsMm: { top: 12.7, right: 15, bottom: 18, left: 20 } }
const fixture = async (watermark = WATERMARK, page = PAGE) => {
  const source = createDocument()
  source.page = { ...structuredClone(page), watermark: { ...watermark } }
  source.content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "完整正文" }] }] }
  const result = await createDocumentDocx(source, new Map())
  const bytes = new Uint8Array(await result.blob.arrayBuffer())
  const zip = await JSZip.loadAsync(bytes)
  const parts = new Map()
  for (const file of zip.file(/\.(xml|rels)$/)) parts.set(file.name, readDocxXml(await file.async("string"), file.name))
  return { source, bytes, zip, parts, warnings: new Set(), header: parts.get("word/header1.xml") }
}
const read = value => extractDocxWatermark(value.parts, value.source.page, value.warnings)
const body = value => getWordChild(value.parts.get("word/document.xml").documentElement, "body")
const section = value => getWordChild(body(value), "sectPr")
const references = value => Array.from(section(value).getElementsByTagNameNS(WORD_XML, "headerReference"))
const rebuildHeader = (value, transform) => {
  value.header = readDocxXml(transform(writeDocxXml(value.header)), "header mutation")
  value.parts.set("word/header1.xml", value.header)
}
const addHeader = (value, name, header, id) => {
  value.parts.set(`word/${name}`, header)
  const relations = value.parts.get("word/_rels/document.xml.rels")
  const node = relations.createElementNS(PACKAGE_XML, "Relationship")
  node.setAttribute("Id", id)
  node.setAttribute("Type", `${REL_XML}/header`)
  node.setAttribute("Target", name)
  relations.documentElement.appendChild(node)
}
const addReference = (value, kind, id, parent = section(value)) => {
  const node = parent.ownerDocument.createElementNS(WORD_XML, "w:headerReference")
  node.setAttributeNS(WORD_XML, "w:type", kind)
  node.setAttributeNS(REL_XML, "r:id", id)
  parent.appendChild(node)
  return node
}
const titlePage = value => section(value).appendChild(section(value).ownerDocument.createElementNS(WORD_XML, "w:titlePg"))
const evenPages = value => {
  const settings = value.parts.get("word/settings.xml")
  settings.documentElement.appendChild(settings.createElementNS(WORD_XML, "w:evenAndOddHeaders"))
}
const firstSection = value => {
  const first = section(value).cloneNode(true)
  const paragraph = first.ownerDocument.createElementNS(WORD_XML, "w:p")
  const properties = first.ownerDocument.createElementNS(WORD_XML, "w:pPr")
  properties.appendChild(first)
  paragraph.appendChild(properties)
  body(value).insertBefore(paragraph, body(value).firstChild)
  return first
}
const fullLegacyPass = value => {
  appendDocxPageContent(value.parts, value.warnings)
  normalizeDocxLegacyContent(value.parts.get("word/document.xml"), value.warnings)
}

test("实际 Mewoc 水印恢复四项设置且不污染正文，清理仅作用内存 DOM、原压缩字节不变", async () => {
  const value = await fixture()
  const before = value.bytes.slice()
  const original = await value.zip.file("word/header1.xml").async("string")
  const page = structuredClone(value.source.page)
  assert.deepEqual(read(value), WATERMARK)
  assert.deepEqual(value.source.page, page)
  assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "p").length, 0)
  fullLegacyPass(value)
  assert.equal(body(value).textContent, "完整正文")
  assert.equal(value.warnings.size, 0)
  assert.deepEqual(value.bytes, before)
  assert.equal(await value.zip.file("word/header1.xml").async("string"), original)
  assert.ok(original.includes("MewocWatermarkShape_"))
})

test("所有纸型方向、80 个 Unicode 码点、5%/50% 和正负90度都从真实导出水印恢复", async () => {
  for (const size of ["A3", "A4", "A5", "Letter"]) for (const orientation of ["portrait", "landscape"]) {
    const mark = { ...WATERMARK, text: "😀".repeat(80), opacity: orientation === "portrait" ? 0.05 : 0.5, angle: orientation === "portrait" ? -90 : 90 }
    const value = await fixture(mark, { ...PAGE, size, orientation })
    assert.deepEqual(read(value), mark)
    assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "pict").length, 0)
  }
})

test("转义文字和命名空间别名安全恢复，XML 字符串没有被当作正文标记", async () => {
  const mark = { ...WATERMARK, text: "<script>&\"'😀" }
  const value = await fixture(mark)
  rebuildHeader(value, xml => xml.replaceAll("xmlns:v=", "xmlns:legacy=").replaceAll("v:", "legacy:").replaceAll("xmlns:w=", "xmlns:word=").replaceAll("w:", "word:"))
  assert.deepEqual(read(value), mark)
  fullLegacyPass(value)
  assert.equal(body(value).textContent, "完整正文")
})

test("同一水印段落的普通 run 和其它页眉正文按原附加链保留，没有水印空占位段落", async () => {
  const value = await fixture()
  const xml = value.header
  const paragraph = xml.getElementsByTagNameNS(WORD_XML, "p")[0]
  const run = xml.createElementNS(WORD_XML, "w:r"), text = xml.createElementNS(WORD_XML, "w:t")
  text.appendChild(xml.createTextNode("普通页眉正文"))
  run.appendChild(text)
  paragraph.appendChild(run)
  assert.deepEqual(read(value), WATERMARK)
  assert.equal(xml.getElementsByTagNameNS(WORD_XML, "p").length, 1)
  fullLegacyPass(value)
  assert.equal(body(value).textContent, "完整正文原文页眉（静态内容）普通页眉正文")
  assert.ok([...value.warnings].some(warning => warning.includes("页眉、页脚")))
  assert.equal(body(value).getElementsByTagNameNS(WORD_XML, "pict").length, 0)
})

test("仅伪装 Mewoc ID 不放行：未知属性、活动引用、额外子节点、艺术字或拉伸几何保持旧链拒绝", async () => {
  const mutations = [
    xml => xml.replace("<w:pict>", "<w:pict onclick=\"alert(1)\">"),
    xml => xml.replace("<v:shape id=", "<v:shape href=\"https://example.invalid/\" id="),
    xml => xml.replace("<v:fill opacity=", "<v:fill type=\"gradient\" opacity="),
    xml => xml.replace("<v:textpath on=\"t\"/>", "<v:textpath on=\"t\" string=\"额外艺术字\"/>"),
    xml => xml.replace("</v:shape>", "<v:imagedata r:id=\"hidden\"/></v:shape>"),
    xml => xml.replace("</v:shape>", "<v:textbox><w:txbxContent><w:p><w:r><w:t>不能丢失</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape>"),
    xml => xml.replace("</v:shape>", "<v:textpath on=\"t\" string=\"不能丢失\"/></v:shape>"),
    xml => xml.replace("</v:shapetype>", "<v:formulas><v:f eqn=\"sum 0 0 0\"/></v:formulas></v:shapetype>"),
    xml => xml.replace("mso-position-horizontal-relative:page", "mso-position-horizontal-relative:margin"),
    xml => xml.replace("z-index:-251654144", "z-index:5"),
    xml => xml.replace("mso-wrap-style:none", "mso-wrap-style:none;rotation:20"),
    xml => xml.replace("font-family:Arial", "font-family:OtherFont"),
    xml => xml.replace(/width:[^;]+/, "width:999pt"),
    xml => xml.replace("</w:pict>", "不能丢失</w:pict>")
  ]
  for (const mutation of mutations) {
    const value = await fixture()
    rebuildHeader(value, mutation)
    const before = writeDocxXml(value.header)
    assert.equal(read(value), undefined)
    assert.equal(writeDocxXml(value.header), before)
    assert.throws(() => fullLegacyPass(value), /旧式图形|外观内容|文本框|资源关系/)
  }
})

test("水印属性超出共享契约时留 DOM 并拒绝，不能截断长文字或钳制透明度和角度", async () => {
  const mutations = [
    xml => xml.replace("opacity=\"0.18\"", "opacity=\"0.01\""),
    xml => xml.replace("opacity=\"0.18\"", "opacity=\"0.51\""),
    xml => xml.replace("opacity=\"0.18\"", "opacity=\"NaN\""),
    xml => xml.replace("rotation:-35", "rotation:91"),
    xml => xml.replace("fillcolor=\"#AB12EF\"", "fillcolor=\"red\""),
    xml => xml.replace("string=\"内部资料\"", `string="${"长".repeat(81)}"`),
    xml => xml.replace("string=\"内部资料\"", "string=\"&#10;\"")
  ]
  for (const mutation of mutations) {
    const value = await fixture()
    rebuildHeader(value, mutation)
    assert.equal(read(value), undefined)
    assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "pict").length, 1)
    assert.throws(() => fullLegacyPass(value), /旧式图形/)
  }
})

test("marker、形状类型配对与 ID 唯一性必须成立，标准 Word 艺术字不按 Mewoc 水印吞掉", async () => {
  for (const mutation of [
    xml => xml.replaceAll("MewocWatermark", "WordWatermark"),
    xml => xml.replace(/type="#MewocWatermarkType_[a-f\d]+"/, "type=\"#missing\""),
    xml => xml.replace(/(<v:shape id=")[^"]+/, "$1MewocWatermarkShape_11111111111111111111111111111111"),
    xml => xml.replace("coordsize=\"21600,21600\"", "coordsize=\"2000,2000\"")
  ]) {
    const value = await fixture()
    rebuildHeader(value, mutation)
    assert.equal(read(value), undefined)
    assert.throws(() => fullLegacyPass(value), /旧式图形/)
  }
  const duplicated = await fixture()
  const picture = duplicated.header.getElementsByTagNameNS(WORD_XML, "pict")[0]
  picture.parentNode.appendChild(picture.cloneNode(true))
  assert.equal(read(duplicated), undefined)
  assert.equal(duplicated.header.getElementsByTagNameNS(WORD_XML, "pict").length, 2)
})

test("真正的包内页眉关系支持绝对路径和路径规范化，但缺失、重复、外链和错误类型明确拒绝", async () => {
  for (const target of ["/word/header1.xml", "./unused/../header1.xml"]) {
    const value = await fixture()
    const id = references(value)[0].getAttributeNS(REL_XML, "id")
    const relation = Array.from(value.parts.get("word/_rels/document.xml.rels").getElementsByTagNameNS(PACKAGE_XML, "Relationship")).find(node => node.getAttribute("Id") === id)
    relation.setAttribute("Target", target)
    assert.deepEqual(read(value), WATERMARK)
  }
  for (const change of [
    (value, relation) => relation.setAttribute("Target", "missing.xml"),
    (value, relation) => relation.setAttribute("Target", "../../outside.xml"),
    (value, relation) => relation.setAttribute("TargetMode", "External"),
    (value, relation) => relation.setAttribute("Type", `${REL_XML}/footer`),
    (value, relation) => relation.parentNode.appendChild(relation.cloneNode(true)),
    value => references(value)[0].setAttributeNS(REL_XML, "r:id", "missing")
  ]) {
    const value = await fixture()
    const id = references(value)[0].getAttributeNS(REL_XML, "id")
    const relation = Array.from(value.parts.get("word/_rels/document.xml.rels").getElementsByTagNameNS(PACKAGE_XML, "Relationship")).find(node => node.getAttribute("Id") === id)
    change(value, relation)
    assert.throws(() => read(value), /水印页眉.*无效/)
    assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "pict").length, 1)
  }
})

test("不同节未重新引用时沿用前节页眉，同一水印可合并且没有分节差异提示", async () => {
  const value = await fixture()
  firstSection(value)
  references(value).forEach(node => node.parentNode.removeChild(node))
  assert.deepEqual(read(value), WATERMARK)
  assert.equal(value.warnings.size, 0)
})

test("首节 default 有水印，后节水印不同或明确空页眉时提示全局采用首节", async () => {
  for (const other of [(await fixture({ ...WATERMARK, text: "另一节" })).header, readDocxXml(`<w:hdr xmlns:w="${WORD_XML}"><w:p/></w:hdr>`, "empty header")]) {
    const value = await fixture()
    firstSection(value)
    addHeader(value, "header2.xml", other, "nextHeader")
    references(value)[0].setAttributeNS(REL_XML, "r:id", "nextHeader")
    assert.deepEqual(read(value), WATERMARK)
    assert.ok([...value.warnings].some(warning => warning.includes("统一采用首节") && warning.includes("其他页")))
    assert.equal(other.getElementsByTagNameNS(WORD_XML, "pict").length, 0)
  }
})

test("首节无水印、后续节专用水印不会扩展到全文，明确提示未保留", async () => {
  const value = await fixture()
  const first = firstSection(value)
  Array.from(first.getElementsByTagNameNS(WORD_XML, "headerReference")).forEach(node => first.removeChild(node))
  assert.equal(read(value), undefined)
  assert.ok([...value.warnings].some(warning => warning.includes("后续节专用水印未保留")))
  fullLegacyPass(value)
  assert.equal(body(value).textContent, "完整正文")
})

test("只有 first/even 水印时不扩展到全文，首偶页差异不被无提示覆盖", async () => {
  for (const kind of ["first", "even"]) {
    const value = await fixture()
    references(value)[0].setAttributeNS(WORD_XML, "w:type", kind)
    if (kind === "first") titlePage(value)
    else evenPages(value)
    assert.equal(read(value), undefined)
    assert.ok([...value.warnings].some(warning => warning.includes("首/偶页") && warning.includes("未保留")))
    assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "pict").length, 0)
  }
})

test("首偶页同水印可恢复；启用首偶但缺少对应水印时提示适用范围改变", async () => {
  for (const same of [true, false]) {
    const value = await fixture()
    titlePage(value)
    evenPages(value)
    if (same) {
      const id = references(value)[0].getAttributeNS(REL_XML, "id")
      addReference(value, "first", id)
      addReference(value, "even", id)
    }
    assert.deepEqual(read(value), WATERMARK)
    assert.equal([...value.warnings].some(warning => warning.includes("首/偶页水印不同")), !same)
  }
})

test("同一页眉多个真正支持的相同水印合并为一层，清理各空段并提示重叠层次变化", async () => {
  const value = await fixture()
  const duplicate = await fixture()
  value.header.documentElement.appendChild(value.header.importNode(duplicate.header.getElementsByTagNameNS(WORD_XML, "p")[0], true))
  assert.deepEqual(read(value), WATERMARK)
  assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "pict").length, 0)
  assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "p").length, 0)
  assert.ok([...value.warnings].some(warning => warning.includes("多个 Mewoc 水印") && warning.includes("层次不保留")))
  fullLegacyPass(value)
  assert.equal(body(value).textContent, "完整正文")
})

test("没有正文节引用的水印不提取，不让旧残留资源通过导入", async () => {
  const value = await fixture()
  references(value).forEach(node => node.parentNode.removeChild(node))
  const original = writeDocxXml(value.header)
  assert.equal(read(value), undefined)
  assert.equal(writeDocxXml(value.header), original)
  assert.throws(() => fullLegacyPass(value), /未被正文引用/)
})

test("旧式缺少 w:type 的页眉继续按 default 读取并提示页型不确定，不增加普通页眉导入拒绝", async () => {
  const value = await fixture()
  references(value)[0].removeAttributeNS(WORD_XML, "type")
  assert.deepEqual(read(value), WATERMARK)
  assert.ok([...value.warnings].some(warning => warning.includes("缺少页型") && warning.includes("首/偶页")))
  fullLegacyPass(value)
  assert.equal(body(value).textContent, "完整正文")
})

test("有效 watermark pict 与未知 VML 相邻时保留未知部分，旧图形失败不能被部分提取掩盖", async () => {
  const value = await fixture()
  const run = value.header.getElementsByTagNameNS(WORD_XML, "r")[0]
  const unknown = readDocxXml(`<w:pict xmlns:w="${WORD_XML}" xmlns:v="${VML_XML}"><v:shape><v:textpath string="隐藏艺术字"/></v:shape></w:pict>`, "unknown")
  run.appendChild(value.header.importNode(unknown.documentElement, true))
  assert.deepEqual(read(value), WATERMARK)
  assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "pict").length, 1)
  assert.equal(value.header.getElementsByTagNameNS(VML_XML, "textpath")[0].getAttribute("string"), "隐藏艺术字")
  assert.throws(() => fullLegacyPass(value), /旧式图形/)
})

test("有效节以外的 sectPrChange 快照不决定水印，未知空引用也必须拒绝而非略过", async () => {
  const value = await fixture()
  const previous = (await fixture({ ...WATERMARK, text: "旧节快照" })).header
  addHeader(value, "header2.xml", previous, "previousHeader")
  const change = section(value).ownerDocument.createElementNS(WORD_XML, "w:sectPrChange")
  const oldSection = section(value).cloneNode(true)
  oldSection.getElementsByTagNameNS(WORD_XML, "headerReference")[0].setAttributeNS(REL_XML, "r:id", "previousHeader")
  change.appendChild(oldSection)
  section(value).appendChild(change)
  assert.deepEqual(read(value), WATERMARK)
  assert.equal(previous.getElementsByTagNameNS(WORD_XML, "pict").length, 1)
  const invalid = await fixture()
  references(invalid)[0].setAttributeNS(WORD_XML, "w:type", "unknown")
  assert.throws(() => read(invalid), /水印页眉.*无效/)
})
