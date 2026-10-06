/** 页面导入测试直接读取正式导出 XML，并覆盖 Word 可表达但 Mewoc 无法完整恢复的合法边界。 */
import test from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { readDocxPageSettings } from "../src/pages/editor/tools/docx-import-page.js"
import { readDocxXml, writeDocxXml, WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"
import { PAGE_SIZES, getPageDimensions, validatePageSettings } from "../src/pages/editor/tools/page-settings.js"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"

const EMPTY = { size: "A4", orientation: "portrait", marginsMm: { top: 20, right: 20, bottom: 20, left: 20 } }
const twips = mm => Math.round(mm * 1440 / 25.4)
const sizeXml = (width = 210, height = 297, extra = "") => `<w:pgSz w:w="${twips(width)}" w:h="${twips(height)}"${extra}/>`
const marginsXml = (extra = "") => `<w:pgMar w:top="720" w:right="1440" w:bottom="1080" w:left="567"${extra}/>`
const section = (properties = "") => `<w:sectPr>${properties}</w:sectPr>`
const paragraph = properties => `<w:p><w:pPr>${properties || ""}</w:pPr><w:r><w:t>保留的正文</w:t></w:r></w:p>`
const xml = body => readDocxXml(`<w:document xmlns:w="${WORD_XML}"><w:body>${body}</w:body></w:document>`, "page-test.xml")
const parse = body => {
  const document = xml(body)
  const before = writeDocxXml(document)
  const warnings = new Set()
  const page = readDocxPageSettings(document, warnings)
  assert.equal(writeDocxXml(document), before, "解析器不修改 XML")
  assert.equal(validatePageSettings(page), page)
  assert.equal(Object.hasOwn(page, "watermark"), false)
  return { page, warnings: [...warnings] }
}
const exportPage = async page => {
  const source = { ...createDocument(), page, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "页面往返正文" }] }] } }
  const before = structuredClone(source)
  const { blob } = await createDocumentDocx(source, new Map())
  assert.deepEqual(source, before)
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  return readDocxXml(await zip.file("word/document.xml").async("string"), "word/document.xml")
}

test("正式导出的 A3/A4/A5/Letter 横竖纸张回到共享精确尺寸，非对称边距保留且 XML 不变", async () => {
  for (const size of Object.keys(PAGE_SIZES)) for (const orientation of ["portrait", "landscape"]) {
    const source = { size, orientation, marginsMm: { top: 12.7, right: 25.4, bottom: 18.35, left: 20 } }
    const document = await exportPage(source)
    const before = writeDocxXml(document), warnings = new Set()
    const restored = readDocxPageSettings(document, warnings)
    assert.equal(restored.size, size)
    assert.equal(restored.orientation, orientation)
    assert.deepEqual(getPageDimensions(restored), getPageDimensions(source))
    for (const side of Object.keys(source.marginsMm)) assert.ok(Math.abs(restored.marginsMm[side] - source.marginsMm[side]) <= 25.4 / 1440)
    assert.deepEqual([...warnings], [])
    assert.equal(writeDocxXml(document), before)
  }
})

test("没有节元数据、空节与只有部分属性的旧文件使用独立兼容默认值", () => {
  for (const body of [paragraph(), paragraph() + section(), paragraph() + section("<w:pgSz/><w:pgMar/>")]) {
    const result = parse(body)
    assert.deepEqual(result.page, EMPTY)
    assert.deepEqual(result.warnings, [])
  }
  const first = parse(paragraph()).page, second = parse(paragraph()).page
  first.marginsMm.top = 50
  assert.deepEqual(second, EMPTY)
  assert.equal(parse(section('<w:pgMar w:left="720"/>')).page.marginsMm.left, 12.7)
  assert.equal(parse(section('<w:pgSz w:orient="landscape"/>')).page.orientation, "landscape")
})

test("Word 常见 A4 的 1 twip 纸面差异归一到 A4，未知的邻近尺寸不被吞掉", () => {
  assert.equal(parse(section('<w:pgSz w:w="11907" w:h="16839"/>')).page.size, "A4")
  const result = parse(section('<w:pgSz w:w="11908" w:h="16839"/>'))
  assert.equal(result.page.size, "A4")
  assert.match(result.warnings.join("\n"), /纸张.*暂不支持.*A4/)
})

