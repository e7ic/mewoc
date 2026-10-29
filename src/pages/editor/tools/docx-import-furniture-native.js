/** Word 16 原生回存的等价写法归一化；只修改副本，未知内容留给严格页部件解析拒绝。 */
import { getXmlChildren, getWordChild, WORD_XML } from "./docx-import-xml.js"

const XML_XML = "http://www.w3.org/XML/1998/namespace"
const WORD14_XML = "http://schemas.microsoft.com/office/word/2010/wordml"
const invalid = () => new Error("Mewoc 页眉、页脚或页码结构无法可靠恢复，请保留原 DOCX")

export function normalizeNativeFurniture(control, styles) {
  const copy = control.cloneNode(true)
  const properties = getWordChild(copy, "sdtPr")
  const id = getWordChild(properties, "id")
  if (!id) return copy
  if (!onlyAttributes(id, ["val"]) || getXmlChildren(id).length || id.textContent.trim() ||
    !/^-?\d+$/.test(id.getAttributeNS(WORD_XML, "val")) ||
    Number(id.getAttributeNS(WORD_XML, "val")) < -2147483648 || Number(id.getAttributeNS(WORD_XML, "val")) > 2147483647) throw invalid()
  properties.removeChild(id)
  const defaults = readNativeDefaults(styles)
  const paragraph = getWordChild(getWordChild(copy, "sdtContent"), "p")
  if (!paragraph) throw invalid()
  removeMetadata(paragraph)
  const paragraphFormat = getWordChild(paragraph, "pPr")
  const spacing = getWordChild(paragraphFormat, "spacing")
  if (spacing && !spacing.hasAttributeNS(WORD_XML, "before")) spacing.setAttributeNS(WORD_XML, "w:before", defaults.before)
  if (paragraphFormat && !getWordChild(paragraphFormat, "jc")) paragraphFormat.appendChild(wordLeaf(copy, "jc", "val", defaults.alignment))
  // Word 将 fldSimple 改成 begin/instruction/separate/result/end；只读 PAGE/NUMPAGES，不执行域代码。
  const nodes = getXmlChildren(paragraph).slice(1)
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (isWord(node, "fldSimple")) {
      for (const run of getXmlChildren(node)) normalizeTextRun(run, defaults.fonts)
      continue
    }
    if (!isWord(node, "r")) continue
    if (!getWordChild(node, "fldChar")) {
      normalizeTextRun(node, defaults.fonts)
      continue
    }
    readFieldControl(node, "begin")
    const fieldNodes = [node]
    let instruction = ""
    while (getWordChild(nodes[index + 1], "instrText")) {
      const run = nodes[++index]
      fieldNodes.push(run)
      const text = readFieldRun(run, "instrText")
      if (!textAttributes(text) || getXmlChildren(text).length) throw invalid()
      instruction += text.textContent
    }
    if (!["PAGE", "NUMPAGES"].includes(instruction.trim())) throw invalid()
    readFieldControl(nodes[++index], "separate")
    fieldNodes.push(nodes[index])
    const result = nodes[++index]
    normalizeTextRun(result, defaults.fonts)
    fieldNodes.push(result)
    readFieldControl(nodes[++index], "end")
    fieldNodes.push(nodes[index])
    const field = wordLeaf(copy, "fldSimple", "instr", instruction.trim())
    field.appendChild(result.cloneNode(true))
    paragraph.insertBefore(field, node)
    for (const child of fieldNodes) paragraph.removeChild(child)
  }
  return copy
}

function readNativeDefaults(styles) {
  if (!isWord(styles?.documentElement, "styles")) throw invalid()
  const containers = getXmlChildren(styles.documentElement).filter(node => isWord(node, "docDefaults"))
  if (containers.length !== 1) throw invalid()
  const defaults = containers[0]
  if (!allowedProperties(defaults, ["rPrDefault", "pPrDefault"]) ||
    !allowedProperties(getWordChild(defaults, "rPrDefault"), ["rPr"]) ||
    !allowedProperties(getWordChild(defaults, "pPrDefault"), ["pPr"])) throw invalid()
  const runs = getWordChild(getWordChild(defaults, "rPrDefault"), "rPr")
  const paragraphs = getWordChild(getWordChild(defaults, "pPrDefault"), "pPr")
  // 字号、颜色仍须由每个可见 run 明示；仅补齐样本中被 Word 省略的字体、段前距和左对齐。
  if (!allowedProperties(runs, ["rFonts", "color", "sz", "szCs", "lang"]) ||
    !allowedProperties(paragraphs, ["spacing", "widowControl"])) throw invalid()
  for (const property of [...getXmlChildren(runs), ...getXmlChildren(paragraphs)]) validateDefaultProperty(property)
  validateDefaultStyles(styles)
  const fonts = getWordChild(runs, "rFonts")
  const spacing = getWordChild(paragraphs, "spacing")
  return {
    fonts: {
      ascii: fonts?.getAttributeNS(WORD_XML, "ascii"), hAnsi: fonts?.getAttributeNS(WORD_XML, "hAnsi"),
      eastAsia: fonts?.hasAttributeNS(WORD_XML, "eastAsiaTheme") ? undefined : fonts?.getAttributeNS(WORD_XML, "eastAsia")
    },
    before: spacing?.hasAttributeNS(WORD_XML, "before") ? spacing.getAttributeNS(WORD_XML, "before") : "0",
    alignment: "left"
  }
}

