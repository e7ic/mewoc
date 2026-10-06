/**
 * 报告类 Word 语义回归：受控合成目录/页码域、页眉页脚关系、图表缓存与旧环绕配置。
 * 检查静态保留的显示值和资源归属，并验证外部指令、缺缓存及未知嵌入对象仍被拒绝。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { imageSize } from "image-size"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { readDocxImportArchive } from "../src/pages/editor/tools/docx-import-archive.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { readDocxXml, WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"

// Node DOM 与图片尺寸替身用于业务结构校验，真实解码/办公软件视觉布局不由本组测试断言。
const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
globalThis.createImageBitmap = async blob => ({ ...imageSize(new Uint8Array(await blob.arrayBuffer())), close() {} })
const SOURCE = await fs.readFile(new URL("./fixtures/docx-compatibility/tiny-picture.docx", import.meta.url))
const ORIGINAL = await JSZip.loadAsync(SOURCE)
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships"
const CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart"
const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main"
const NS = `xmlns:w="${WORD_XML}" xmlns:r="${REL}" xmlns:c="${CHART}" xmlns:a="${DRAWING}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w10="urn:schemas-microsoft-com:office:word"`
// 域构造器按 begin/instrText/separate/result/end 组成复杂域，控件与关系构造器用于隔离语义边界。
const text = value => `<w:r><w:t>${value}</w:t></w:r>`
const paragraph = value => `<w:p>${text(value)}</w:p>`
const marker = type => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`
const start = code => marker("begin") + `<w:r><w:instrText xml:space="preserve">${code}</w:instrText></w:r>` + marker("separate")
const field = (code, value) => start(code) + text(value) + marker("end")
const control = (gallery, content, extra = "") => `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="${gallery}"/></w:docPartObj>${extra}</w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`
const relation = (id, type, target, extra = "") => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}" ${extra}/>`
const relations = value => `<Relationships xmlns="${PACKAGE}">${value}</Relationships>`
const getText = node => node.text || (node.content || []).map(getText).join("")
const getNodes = (node, type) => [...(node.type === type ? [node] : []), ...(node.content || []).flatMap(child => getNodes(child, type))]
// 从有效图片 DOCX 起步，替换正文和关系/附属部件，确保失败来自当前注入场景。
const makeFile = async (body, parts = {}, rels = "") => {
  const zip = await JSZip.loadAsync(SOURCE)
  zip.file("word/document.xml", `<w:document ${NS}><w:body>${body}</w:body></w:document>`)
  if (rels) zip.file("word/_rels/document.xml.rels", relations(rels))
  for (const [path, data] of Object.entries(parts)) zip.file(path, data)
  return zip.generateAsync({ type: "uint8array" })
}
const read = async bytes => createDocxImportRecord(await convertDocxImport(bytes), "合成报告回归")

// 域标记可跨段且结果里可嵌 PAGEREF，状态机必须覆盖整树，导出后静态文字也应稳定。
test("跨段自动目录及嵌套 PAGEREF 保留缓存文字，导出后变为稳定正文", async () => {
  const body = control("Table of Contents", `<w:p>${start(' TOC \\o "1-3" ')}${text("目录")}</w:p><w:p><w:hyperlink w:anchor="_TocChapter1">${text("第一章")}${field(" PAGEREF chapter1 \\h ", "7")}</w:hyperlink></w:p><w:p>${text("第二章")}${field(" PAGEREF chapter2 ", "9")}${marker("end")}</w:p>`)
  const result = await read(await makeFile(body))
  assert.equal(getText(result.record.document.content), "目录第一章7第二章9")
  assert.ok(result.warnings.some(value => /不会随编辑或分页自动更新/.test(value)))
  const exported = await createDocumentDocx(result.record.document, result.record.assets)
  const restored = await read(new Uint8Array(await exported.blob.arrayBuffer()))
  assert.equal(getText(restored.record.document.content), "目录第一章7第二章9")
})

// 简单/复杂域都保留上下文文字；未知引用或外部指令即使有缓存也不能通过放宽白名单。
test("简单页码域和同一段落前后文字保留，不执行外部域", async () => {
  const result = await read(await makeFile(`<w:p>${text("第")}<w:fldSimple w:instr="PAGE">${text("3")}</w:fldSimple>${text("页，共")}${field("NUMPAGES", "12")}${text("页")}</w:p>`))
  assert.equal(getText(result.record.document.content), "第3页，共12页")
  for (const code of ["DDEAUTO server", 'INCLUDETEXT "https://example.invalid/private"', "MERGEFIELD name", "REF bookmark"]) await assert.rejects(read(await makeFile(`<w:p>${field(code, "缓存")}</w:p>`)), /暂不支持的域/)
})

// 逐类构造坏域状态，确保仅有标记或部分缓存不足以接受，不能误把域代码写入正文。
test("不完整、重复分隔、无缓存或游离的域代码不能默默通过", async () => {
  const cases = [start("PAGE") + text("1"), marker("end"), marker("begin") + marker("end"), start("PAGE") + marker("end"), start("PAGE") + marker("separate") + text("1") + marker("end"), "<w:r><w:instrText>PAGE</w:instrText></w:r>", '<w:fldSimple w:instr="PAGE"/>']
  for (const content of cases) await assert.rejects(read(await makeFile(`<w:p>${content}</w:p>`)), /域/)
})

// 允许目录图库不意味着允许任意数据绑定或表单语义，结构属性也必须一起受白名单约束。
test("仅展开已识别目录和页码内容控件，数据绑定及其他控件仍拒绝", async () => {
  for (const content of [control("Unknown", paragraph("不能丢弃")), control("Table of Contents", paragraph("绑定"), '<w:dataBinding w:xpath="/data"/>'), "<w:sdt><w:sdtPr><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>表单</w:t></w:r></w:sdtContent></w:sdt>"]) await assert.rejects(read(await makeFile(content)), /内容控件/)
})

// 故意让主文档同名 ID 指向错图，证明页内容复制时从自身 owner 查关系并重映射，重复节引用只追加一次。
test("页眉图片关系从其自身部件解析，正文同名关系不会串图，重复引用只附一次", async () => {
  const main = readDocxXml(await ORIGINAL.file("word/document.xml").async("string"), "fixture")
  const picture = main.getElementsByTagNameNS(WORD_XML, "drawing")[0].toString()
  const originalRels = readDocxXml(await ORIGINAL.file("word/_rels/document.xml.rels").async("string"), "relationships")
  const imageRel = Array.from(originalRels.getElementsByTagNameNS(PACKAGE, "Relationship")).find(node => node.getAttribute("Type").endsWith("/image"))
  const originalId = imageRel.getAttribute("Id")
  const header = `<w:hdr ${NS}>${paragraph("页眉文字")}<w:p><w:r>${picture}</w:r></w:p></w:hdr>`
  const body = paragraph("正文") + "<w:p><w:pPr><w:sectPr><w:headerReference r:id=\"header\"/></w:sectPr></w:pPr></w:p><w:sectPr><w:headerReference r:id=\"header\"/><w:footerReference r:id=\"footer\"/></w:sectPr>"
  const result = await read(await makeFile(body, {
    "word/header1.xml": header,
    "word/_rels/header1.xml.rels": relations(imageRel.toString()),
    "word/footer1.xml": `<w:ftr ${NS}>${control("Page Numbers (Bottom of Page)", `<w:p>${field("PAGE", "4")}</w:p>`)}</w:ftr>`
  }, relation("header", "header", "header1.xml") + relation("footer", "footer", "footer1.xml") + relation(originalId, "image", "media/not-the-header.png")))
  assert.equal(getNodes(result.record.document.content, "image").length, 1)
  assert.equal(getText(result.record.document.content), "正文原文页眉（静态内容）页眉文字原文页脚（静态内容）4")
  assert.ok(result.warnings.some(value => /附在正文末尾/.test(value)))
})

// 图表预期由显式分类/系列/数值数组生成；引用公式保留在 XML 但导入应只消费已保存缓存。
const cache = (values, numeric = false) => `<c:${numeric ? "num" : "str"}Ref><c:f>Sheet1!A1:A2</c:f><c:${numeric ? "num" : "str"}Cache><c:ptCount val="${values.length}"/>${values.map((value, i) => `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join("")}</c:${numeric ? "num" : "str"}Cache></c:${numeric ? "num" : "str"}Ref>`
const series = (name, categories, values) => `<c:ser><c:tx><c:v>${name}</c:v></c:tx><c:cat>${cache(categories)}</c:cat><c:val>${cache(values, true)}</c:val></c:ser>`
const chart = (content, type = "barChart", external = "") => `<c:chartSpace xmlns:c="${CHART}" xmlns:a="${DRAWING}" xmlns:r="${REL}"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>统计</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:${type}>${content}</c:${type}></c:plotArea></c:chart>${external}</c:chartSpace>`
const chartDrawing = '<w:drawing><a:graphic><a:graphicData><c:chart r:id="chart"/></a:graphicData></a:graphic></w:drawing>'
// 为独立图表建立主文档关系及 chart1.xml，可附加工作簿或图表关系以测试资源准入。
const chartFile = (xml, extra = {}) => makeFile(`<w:p><w:r>${chartDrawing}</w:r></w:p>`, { "word/charts/chart1.xml": xml, ...extra }, relation("chart", "chart", "charts/chart1.xml"))

// 工作簿特意不是合法 XLSX，成功只能来自缓存；重建 ZIP 中不应夹带工作簿字节或执行其内容。
test("原生图表保留标题、分类、系列及数值，图表工作簿不执行且不进入转换 ZIP", async () => {
  const bytes = await chartFile(chart(series("系列甲", ["分类一", "分类二"], ["3", "7"]) + series("系列乙", ["分类一", "分类二"], ["5", "9"]), "barChart", '<c:externalData r:id="workbook"/>'), {
    "word/charts/_rels/chart1.xml.rels": relations(relation("workbook", "package", "../embeddings/data.xlsx")),
    // 故意不是可执行或可读取的工作簿：导入只能读取图表缓存。
    "word/embeddings/data.xlsx": "opaque workbook bytes"
  })
  const archive = await readDocxImportArchive(bytes, new Set())
  assert.equal((await JSZip.loadAsync(archive.buffer)).file("word/embeddings/data.xlsx"), null)
  const result = await read(bytes)
  assert.equal(getText(result.record.document.content), "统计（柱形图数据）分类系列甲系列乙分类一35分类二79")
  assert.equal(getNodes(result.record.document.content, "table").length, 1)
  const exported = await createDocumentDocx(result.record.document, result.record.assets)
  assert.equal(getText((await read(new Uint8Array(await exported.blob.arrayBuffer()))).record.document.content), getText(result.record.document.content))
})

// 零点缓存是合法空图表，保留说明而不伪造数据行，区别于缺失缓存的失败。
test("缓存明确为零点的空图表保留系列说明，不杜撰数值", async () => {
  const result = await read(await chartFile(chart(series("来源待补充", [], []), "pieChart")))
  assert.equal(getNodes(result.record.document.content, "table").length, 0)
  assert.match(getText(result.record.document.content), /此图表未保存数据点；系列：来源待补充/)
})

// 缓存不仅要存在，还要索引唯一、分类/数值数量一致及有限数字，否则普通数据表可能陈述错误事实。
test("图表缺少缓存、分类错位、重复点或非数值时明确拒绝", async () => {
  const valid = chart(series("甲", ["一", "二"], ["1", "2"]))
  const variants = [valid.replace(/<c:numCache>.*?<\/c:numCache>/, ""), valid.replace('idx="1"', 'idx="0"'), chart(series("甲", ["一"], ["1", "2"])), chart(series("甲", ["一"], ["NaN"])), chart(series("甲", ["一"], ["1"]) + series("乙", ["二"], ["2"]))]
  for (const xml of variants) await assert.rejects(read(await chartFile(xml)), /图表/)
})

// 只豁免成功图表明确引用的内部 XLSX，不能借图表支持放开任意嵌入附件或外部数据。
test("只允许已转换图表的内嵌 XLSX，其他附件及外部工作簿保持拒绝", async () => {
  const valid = chart(series("甲", ["一"], ["1"]))
  await assert.rejects(read(await chartFile(valid, { "word/embeddings/unknown.xlsx": "ignored?" })), /嵌入文件/)
  await assert.rejects(read(await chartFile(chart(series("甲", ["一"], ["1"]), "barChart", '<c:externalData r:id="workbook"/>'), { "word/charts/_rels/chart1.xml.rels": relations(relation("workbook", "package", "https://example.invalid/data.xlsx", 'TargetMode="External"')) })), /外部/)
  await assert.rejects(read(await chartFile(chart(series("甲", ["一"], ["1"]), "scatterChart"))), /柱形、折线或饼图/)
})

// 可以略去纯布局锁定标记，但该标记内藏正文时仍应拒绝，防止外观白名单变成内容漏读通道。
test("旧式文本框的环绕和锚点锁定可降级，未知子内容不能随之丢弃", async () => {
  const content = `<w:p><w:r><w:pict><v:shape><v:textbox><w:txbxContent>${paragraph("框内文字")}</w:txbxContent></v:textbox><w10:wrap type="square"/><w10:anchorlock/></v:shape></w:pict></w:r></w:p>`
  assert.equal(getText((await read(await makeFile(content))).record.document.content), "框内文字")
  await assert.rejects(read(await makeFile(content.replace("<w10:anchorlock/>", "<w10:anchorlock><w:t>不能忽略</w:t></w10:anchorlock>"))), /旧式图形/)
})