test("无方向标记时按实际宽高恢复横版，冲突的合法方向标记有明确提示", () => {
  const inferred = parse(section(sizeXml(297, 210)))
  assert.equal(inferred.page.orientation, "landscape")
  assert.deepEqual(inferred.warnings, [])
  const conflict = parse(section(sizeXml(210, 297, ' w:orient="landscape"')))
  assert.equal(conflict.page.orientation, "portrait")
  assert.match(conflict.warnings.join("\n"), /方向标记.*不一致.*实际宽高/)
})

test("相同有效多节保留全局配置，不把最后一节覆盖首节，也不把修订历史计作新节", () => {
  const properties = sizeXml(210, 148, ' w:orient="landscape"') + marginsXml()
  const result = parse(paragraph(section(properties)) + paragraph() + section(properties))
  assert.equal(result.page.size, "A5")
  assert.equal(result.page.orientation, "landscape")
  assert.deepEqual(result.warnings, [])
  const history = '<w:sectPrChange><w:sectPr><w:pgSz w:w="0" w:h="wrong"/></w:sectPr></w:sectPrChange>'
  const historic = parse(paragraph() + section(properties + history))
  assert.deepEqual(historic.page, result.page)
  assert.deepEqual(historic.warnings, [])
})

test("不同有效多节采用第一节并报告差异，后节缺省不从首节盲目继承", () => {
  const first = sizeXml(148, 210) + marginsXml()
  for (const last of [sizeXml(297, 420) + marginsXml(), sizeXml(148, 210) + '<w:pgMar w:left="720"/>', ""]) {
    const result = parse(paragraph(section(first)) + paragraph() + section(last))
    assert.equal(result.page.size, "A5")
    assert.equal(result.page.marginsMm.left, 10)
    assert.match(result.warnings.join("\n"), /不同的分节.*第一节/)
  }
})

test("同一受支持纸型的 1 twip 编码差异不伪造混合节提示，错误修订容器不能藏匿元数据", () => {
  const first = sizeXml(), last = '<w:pgSz w:w="11907" w:h="16839"/>'
  assert.deepEqual(parse(paragraph(section(first)) + paragraph() + section(last)).warnings, [])
  for (const body of [
    '<w:sectPrChange><w:sectPr><w:pgSz w:w="wrong"/></w:sectPr></w:sectPrChange>',
    section('<w:sectPrChange><w:pgSz w:w="wrong"/></w:sectPrChange>'),
    section("<w:sectPrChange><w:sectPr/><w:sectPr/></w:sectPrChange>"),
    section("<w:sectPrChange><w:sectPr><w:sectPrChange><w:sectPr/></w:sectPrChange></w:sectPr></w:sectPrChange>")
  ]) assert.throws(() => parse(body), /页面设置.*修订/)
})

test("不同未知纸张都回退 A4 时仍报告原始节配置差异，合法横版未知纸张保留方向", () => {
  const result = parse(paragraph(section(sizeXml(320, 200))) + paragraph() + section(sizeXml(330, 200)))
  assert.equal(result.page.size, "A4")
  assert.equal(result.page.orientation, "landscape")
  assert.equal(result.warnings.filter(text => text.includes("纸张") && text.includes("暂不支持")).length, 2)
  assert.match(result.warnings.join("\n"), /不同的分节.*第一节/)
})

test("合法负上下边距与超大边距回退到 20 mm，装订线有独立损失提示", () => {
  for (const properties of ['<w:pgMar w:top="-720"/>', '<w:pgMar w:bottom="-1"/>']) {
    const result = parse(section(sizeXml(148, 210) + properties))
    assert.equal(result.page.size, "A5")
    assert.deepEqual(result.page.marginsMm, EMPTY.marginsMm)
    assert.match(result.warnings.join("\n"), /负页边距.*20 mm/)
  }
  const tooLarge = parse(section(sizeXml(148, 210) + '<w:pgMar w:left="12000"/>'))
  assert.deepEqual(tooLarge.page.marginsMm, EMPTY.marginsMm)
  assert.match(tooLarge.warnings.join("\n"), /至少 40 mm.*20 mm/)
  const gutter = parse(section(sizeXml() + marginsXml(' w:gutter="144" w:header="720" w:footer="720"')))
  assert.equal(gutter.page.marginsMm.top, 12.7)
  assert.match(gutter.warnings.join("\n"), /装订线未恢复/)
})