/** 默认样式会影响未显式覆盖的文字，不能仅忽略 basedOn 或取第一个同名属性。 */
function validateDefaultStyles(styles) {
  const seen = new Set()
  for (const style of getXmlChildren(styles.documentElement).filter(node => isWord(node, "style") &&
    ["paragraph", "character"].includes(node.getAttributeNS(WORD_XML, "type")))) {
    if (!style.hasAttributeNS(WORD_XML, "default")) continue
    const enabled = style.getAttributeNS(WORD_XML, "default")
    if (["0", "false", "off"].includes(enabled)) continue
    if (!["1", "true", "on"].includes(enabled)) throw invalid()
    const type = style.getAttributeNS(WORD_XML, "type")
    if (seen.has(type)) throw invalid()
    seen.add(type)
    const names = ["name", "uiPriority", "qFormat", "semiHidden", "unhideWhenUsed", "rPr", "pPr"]
    const nodes = getXmlChildren(style)
    if (!onlyAttributes(style, ["type", "default", "styleId"]) ||
      new Set(nodes.map(node => node.localName)).size !== nodes.length ||
      nodes.some(node => node.namespaceURI !== WORD_XML || !names.includes(node.localName)) ||
      Array.from(style.childNodes).some(node => [3, 4].includes(node.nodeType) && node.textContent.trim()) ||
      !allowedProperties(getWordChild(style, "rPr"), []) ||
      !allowedProperties(getWordChild(style, "pPr"), ["widowControl"])) throw invalid()
    for (const property of getXmlChildren(getWordChild(style, "pPr"))) validateDefaultProperty(property)
    for (const property of nodes.filter(node => !["rPr", "pPr"].includes(node.localName))) {
      if (!onlyAttributes(property, ["val"]) || getXmlChildren(property).length || property.textContent.trim()) throw invalid()
      const value = property.getAttributeNS(WORD_XML, "val")
      if (property.localName === "name" && (!value || value.length > 255) ||
        property.localName === "uiPriority" && !/^\d{1,3}$/.test(value) ||
        !["name", "uiPriority"].includes(property.localName) && property.hasAttributeNS(WORD_XML, "val") &&
        !["0", "1", "false", "true", "off", "on"].includes(value)) throw invalid()
    }
  }
}

function validateDefaultProperty(node) {
  const names = {
    rFonts: ["ascii", "hAnsi", "eastAsia", "eastAsiaTheme", "cs"], color: ["val"], sz: ["val"], szCs: ["val"],
    lang: ["val", "eastAsia", "bidi"], spacing: ["before", "after", "line", "lineRule"], widowControl: ["val"]
  }
  if (!onlyAttributes(node, names[node.localName] || []) || getXmlChildren(node).length || node.textContent.trim()) throw invalid()
  const value = node.getAttributeNS(WORD_XML, "val")
  if (node.localName === "color" && !/^(?:[\da-f]{6}|auto)$/i.test(value) ||
    ["sz", "szCs"].includes(node.localName) && (!/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 1638) ||
    node.localName === "widowControl" && node.hasAttributeNS(WORD_XML, "val") &&
    !["0", "1", "false", "true", "off", "on"].includes(value)) throw invalid()
  if (node.localName === "spacing") {
    // beforeLines 和 beforeAutospacing 会覆盖 before；未实现这两种继承，不能当作零段前距。
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.localName === "lineRule") {
        if (!["auto", "exact", "atLeast"].includes(attribute.value)) throw invalid()
      } else if (!/^\d{1,8}$/.test(attribute.value)) throw invalid()
    }
  }
  if (["rFonts", "lang"].includes(node.localName)) {
    for (const attribute of Array.from(node.attributes)) {
      if (!attribute.value || attribute.value.length > 255 || /[\u0000-\u001f]/.test(attribute.value)) throw invalid()
    }
  }
}

