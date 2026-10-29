/** Word 回存添加的行级布局例外：仅降级已验证的零边距，未知结构不能被 Mammoth 静默忽略。 */
import { getXmlChildren, WORD_XML } from "./docx-import-xml.js"

const XMLNS_XML = "http://www.w3.org/2000/xmlns/"
const invalid = () => new Error("Word 表格行级布局包含暂不能可靠转换的结构，请保留原 DOCX")

export function normalizeDocxTableExceptions(xml, warnings) {
  const exceptions = Array.from(xml.getElementsByTagNameNS(WORD_XML, "tblPrEx"))
  for (const exception of exceptions) {
    const row = exception.parentNode
    if (!isWord(row, "tr") || !isWord(row.parentNode, "tbl") ||
      getXmlChildren(row).filter(node => isWord(node, "tblPrEx")).length !== 1 ||
      !attributes(exception, {}) || !children(exception, ["tblCellMar"])) throw invalid()
    const margins = getXmlChildren(exception)[0]
    if (!attributes(margins, {}) || !children(margins, ["top", "bottom"])) throw invalid()
    for (const margin of getXmlChildren(margins)) {
      if (!attributes(margin, { w: "0", type: "dxa" }) || !children(margin, [])) throw invalid()
    }
  }
  // 两份 Word 16 原生样本均产生 top/bottom=0 dxa；其余例外仍拒绝，不能扩大为任意属性丢弃。
  for (const exception of exceptions) exception.parentNode.removeChild(exception)
  if (exceptions.length) warnings.add("Word 表格的行级单元格边距使用编辑器默认值；正文、单元格及合并结构保留")
}

function attributes(node, expected) {
  const actual = Array.from(node.attributes || []).filter(attribute => attribute.namespaceURI !== XMLNS_XML)
  return actual.length === Object.keys(expected).length && actual.every(attribute =>
    attribute.namespaceURI === WORD_XML && expected[attribute.localName] === attribute.value)
}

function children(node, expected) {
  const actual = getXmlChildren(node)
  return actual.length === expected.length && actual.every((child, index) => isWord(child, expected[index])) &&
    !Array.from(node.childNodes).some(child => [3, 4].includes(child.nodeType) && child.textContent.trim())
}

const isWord = (node, name) => node?.namespaceURI === WORD_XML && node.localName === name
