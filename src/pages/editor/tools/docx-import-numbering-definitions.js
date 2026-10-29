/** 唯一编号定义及有效层级覆盖；未知计数语义不能靠取首项或默认值猜测。 */
import { getXmlChildren, getWordChild, WORD_XML } from "./docx-import-xml.js"

const FORMATS = { decimal: "1", lowerLetter: "a", upperLetter: "A", lowerRoman: "i", upperRoman: "I", bullet: "bullet" }
const invalid = () => new Error("Word 列表编号定义无效或包含暂不支持的编号语义，请保留原 DOCX")

export function createDocxNumberingReader(numbering) {
  const abstracts = index(numbering?.documentElement, "abstractNum", "abstractNumId")
  const instances = index(numbering?.documentElement, "num", "numId")
  const cache = new Map()
  return (id, depth) => {
    const key = `${id}:${depth}`
    if (cache.has(key)) return cache.get(key)
    const instance = unique(instances.get(id))
    checkChildren(instance, ["abstractNumId", "lvlOverride"])
    const abstract = unique(abstracts.get(value(instance, "abstractNumId")))
    checkChildren(abstract, ["nsid", "multiLevelType", "tmpl", "name", "styleLink", "lvl"])
    const overrides = index(instance, "lvlOverride", "ilvl")
    const override = overrides.has(String(depth)) ? unique(overrides.get(String(depth))) : undefined
    if (override) checkChildren(override, ["startOverride", "lvl"])
    const levels = index(abstract, "lvl", "ilvl")
    const entry = getWordChild(override, "lvl") || unique(levels.get(String(depth)))
    if (entry.getAttributeNS(WORD_XML, "ilvl") !== String(depth)) throw invalid()
    checkChildren(entry, ["start", "numFmt", "lvlRestart", "pStyle", "suff", "lvlText", "lvlJc", "pPr", "rPr"])
    const format = FORMATS[value(entry, "numFmt")]
    const origin = value(override, "startOverride") ?? value(entry, "start")
    const start = integer(origin ?? "1")
    const restart = integer(value(entry, "lvlRestart") ?? String(depth))
    if (!format || restart > depth) throw invalid()
    const text = value(entry, "lvlText")
    const suffix = value(entry, "suff") ?? "tab"
    if (!["tab", "space", "nothing"].includes(suffix)) throw invalid()
    const simple = format === "bullet" || text === `%${depth + 1}.` || text === `%${depth + 1})`
    if (!simple) readReferences(text, depth)
    const result = { entry, abstract, instance, override, format, start, origin, restart, text, suffix, simple }
    cache.set(key, result)
    return result
  }
}

export function readCompositeNumbering(entry, depth) {
  if (entry.format !== "1") throw new Error("组合静态编号暂仅支持十进制层级，字母、罗马或项目符号不能猜测转换")
  validateDocxNumberingSemantics(entry)
  return readReferences(entry.text, depth)
}

