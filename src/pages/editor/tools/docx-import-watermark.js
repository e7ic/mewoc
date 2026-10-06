/**
 * 只恢复 Mewoc 输出的原生文字水印；未知 VML 原样留给旧图形守卫，不能借水印 ID 放行艺术字。
 * 读取正文有效节的真实页眉关系，在附加页内容前移除已确认的装饰，原 ZIP 字节始终不改。
 */
import { getXmlChildren, getWordChild, WORD_XML } from "./docx-import-xml.js"
import { validatePageSettings } from "./page-settings.js"

const VML_XML = "urn:schemas-microsoft-com:vml"
const OFFICE_XML = "urn:schemas-microsoft-com:office:office"
const WORD_VML_XML = "urn:schemas-microsoft-com:office:word"
const REL_XML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const PACKAGE_XML = "http://schemas.openxmlformats.org/package/2006/relationships"
const XMLNS_XML = "http://www.w3.org/2000/xmlns/"
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i
const STYLE_VALUES = {
  position: "absolute", "margin-left": "0", "margin-top": "0", "z-index": "-251654144",
  "mso-wrap-edited": "f", "mso-position-horizontal": "center", "mso-position-horizontal-relative": "page",
  "mso-position-vertical": "center", "mso-position-vertical-relative": "page", "mso-wrap-style": "none"
}
const invalidReference = () => new Error("水印页眉的节引用或资源关系无效，请保留原 DOCX")

/** 返回首节 default 水印，不能表示的分节、首偶页差异以 warning 明确说明。 */
export function extractDocxWatermark(parts, page, warnings) {
  const xml = parts.get("word/document.xml")
  const body = getWordChild(xml?.documentElement, "body")
  if (!body) return undefined
  const sections = effectiveSections(body)
  const relations = Array.from(parts.get("word/_rels/document.xml.rels")?.getElementsByTagNameNS(PACKAGE_XML, "Relationship") || [])
  const relationIds = new Map()
  for (const relation of relations) {
    const id = relation.getAttribute("Id")
    if (!relationIds.has(id)) relationIds.set(id, [])
    relationIds.get(id).push(relation)
  }
  const headers = new Map()
  const ranges = []
  let inherited = {}
  // evenAndOddHeaders 是文档设置；titlePg 则分别属于各节，不从前节继承。
  const settings = relations.filter(node => node.getAttribute("Type") === `${REL_XML}/settings`)
  if (settings.length > 1) throw invalidReference()
  const settingsPart = settings.length ? parts.get(partTarget(settings[0])) : undefined
  if (settings.length && (!settingsPart || settingsPart.documentElement.namespaceURI !== WORD_XML || settingsPart.documentElement.localName !== "settings")) throw invalidReference()
  const even = onOff(getWordChild(settingsPart?.documentElement, "evenAndOddHeaders"))
  for (const section of sections) {
    const current = { ...inherited }
    const seen = new Set()
    for (const reference of getXmlChildren(section).filter(node => node.namespaceURI === WORD_XML && node.localName === "headerReference")) {
      const explicitType = reference.hasAttributeNS(WORD_XML, "type")
      const kind = explicitType ? reference.getAttributeNS(WORD_XML, "type") : "default"
      const id = reference.getAttributeNS(REL_XML, "id")
      if (!["default", "first", "even"].includes(kind) || seen.has(kind) || !id ||
        !hasAttributes(reference, [...(explicitType ? [`${WORD_XML}|type`] : []), `${REL_XML}|id`]) || !hasChildren(reference, [])) throw invalidReference()
      // 旧导入链接受过缺少 w:type 的普通页眉；继续按 default 读取，并明确这不是可靠的页型信息。
      if (!explicitType) warnings.add("原文页眉引用缺少页型，已按默认页眉读取；首/偶页适用范围不保证保留")
      seen.add(kind)
      const matches = relationIds.get(id) || []
      if (matches.length !== 1 || matches[0].getAttribute("Type") !== `${REL_XML}/header`) throw invalidReference()
      const path = partTarget(matches[0])
      const part = parts.get(path)
      if (!part || part.documentElement.namespaceURI !== WORD_XML || part.documentElement.localName !== "hdr") throw invalidReference()
      current[kind] = path
      if (!headers.has(path)) headers.set(path, readHeader(part, page))
    }
    inherited = current
    ranges.push({ ...current, firstEnabled: onOff(getWordChild(section, "titlePg")), evenEnabled: even })
  }
  const recognized = [...headers.values()].flatMap(header => header.watermarks)
  if (!recognized.length) return undefined
  const first = headers.get(ranges[0]?.default)?.watermarks[0]
  const key = value => value ? JSON.stringify({ ...value, color: value.color.toLowerCase() }) : ""
  const selected = key(first)
  const active = ranges.flatMap(range => [range.default, ...(range.firstEnabled ? [range.first] : []), ...(range.evenEnabled ? [range.even] : [])])
  if (!first) warnings.add("首节默认页眉没有可恢复的 Mewoc 水印；首/偶页或后续节专用水印未保留，请保留原 DOCX")
  else if (active.some(path => key(headers.get(path)?.watermarks[0]) !== selected) || recognized.some(value => key(value) !== selected)) {
    warnings.add("原文分节或首/偶页水印不同，编辑器已统一采用首节默认页眉的 Mewoc 水印；其他页的水印设置不保留，请保留原 DOCX")
  }
  if ([...headers.values()].some(header => header.watermarks.length > 1)) warnings.add("同一页眉的多个 Mewoc 水印已合并为首个水印，重叠层次不保留")
  // 所有检查完成后才改 DOM；同一 pict 任一子节点未知，整个 pict 都不会被部分提取。
  for (const header of headers.values()) for (const picture of header.pictures) removeDecoration(picture)
  return first ? { ...first } : undefined
}

