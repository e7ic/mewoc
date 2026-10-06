/**
 * DOCX XML 的统一读写边界：按命名空间识别 Word/公式元素，不依赖文件中选择的前缀。
 * 解析时拒绝实体声明、语法错误以及超限结构；其余模块只操作通过检查的 XML DOM。
 */
import { DOMParser, XMLSerializer } from "@xmldom/xmldom"

// 固定 OOXML 命名空间 URI；w:、m: 等前缀可变化，URI 才是判断节点语义的依据。
export const WORD_XML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
export const MATH_XML = "http://schemas.openxmlformats.org/officeDocument/2006/math"

// Worker 没有浏览器 DOMParser；统一使用固定版本 XML 解析器，并把可恢复的语法错误也视为失败。
export function readDocxXml(source, name) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("Word 文件不能包含 XML 实体声明")
  let invalid = false
  const parser = new DOMParser({ errorHandler: {
    warning: () => { invalid = true }, error: () => { invalid = true }, fatalError: () => { invalid = true }
  } })
  const xml = parser.parseFromString(source, "application/xml")
  if (invalid || !xml?.documentElement) throw new Error(`Word 文件结构无法读取：${name}`)
  // 用显式栈遍历元素，限制结构深度与元素总数，避免恶意 XML 让递归或内存消耗失控。
  const stack = [[xml.documentElement, 0]]
  let count = 0
  while (stack.length) {
    const [node, depth] = stack.pop()
    count += 1
    if (depth > 64 || count > 100000) throw new Error("Word 文件结构过深或节点过多")
    for (const child of getXmlChildren(node)) stack.push([child, depth + 1])
  }
  return xml
}

/** 只取直接子元素，忽略空白、注释与文本；缺失父节点时返回空数组便于可选属性读取。 */
export function getXmlChildren(node) {
  return Array.from(node?.childNodes || []).filter(child => child.nodeType === 1)
}

/** 按 Word 命名空间取第一个同名直接子元素，避免误读嵌套节点或其它格式的同名元素。 */
export function getWordChild(node, name) {
  return getXmlChildren(node).find(child => child.namespaceURI === WORD_XML && child.localName === name)
}

/** 读取 Word 属性元素的 w:val；未声明返回 undefined，保留显式的 "0" 或空字符串。 */
export function getWordValue(node, name) {
  const child = getWordChild(node, name)
  return child?.hasAttributeNS(WORD_XML, "val") ? child.getAttributeNS(WORD_XML, "val") : undefined
}

/** 将经过规范化的 XML DOM 序列化回归档部件，交给后续 Mammoth 转换。 */
export function writeDocxXml(xml) {
  return new XMLSerializer().serializeToString(xml)
}
