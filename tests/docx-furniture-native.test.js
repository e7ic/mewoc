/** 原生 Word 样式继承不能绕过自有页眉页脚的严格结构校验。 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import JSZip from "jszip"
import { extractDocxPageFurniture } from "../src/pages/editor/tools/docx-import-furniture.js"
import { readDocxXml, writeDocxXml, getWordChild, WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"

const PAGE = { size: "A5", orientation: "portrait", marginsMm: { top: 15, right: 15, bottom: 15, left: 15 } }
const PACKAGE_XML = "http://schemas.openxmlformats.org/package/2006/relationships"
const REL_XML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const fixture = async (name = "word-resaved.docx") => {
  const zip = await JSZip.loadAsync(await readFile(new URL(`../docs/m25-word-roundtrip-evidence/${name}`, import.meta.url)))
  const parts = new Map()
  for (const part of zip.file(/\.(xml|rels)$/)) parts.set(part.name, readDocxXml(await part.async("string"), part.name))
  const styles = parts.get("word/styles.xml")
  const defaults = getWordChild(styles.documentElement, "docDefaults")
  return {
    parts, styles, defaults,
    runs: getWordChild(getWordChild(defaults, "rPrDefault"), "rPr"),
    paragraphs: getWordChild(getWordChild(defaults, "pPrDefault"), "pPr")
  }
}
const read = value => extractDocxPageFurniture(value.parts, PAGE, new Set())
const append = (parent, name, attributes = {}) => {
  const node = parent.ownerDocument.createElementNS(WORD_XML, `w:${name}`)
  for (const [key, value] of Object.entries(attributes)) node.setAttributeNS(WORD_XML, `w:${key}`, value)
  parent.appendChild(node)
  return node
}
const defaultStyle = (value, type) => Array.from(value.styles.getElementsByTagNameNS(WORD_XML, "style"))
  .find(node => node.getAttributeNS(WORD_XML, "default") === "1" && node.getAttributeNS(WORD_XML, "type") === type)
const styleRelation = value => Array.from(value.parts.get("word/_rels/document.xml.rels").getElementsByTagNameNS(PACKAGE_XML, "Relationship"))
  .find(node => node.getAttribute("Type") === `${REL_XML}/styles`)

test("三份原生 Word 样本按已验证的文档默认值恢复页眉页脚", async () => {
  for (const name of ["word-resaved.docx", "word-fields-updated.docx", "recheck/word-resaved.docx"]) {
    const value = await fixture(name)
    const result = read(value)
    assert.deepEqual(result.header, { text: "M25 持续验收", alignment: "left", pageNumber: "page" })
    assert.deepEqual(result.footer, { text: "原始文档与资源", alignment: "center", pageNumber: "page-total" })
  }
})

test("Word 完全省略 run 字体时必须能从默认值明确恢复三类字体，不从主题或缺失值猜测", async () => {
  for (const change of [
    fonts => fonts.removeAttributeNS(WORD_XML, "ascii"),
    fonts => fonts.removeAttributeNS(WORD_XML, "hAnsi"),
    fonts => fonts.removeAttributeNS(WORD_XML, "eastAsia"),
    fonts => fonts.setAttributeNS(WORD_XML, "w:eastAsia", "SimSun"),
    fonts => fonts.setAttributeNS(WORD_XML, "w:eastAsiaTheme", "minorEastAsia"),
    fonts => fonts.setAttributeNS(WORD_XML, "w:asciiTheme", "majorHAnsi")
  ]) {
    const value = await fixture("recheck/word-resaved.docx")
    change(getWordChild(value.runs, "rFonts"))
    assert.throws(() => read(value), /页眉、页脚或页码结构无法可靠恢复/)
  }
})

test("原生默认字体、粗体、对齐或段前距被覆盖时拒绝，保留原控件", async () => {
  for (const change of [
    value => getWordChild(value.runs, "rFonts").setAttributeNS(WORD_XML, "w:ascii", "Calibri"),
    value => append(value.runs, "b"),
    value => append(value.paragraphs, "jc", { val: "right" }),
    value => getWordChild(value.paragraphs, "spacing").setAttributeNS(WORD_XML, "w:before", "240"),
    value => getWordChild(value.paragraphs, "spacing").setAttributeNS(WORD_XML, "w:beforeLines", "100"),
    value => getWordChild(value.paragraphs, "spacing").setAttributeNS(WORD_XML, "w:beforeAutospacing", "1"),
    value => append(append(defaultStyle(value, "paragraph"), "rPr"), "b"),
    value => append(getWordChild(defaultStyle(value, "paragraph"), "pPr"), "jc", { val: "center" }),
    value => append(append(defaultStyle(value, "character"), "rPr"), "b")
  ]) {
    const value = await fixture()
    change(value)
    const header = writeDocxXml(value.parts.get("word/header1.xml"))
    assert.throws(() => read(value), /页眉、页脚或页码结构无法可靠恢复/)
    assert.equal(writeDocxXml(value.parts.get("word/header1.xml")), header)
  }
})

test("默认样式和继承容器重复时拒绝，不能只读取首个", async () => {
  for (const select of [
    value => value.defaults,
    value => getWordChild(value.defaults, "rPrDefault"),
    value => getWordChild(value.defaults, "pPrDefault"),
    value => value.runs,
    value => value.paragraphs,
    value => getWordChild(value.runs, "rFonts"),
    value => defaultStyle(value, "paragraph"),
    value => defaultStyle(value, "character"),
    value => getWordChild(defaultStyle(value, "paragraph"), "pPr"),
    value => append(defaultStyle(value, "character"), "rPr")
  ]) {
    const value = await fixture()
    const node = select(value)
    node.parentNode.appendChild(node.cloneNode(true))
    assert.throws(() => read(value), /页眉、页脚或页码结构无法可靠恢复/)
  }
})

test("继承叶子中的未知属性、节点或文字不能作为无害默认值忽略", async () => {
  for (const change of [
    value => append(getWordChild(value.runs, "rFonts"), "b"),
    value => getWordChild(value.runs, "rFonts").setAttributeNS(WORD_XML, "w:asciiTheme", "majorHAnsi"),
    value => getWordChild(value.runs, "color").setAttributeNS(WORD_XML, "w:themeColor", "accent1"),
    value => append(getWordChild(value.runs, "sz"), "b"),
    value => append(getWordChild(value.runs, "szCs"), "b"),
    value => getWordChild(value.runs, "lang").appendChild(value.styles.createTextNode("不能丢失")),
    value => append(getWordChild(value.paragraphs, "spacing"), "jc", { val: "right" }),
    value => append(getWordChild(getWordChild(defaultStyle(value, "paragraph"), "pPr"), "widowControl"), "spacing"),
    value => append(defaultStyle(value, "paragraph"), "tblPr"),
    value => append(value.defaults, "unknown")
  ]) {
    const value = await fixture()
    change(value)
    assert.throws(() => read(value), /页眉、页脚或页码结构无法可靠恢复/)
  }
})

test("原生字体继承跟随真实样式关系，不信固定路径的未引用副本", async () => {
  for (const target of ["actual-styles.xml", "/word/actual-styles.xml", "./unused/../actual-styles.xml"]) {
    const value = await fixture()
    styleRelation(value).setAttribute("Target", target)
    value.parts.set("word/actual-styles.xml", value.styles.cloneNode(true))
    getWordChild(value.runs, "rFonts").setAttributeNS(WORD_XML, "w:ascii", "Calibri")
    assert.equal(read(value).header.text, "M25 持续验收")
  }
  const value = await fixture()
  styleRelation(value).setAttribute("Target", "actual-styles.xml")
  const actual = readDocxXml(writeDocxXml(value.styles).replaceAll('w:ascii="Arial"', 'w:ascii="Calibri"'), "actual styles")
  value.parts.set("word/actual-styles.xml", actual)
  const header = writeDocxXml(value.parts.get("word/header1.xml"))
  assert.throws(() => read(value), /页眉、页脚或页码结构无法可靠恢复/)
  assert.equal(writeDocxXml(value.parts.get("word/header1.xml")), header)
})

test("原生样式关系缺失、重复、错误目标或错根均拒绝，显式 canonical 格式不强加继承依赖", async () => {
  for (const change of [
    (value, relation) => relation.parentNode.removeChild(relation),
    (value, relation) => relation.parentNode.appendChild(relation.cloneNode(true)),
    (value, relation) => { const duplicate = relation.cloneNode(true); duplicate.setAttribute("Id", "anotherStyles"); relation.parentNode.appendChild(duplicate) },
    (value, relation) => { const duplicate = relation.cloneNode(true); duplicate.setAttribute("Type", `${REL_XML}/unknown`); relation.parentNode.appendChild(duplicate) },
    (value, relation) => relation.removeAttribute("Id"),
    (value, relation) => relation.setAttribute("Target", "missing.xml"),
    (value, relation) => relation.setAttribute("Target", "../../outside.xml"),
    (value, relation) => relation.setAttribute("TargetMode", "External"),
    value => value.parts.set("word/styles.xml", readDocxXml(`<w:settings xmlns:w="${WORD_XML}"/>`, "wrong styles root"))
  ]) {
    const value = await fixture()
    change(value, styleRelation(value))
    assert.throws(() => read(value), /页眉、页脚|资源关系/)
  }
  const canonical = await fixture("../m25-native-evidence/browser-export.docx")
  const relation = styleRelation(canonical)
  relation.parentNode.removeChild(relation)
  canonical.parts.delete("word/styles.xml")
  assert.equal(read(canonical).header.text, "M25 持续验收")
})