/** 只读取正文直接段落的 pPr/sectPr 与末尾 sectPr，排除修订快照和文本框中的同名节点。 */
function effectiveSections(body) {
  const result = []
  for (const child of getXmlChildren(body)) {
    if (child.namespaceURI !== WORD_XML) continue
    if (child.localName === "sectPr") result.push(child)
    else if (child.localName === "p") {
      const properties = getWordChild(child, "pPr")
      const sections = getXmlChildren(properties).filter(node => node.namespaceURI === WORD_XML && node.localName === "sectPr")
      if (sections.length > 1) throw invalidReference()
      result.push(...sections)
    }
  }
  return result
}

function onOff(node) {
  if (!node) return false
  const value = node.getAttributeNS(WORD_XML, "val")
  if (!node.hasAttributeNS(WORD_XML, "val") || ["1", "true", "on"].includes(value)) return true
  if (["0", "false", "off"].includes(value)) return false
  throw invalidReference()
}

/** 关系只允许包内路径；不解析 URL、不读取包外资源，也不能把错误路径当作空页眉跳过。 */
function partTarget(relation) {
  const target = relation.getAttribute("Target")
  const mode = relation.getAttribute("TargetMode")
  if (!target || (mode && mode !== "Internal") || /[:\\?#]/.test(target)) throw invalidReference()
  const path = target.startsWith("/") ? [] : ["word"]
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (!path.length) throw invalidReference()
      path.pop()
    } else path.push(segment)
  }
  return path.join("/")
}