test("正式导出的合法 40 mm 正文边界不会回退默认边距，重复往返保持稳定", async () => {
  for (const marginsMm of [
    { top: 20, bottom: 20, left: 144.6, right: 25.4 },
    { top: 1, bottom: 256, left: 1, right: 169 },
    { top: 20, bottom: 20, left: 80.006, right: 89.994 }
  ]) {
    const source = { size: "A4", orientation: "portrait", marginsMm }
    const firstWarnings = new Set()
    const first = readDocxPageSettings(await exportPage(source), firstWarnings)
    assert.equal(first.size, "A4")
    assert.ok(first.marginsMm.left + first.marginsMm.right <= 170)
    assert.ok(first.marginsMm.top + first.marginsMm.bottom <= 257)
    for (const side of Object.keys(marginsMm)) assert.ok(Math.abs(first.marginsMm[side] - marginsMm[side]) <= 25.4 / 1440, `${side} 量化不超过 1 twip`)
    assert.ok(![...firstWarnings].some(text => text.includes("改用 20")))
    const next = readDocxPageSettings(await exportPage(first), new Set())
    const third = readDocxPageSettings(await exportPage(next), new Set())
    assert.deepEqual(next, first)
    assert.deepEqual(third, first)
  }
})

test("合法整数的空白、正号与零边距接受，0 不被错误替换成默认值", () => {
  const result = parse(section('<w:pgSz w:w=" +11906 " w:h="16838" w:code="+9"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:gutter="0"/>'))
  assert.deepEqual(result.page.marginsMm, { top: 0, right: 0, bottom: 0, left: 0 })
  assert.deepEqual(result.warnings, [])
})

test("纸张和页边距损坏数字、非法方向及非法负值整份拒绝，不由默认值掩盖", () => {
  for (const value of ["", " ", "NaN", "Infinity", "1e3", "0x123", "1.5", "1pt", "9007199254740993", "4294967296"]) {
    for (const property of [`<w:pgSz w:w="${value}"/>`, `<w:pgMar w:left="${value}"/>`]) assert.throws(() => parse(section(property)), /数字无效/)
  }
  for (const property of ['<w:pgSz w:w="0"/>', '<w:pgSz w:h="-1"/>', '<w:pgSz w:code="-1"/>', '<w:pgMar w:left="-1"/>', '<w:pgMar w:right="-1"/>', '<w:pgMar w:header="-1"/>', '<w:pgMar w:gutter="-1"/>']) {
    assert.throws(() => parse(section(property)), /数字无效/)
  }
  for (const orientation of ["", "Landscape", "unknown"]) assert.throws(() => parse(section(`<w:pgSz w:orient="${orientation}"/>`)), /方向无效/)
})

test("纸面关键元素重复、错位、异常内容和伪命名空间属性拒绝", () => {
  for (const body of [section(sizeXml() + sizeXml()), section(marginsXml() + marginsXml()), section() + section(), section() + paragraph(),
    paragraph('<w:pgSz w:w="11906"/>'), paragraph() + '<w:pgMar w:left="720"/>', paragraph(section() + section()),
    "<w:p><w:r><w:sectPr/></w:r></w:p>", "<w:tbl><w:tr><w:tc>" + paragraph(section()) + "</w:tc></w:tr></w:tbl>",
    section("<w:pgSz>hidden</w:pgSz>"), section("<w:pgMar><w:t>hidden</w:t></w:pgMar>"),
    section('<w:pgSz w="11906"/>'), section('<w:pgMar w:onclick="alert(1)"/>'),
    section('<fake:pgSz xmlns:fake="urn:fake" fake:w="11906"/>'), section('<w:pgSz xmlns:x="urn:fake" x:w="11906"/>')]) {
    assert.throws(() => parse(body), /页面设置|页边距|纸张/)
  }
})

test("命名空间前缀可替换，主文档缺失或重复 body 不会被当作旧文档接受", () => {
  const document = xml(paragraph() + section(sizeXml(148, 210))).toString().replaceAll("xmlns:w", "xmlns:word").replaceAll("w:", "word:")
  const restored = readDocxPageSettings(readDocxXml(document, "prefix.xml"), new Set())
  assert.equal(restored.size, "A5")
  for (const source of [`<w:document xmlns:w="${WORD_XML}"/>`, `<w:document xmlns:w="${WORD_XML}"><w:body/><w:body/></w:document>`, "<document><body/></document>"]) {
    assert.throws(() => readDocxPageSettings(readDocxXml(source, "invalid.xml"), new Set()), /正文结构|主文档/)
  }
})
