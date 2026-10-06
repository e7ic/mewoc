/**
 * Word 旧绘图回归：用小图夹具的真实资源合成 VML 文本框、图片与 AlternateContent。
 * 核对锚点展开顺序、嵌套正文/公式/列表和图片往返；不可解释对象必须拒绝，不能只保留已识别一部分。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { imageSize } from "image-size"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { readDocxXml, WORD_XML, MATH_XML } from "../src/pages/editor/tools/docx-import-xml.js"

const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
// 图片字节及清理在 Node 断言，真实浏览器解码仍由浏览器导入专项验证。
let CREATED = 0
let CLOSED = 0
globalThis.createImageBitmap = async blob => {
  CREATED += 1
  return { ...imageSize(new Uint8Array(await blob.arrayBuffer())), close: () => { CLOSED += 1 } }
}
// 从独立小图样例读取有效图片关系，合成旧式 imagedata 继续引用同一真实资源。
const SOURCE = await fs.readFile(new URL("./fixtures/docx-compatibility/tiny-picture.docx", import.meta.url))
const ORIGINAL = await JSZip.loadAsync(SOURCE)
const ORIGINAL_XML = readDocxXml(await ORIGINAL.file("word/document.xml").async("string"), "fixture")
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const IMAGE_ID = ORIGINAL_XML.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "blip")[0].getAttributeNS(REL, "embed")
const NS = `xmlns:w="${WORD_XML}" xmlns:m="${MATH_XML}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="${REL}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"`
// 受控 XML 构造器表达正文、文本框、图片和锚点，减少与当前被测图形语义无关的包差异。
const text = value => `<w:r><w:t>${value}</w:t></w:r>`
const paragraph = value => `<w:p>${text(value)}</w:p>`
const box = content => `<w:pict><v:shape><v:textbox><w:txbxContent>${content}</w:txbxContent></v:textbox></v:shape></w:pict>`
const image = `<w:pict><v:shape><v:imagedata r:id="${IMAGE_ID}"/></v:shape></w:pict>`
const anchor = value => `<w:p><w:r>${value}</w:r></w:p>`
const getText = node => node.text || (node.content || []).map(getText).join("")
const getNodes = (node, type) => [...(node.type === type ? [node] : []), ...(node.content || []).flatMap(child => getNodes(child, type))]
// 每次从原归档独立生成主文档，并按需覆写其它部件，原样例和资源字节不会被修改。
const makeFile = async (body, extra = {}) => {
  const zip = await JSZip.loadAsync(SOURCE)
  zip.file("word/document.xml", `<w:document ${NS}><w:body>${body}</w:body></w:document>`)
  for (const [path, content] of Object.entries(extra)) zip.file(path, content)
  return zip.generateAsync({ type: "uint8array" })
}
const read = async bytes => createDocxImportRecord(await convertDocxImport(bytes), "旧式内容回归")

// 展开会移动图形而非原段落文字，多个锚点的插入顺序最易反转，因此按最终块序逐项核对。
test("同一段落的多个文本框保留源顺序，文字置于所属段落之后并提示布局变化", async () => {
  const bytes = await makeFile(`<w:p>${text("前")}<w:r>${box(paragraph("甲"))}</w:r>${text("后")}<w:r>${box(paragraph("乙"))}</w:r></w:p>${paragraph("尾")}`)
  const original = bytes.slice()
  const result = await read(bytes)
  assert.deepEqual(result.record.document.content.content.map(getText), ["前后", "甲", "乙", "尾"])
  assert.ok(result.warnings.some(warning => /所属段落之后.*浮动位置/.test(warning)))
  assert.deepEqual(bytes, original)
})

// Choice/Fallback 描述同一对象，嵌套兼容分支也只能保留一份语义，不能重复正文。
test("兼容分支只读取 Fallback 一次，嵌套兼容分支也不重复正文", async () => {
  const alternate = content => `<mc:AlternateContent><mc:Choice Requires="wps">${box(paragraph("不能重复导入"))}</mc:Choice><mc:Fallback>${content}</mc:Fallback></mc:AlternateContent>`
  const result = await read(await makeFile(anchor(alternate(alternate(box(paragraph("正文一次")))))))
  assert.equal(getText(result.record.document.content), "正文一次")
})

// 展开必须早于编号/公式读取，复杂框内语义与再导入结果一起检查，防止只保留 textContent。
test("文本框内表格、格式、公式、编号及嵌套文本框可导出后重新导入", async () => {
  const numbering = `<w:numbering xmlns:w="${WORD_XML}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`
  const content = `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>编号三</w:t></w:r></w:p><w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p><w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>${paragraph("单元格")}${anchor(box(paragraph("内层")))}</w:tc></w:tr></w:tbl>`
  const result = await read(await makeFile(anchor(box(content)), { "word/numbering.xml": numbering }))
  const exported = await createDocumentDocx(result.record.document, result.record.assets)
  const restored = await read(new Uint8Array(await exported.blob.arrayBuffer()))
  for (const { record } of [result, restored]) {
    assert.equal(getText(record.document.content), "编号三单元格内层")
    assert.equal(getNodes(record.document.content, "orderedList")[0].attrs.start, 3)
    assert.ok(getNodes(record.document.content, "text")[0].marks.some(mark => mark.type === "bold"))
    assert.equal(getNodes(record.document.content, "inlineMath")[0].attrs.latex, "x")
    assert.equal(getNodes(record.document.content, "table").length, 1)
  }
})

// 相同图片重复引用应去重资产却保留两处显示位置；与现代图片比较字节保证未把旧表示误转为截图。
test("旧式内嵌图片保留字节、与文本框的先后顺序及去重，再导出不丢图片", async () => {
  const result = await read(await makeFile(anchor(image + box(paragraph("中间")) + image)))
  const exported = await createDocumentDocx(result.record.document, result.record.assets)
  const restored = await read(new Uint8Array(await exported.blob.arrayBuffer()))
  const modern = await read(new Uint8Array(SOURCE))
  const hash = async record => createHash("sha256").update(new Uint8Array(await [...record.assets.values()][0].blob.arrayBuffer())).digest("hex")
  for (const { record } of [result, restored]) {
    const visible = record.document.content.content.filter(node => node.type !== "paragraph" || getText(node))
    assert.deepEqual(visible.map(node => node.type), ["image", "paragraph", "image"])
    assert.equal(getText(visible[1]), "中间")
    assert.equal(record.assets.size, 1)
    assert.equal(await hash(record), await hash(modern.record))
  }
  assert.equal(CLOSED, CREATED)
})

// 即使旁边已有可导图片，未知矢量/艺术字仍须拒绝，不能用部分成功掩盖其余对象丢失。
test("纯矢量图形、艺术字和图片旁的未支持图形不能静默丢失", async () => {
  for (const content of ["<w:pict><v:rect/></w:pict>", '<w:pict><v:shape><v:textpath string="艺术字"/></v:shape></w:pict>', image + "<w:pict><v:group><v:shape/></v:group></w:pict>"]) {
    await assert.rejects(read(await makeFile(anchor(content))), /纯矢量图形|艺术字/)
  }
})

// 从 VML 引用字段、关系表到内嵌目标分别检查，任何一层无效都不交付缺图文档。
test("旧式图片缺失关系、引用不存在或外链时拒绝，不返回残缺记录", async () => {
  await assert.rejects(read(await makeFile(anchor(image.replace(`r:id="${IMAGE_ID}"`, "")))), /内嵌资源引用/)
  await assert.rejects(read(await makeFile(anchor(image.replace(IMAGE_ID, "missing")))))
  const relations = await ORIGINAL.file("word/_rels/document.xml.rels").async("string")
  const external = relations.replace(`Id="${IMAGE_ID}"`, `Id="${IMAGE_ID}" TargetMode="External"`)
  await assert.rejects(read(await makeFile(anchor(image), { "word/_rels/document.xml.rels": external })), /外部图片/)
})

// 只支持可确认的 Fallback 和 VML 文字结构，DrawingML 文本框或不完整壳不能交给 Mammoth 静默忽略。
test("没有兼容分支的对象、未识别文本框及不完整文本框明确拒绝", async () => {
  const contents = [
    `<mc:AlternateContent><mc:Choice Requires="wps">${box(paragraph("文本"))}</mc:Choice></mc:AlternateContent>`,
    `<w:drawing><wps:txbx><w:txbxContent>${paragraph("文本")}</w:txbxContent></wps:txbx></w:drawing>`,
    "<w:pict><v:shape><v:textbox><div>非 Word 正文</div></v:textbox></v:shape></w:pict>"
  ]
  for (const content of contents) await assert.rejects(read(await makeFile(anchor(content))), /兼容表示|文本框/)
})

// 嵌在文本框中的修订仍有独立语义；无正文引用的非空页内容也不能因为只有图片而漏检。
test("文本框中的修订和仅含旧式图片的页眉仍明确拒绝", async () => {
  await assert.rejects(read(await makeFile(anchor(box(`<w:p><w:ins>${text("修订")}</w:ins></w:p>`)))), /插入修订/)
  for (const kind of ["header", "footer"]) {
    await assert.rejects(read(await makeFile(paragraph("正文"), { [`word/${kind}1.xml`]: `<w:${kind === "header" ? "hdr" : "ftr"} ${NS}>${anchor(image)}</w:${kind === "header" ? "hdr" : "ftr"}>` })), /页眉、页脚/)
  }
})