function readHeader(part, page) {
  const pictures = []
  const watermarks = []
  // 一次统计 ID，避免大量水印对整个部件重复扫描形成平方级开销。
  const ids = new Map()
  for (const node of Array.from(part.getElementsByTagNameNS("*", "*"))) {
    if (node.hasAttribute("id")) ids.set(node.getAttribute("id"), (ids.get(node.getAttribute("id")) || 0) + 1)
  }
  for (const picture of Array.from(part.getElementsByTagNameNS(WORD_XML, "pict"))) {
    // 输出契约是页眉直接段落中的 run，不穿过未知容器、链接或 AlternateContent 取其中一部分。
    const run = picture.parentNode
    const paragraph = run?.parentNode
    if (run?.namespaceURI !== WORD_XML || run.localName !== "r" || paragraph?.namespaceURI !== WORD_XML ||
      paragraph.localName !== "p" || paragraph.parentNode !== part.documentElement) continue
    const watermark = readPicture(picture, page, ids)
    if (watermark) { pictures.push(picture); watermarks.push(watermark) }
  }
  return { pictures, watermarks }
}

function readPicture(picture, page, ids) {
  if (!hasAttributes(picture, []) || !hasChildren(picture, [[VML_XML, "shapetype"], [VML_XML, "shape"]])) return undefined
  const [type, shape] = getXmlChildren(picture)
  const suffix = /^MewocWatermarkType_([a-f\d]{32})$/.exec(type.getAttribute("id"))?.[1]
  if (!suffix || shape.getAttribute("id") !== `MewocWatermarkShape_${suffix}` || shape.getAttribute("type") !== `#${type.getAttribute("id")}`) return undefined
  // 重名 ID 不能证明 shape 实际引用了本 pict 中的 shapetype。
  if (ids.get(type.getAttribute("id")) !== 1 || ids.get(shape.getAttribute("id")) !== 1) return undefined
  if (!hasAttributes(type, ["|id", "|coordsize", `${OFFICE_XML}|spt`, "|path"]) || type.getAttribute("coordsize") !== "21600,21600" ||
    type.getAttributeNS(OFFICE_XML, "spt") !== "136" || type.getAttribute("path") !== "m0,10800l21600,10800e" ||
    !hasChildren(type, [[VML_XML, "path"], [VML_XML, "textpath"]])) return undefined
  const [path, template] = getXmlChildren(type)
  if (!leaf(path, { textpathok: "t" }) || !leaf(template, { on: "t" })) return undefined
  if (!hasAttributes(shape, ["|id", "|type", "|style", "|fillcolor", "|stroked", `${OFFICE_XML}|allowincell`, `${OFFICE_XML}|allowoverlap`]) ||
    shape.getAttribute("stroked") !== "f" || shape.getAttributeNS(OFFICE_XML, "allowincell") !== "f" || shape.getAttributeNS(OFFICE_XML, "allowoverlap") !== "t" ||
    !hasChildren(shape, [[VML_XML, "fill"], [VML_XML, "textpath"], [WORD_VML_XML, "wrap"]])) return undefined
  const [fill, textPath, wrap] = getXmlChildren(shape)
  if (!hasAttributes(fill, ["|opacity"]) || !hasChildren(fill, []) || !hasAttributes(textPath, ["|on", "|fitshape", "|xscale", "|style", "|string"]) ||
    !hasChildren(textPath, []) || textPath.getAttribute("on") !== "t" || textPath.getAttribute("fitshape") !== "f" || textPath.getAttribute("xscale") !== "f" ||
    !leaf(wrap, { type: "none", anchorx: "page", anchory: "page" })) return undefined
  const style = readStyle(shape.getAttribute("style"), [...Object.keys(STYLE_VALUES), "width", "height", "rotation"])
  const font = readStyle(textPath.getAttribute("style"), ["font-family", "font-size", "v-text-align"])
  if (!style || !font || Object.entries(STYLE_VALUES).some(([key, value]) => style[key] !== value) || font["font-family"] !== "Arial" || font["v-text-align"] !== "center") return undefined
  const width = points(style.width), height = points(style.height), size = points(font["font-size"])
  const text = textPath.getAttribute("string")
  if (text.length > 160) return undefined
  // 输出比例来自同一几何函数；不接受人为拉伸的文字路径或独立字号艺术字。
  if (!width || !height || !size || size > 18 * 72 / 25.4 + 1e-8 || !near(width, Array.from(text).length * size) || !near(height, 1.2 * size)) return undefined
  const opacity = number(fill.getAttribute("opacity")), angle = number(style.rotation)
  if (opacity === undefined || angle === undefined) return undefined
  const watermark = { text, color: shape.getAttribute("fillcolor"), opacity, angle }
  try { validatePageSettings({ ...page, watermark }) }
  catch { return undefined }
  return watermark
}