/** 静态条款及自有字母分段都依赖实际可见计数，不能忽略 Word 专用重启或隐藏语义。 */
export function validateDocxNumberingSemantics(entry) {
  // Word 对覆盖层里的 lvlRestart 与标准文本有差异，未确定的组合不能产生貌似正确的静态条款号。
  // https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/140a2cd9-2f26-456d-9760-ae6ecef4e8b5
  if (entry.entry.parentNode === entry.override && getWordChild(entry.entry, "lvlRestart")) throw invalid()
  for (const [node, name] of [[entry.instance, "numId"], [entry.override, "ilvl"]]) {
    if (node && Array.from(node.attributes || []).some(attribute =>
      attribute.namespaceURI !== "http://www.w3.org/2000/xmlns/" &&
      !(node === entry.instance && attribute.namespaceURI === "http://schemas.microsoft.com/office/word/2016/wordml/cid" &&
        attribute.localName === "durableId" && /^\d+$/.test(attribute.value) && Number(attribute.value) <= 2147483647) &&
      (attribute.namespaceURI !== WORD_XML || attribute.localName !== name))) throw invalid()
  }
  for (const attribute of Array.from(entry.entry.attributes || [])) {
    if (attribute.namespaceURI === "http://www.w3.org/2000/xmlns/") continue
    if (attribute.namespaceURI === WORD_XML && attribute.localName === "ilvl") continue
    if (attribute.namespaceURI === WORD_XML && attribute.localName === "tplc" && /^[a-f\d]{8}$/i.test(attribute.value)) continue
    if ([WORD_XML, "http://schemas.microsoft.com/office/word/2012/wordml"].includes(attribute.namespaceURI) &&
      attribute.localName === "tentative" && ["0", "1", "false", "true", "off", "on"].includes(attribute.value)) continue
    throw invalid()
  }
  for (const name of ["vanish", "webHidden", "specVanish"]) {
    const hidden = getWordChild(getWordChild(entry.entry, "rPr"), name)
    if (hidden && !["0", "false", "off"].includes(hidden.getAttributeNS(WORD_XML, "val"))) throw invalid()
  }
  // Office 的节后重启扩展会改变跨节计数；本路径尚未解释，不能无声忽略启用状态。
  for (const attribute of Array.from(entry.abstract.attributes || [])) {
    if (attribute.localName === "abstractNumId" && attribute.namespaceURI === WORD_XML) continue
    if (attribute.namespaceURI === "http://www.w3.org/2000/xmlns/") continue
    if (attribute.localName !== "restartNumberingAfterBreak" ||
      attribute.namespaceURI !== "http://schemas.microsoft.com/office/word/2012/wordml" ||
      !["0", "false", "off"].includes(attribute.value)) throw invalid()
  }
}

function readReferences(text, depth) {
  if (!text || text.length > 200 || /[\u0000-\u001f]/.test(text)) throw invalid()
  const references = Array.from(text.matchAll(/%([1-9])(?!\d)/g), match => Number(match[1]) - 1)
  if (!references.length || text.replace(/%[1-9](?!\d)/g, "").includes("%") || references.some(level => level > depth)) throw invalid()
  return references
}

function index(parent, name, attribute) {
  const result = new Map()
  for (const node of getXmlChildren(parent).filter(child => child.namespaceURI === WORD_XML && child.localName === name)) {
    const id = node.getAttributeNS(WORD_XML, attribute)
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw invalid()
    if (!result.has(id)) result.set(id, [])
    result.get(id).push(node)
  }
  return result
}

function unique(nodes) {
  if (nodes?.length !== 1) throw invalid()
  return nodes[0]
}

function checkChildren(node, names) {
  const seen = new Set()
  for (const child of getXmlChildren(node)) {
    if (child.namespaceURI !== WORD_XML || !names.includes(child.localName) ||
      seen.has(child.localName) && !["lvl", "lvlOverride"].includes(child.localName)) throw invalid()
    seen.add(child.localName)
  }
  if (Array.from(node.childNodes).some(child => [3, 4].includes(child.nodeType) && child.textContent.trim())) throw invalid()
  if (node.localName === "lvlOverride" && getXmlChildren(node).filter(child => child.localName === "lvl").length > 1) throw invalid()
}

function value(parent, name) {
  const nodes = getXmlChildren(parent).filter(child => child.namespaceURI === WORD_XML && child.localName === name)
  if (!nodes.length) return undefined
  const node = unique(nodes)
  const attributes = Array.from(node.attributes).filter(attribute => attribute.namespaceURI !== "http://www.w3.org/2000/xmlns/")
  if (attributes.length !== 1 || attributes[0].namespaceURI !== WORD_XML || attributes[0].localName !== "val" ||
    getXmlChildren(node).length || node.textContent.trim()) throw invalid()
  return node.getAttributeNS(WORD_XML, "val")
}

function integer(value) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid()
  return Number(value)
}