function normalizeTextRun(run, defaults) {
  if (!isWord(run, "r")) throw invalid()
  removeMetadata(run)
  const properties = getWordChild(run, "rPr")
  if (!properties) throw invalid()
  let fonts = getWordChild(properties, "rFonts")
  // Word 再次保存会把与 docDefaults 完全相同的 rFonts 整体省略；只从已验证的显式字体补回。
  if (!fonts) {
    fonts = run.ownerDocument.createElementNS(WORD_XML, "w:rFonts")
    properties.insertBefore(fonts, properties.firstChild)
  }
  for (const name of ["ascii", "hAnsi", "eastAsia"]) {
    if (!fonts.hasAttributeNS(WORD_XML, name)) {
      if (defaults[name] !== (name === "eastAsia" ? "PingFang SC" : "Arial")) throw invalid()
      fonts.setAttributeNS(WORD_XML, `w:${name}`, defaults[name])
    }
  }
  const text = getWordChild(run, "t")
  if (!text) throw invalid()
  if (!text.hasAttributeNS(XML_XML, "space")) {
    // 没有 xml:space 时的边缘空白无法证明保真，不能通过补属性掩盖丢失。
    if (text.textContent !== text.textContent.trim()) throw invalid()
    text.setAttributeNS(XML_XML, "xml:space", "preserve")
  }
}

function readFieldControl(run, type) {
  const field = readFieldRun(run, "fldChar")
  if (!onlyAttributes(field, ["fldCharType"]) || field.getAttributeNS(WORD_XML, "fldCharType") !== type ||
    getXmlChildren(field).length || field.textContent.trim()) throw invalid()
}

function readFieldRun(run, name) {
  if (!isWord(run, "r")) throw invalid()
  removeMetadata(run)
  if (!onlyAttributes(run, [])) throw invalid()
  const nodes = getXmlChildren(run)
  const properties = getWordChild(run, "rPr")
  if (properties) {
    // 控制 run 不显示文字，仍只接受 Word 回存生成的颜色和字号，拒绝隐藏内容或格式指令。
    if (!allowedProperties(properties, ["color", "sz", "szCs"])) throw invalid()
    for (const property of getXmlChildren(properties)) {
      if (!onlyAttributes(property, ["val"]) || getXmlChildren(property).length || property.textContent.trim() ||
        !(property.localName === "color" ? property.getAttributeNS(WORD_XML, "val") === "626777" : /^(1[2-8])$/.test(property.getAttributeNS(WORD_XML, "val")))) throw invalid()
    }
  }
  if (nodes.length !== (properties ? 2 : 1) || !isWord(nodes[nodes.length - 1], name) ||
    Array.from(run.childNodes).some(node => [3, 4].includes(node.nodeType) && node.textContent.trim())) throw invalid()
  return nodes[nodes.length - 1]
}

function removeMetadata(node) {
  for (const attribute of Array.from(node.attributes || [])) {
    if (attribute.namespaceURI === WORD_XML && ["rsidR", "rsidRDefault", "rsidRPr", "rsidP"].includes(attribute.localName) ||
      attribute.namespaceURI === WORD14_XML && ["paraId", "textId"].includes(attribute.localName)) {
      if (!/^[\da-f]{8}$/i.test(attribute.value)) throw invalid()
      node.removeAttributeNS(attribute.namespaceURI, attribute.localName)
    }
  }
}

function allowedProperties(node, names) {
  if (!node) return true
  const nodes = getXmlChildren(node)
  return onlyAttributes(node, []) && new Set(nodes.map(child => child.localName)).size === nodes.length &&
    nodes.every(child => child.namespaceURI === WORD_XML && names.includes(child.localName)) &&
    !Array.from(node.childNodes).some(child => [3, 4].includes(child.nodeType) && child.textContent.trim())
}

function onlyAttributes(node, names) {
  return Array.from(node?.attributes || []).every(attribute => attribute.namespaceURI === WORD_XML && names.includes(attribute.localName))
}

function textAttributes(node) {
  return Array.from(node.attributes || []).every(attribute => attribute.namespaceURI === XML_XML &&
    attribute.localName === "space" && attribute.value === "preserve")
}

function wordLeaf(node, name, attribute, value) {
  const result = node.ownerDocument.createElementNS(WORD_XML, `w:${name}`)
  result.setAttributeNS(WORD_XML, `w:${attribute}`, value)
  return result
}

const isWord = (node, name) => node?.namespaceURI === WORD_XML && node.localName === name