/** 精确属性白名单按 URI 与 localName 比对；前缀可变化，活动关系或事件属性不能混入。 */
function hasAttributes(node, expected) {
  const attributes = Array.from(node.attributes || []).filter(attribute => attribute.namespaceURI !== XMLNS_XML)
  return attributes.length === expected.length && attributes.every(attribute => expected.includes(`${attribute.namespaceURI || ""}|${attribute.localName}`))
}

function hasChildren(node, expected) {
  const children = getXmlChildren(node)
  if (children.length !== expected.length || children.some((child, index) => child.namespaceURI !== expected[index][0] || child.localName !== expected[index][1])) return false
  return Array.from(node.childNodes).every(child => child.nodeType === 1 || (child.nodeType === 3 && !child.data.trim()))
}

function leaf(node, attributes) {
  return hasAttributes(node, Object.keys(attributes).map(key => `|${key}`)) && hasChildren(node, []) &&
    Object.entries(attributes).every(([key, value]) => node.getAttribute(key) === value)
}

function readStyle(source, expected) {
  if (source.length > 2000) return undefined
  const result = {}
  for (const item of source.split(";").filter(item => item.trim())) {
    const index = item.indexOf(":")
    if (index < 0) return undefined
    const key = item.slice(0, index).trim(), value = item.slice(index + 1).trim()
    if (!expected.includes(key) || Object.hasOwn(result, key) || !value) return undefined
    result[key] = value
  }
  return Object.keys(result).length === expected.length ? result : undefined
}

function number(value) {
  if (value.length > 100 || !NUMBER.test(value)) return undefined
  const result = Number(value)
  return Number.isFinite(result) ? result : undefined
}

function points(value) {
  if (!value?.endsWith("pt")) return undefined
  const result = number(value.slice(0, -2))
  return result > 0 ? result : undefined
}

const near = (value, expected) => Math.abs(value - expected) <= Math.max(1, Math.abs(expected)) * 1e-10

function removeDecoration(picture) {
  const run = picture.parentNode, paragraph = run.parentNode
  run.removeChild(picture)
  if (!getXmlChildren(run).length && !run.textContent.trim() && hasAttributes(run, [])) paragraph.removeChild(run)
  // 只删识别水印留下的空段；含文字、书签、图片、未知内容或段落属性的其它节点继续原附加链。
  const children = getXmlChildren(paragraph)
  if (!paragraph.textContent.trim() && hasAttributes(paragraph, []) && children.every(emptyWatermarkProperties)) {
    paragraph.parentNode.removeChild(paragraph)
  }
}

function emptyWatermarkProperties(node) {
  if (node.namespaceURI !== WORD_XML || node.localName !== "pPr" || !hasAttributes(node, [])) return false
  const children = getXmlChildren(node)
  if (!children.length) return hasChildren(node, [])
  const spacing = children[0]
  return hasChildren(node, [[WORD_XML, "spacing"]]) && hasAttributes(spacing, ["after", "before", "line", "lineRule"].map(key => `${WORD_XML}|${key}`)) &&
    hasChildren(spacing, []) && ["after", "before"].every(key => spacing.getAttributeNS(WORD_XML, key) === "0") &&
    spacing.getAttributeNS(WORD_XML, "line") === "1" && spacing.getAttributeNS(WORD_XML, "lineRule") === "exact"
}
