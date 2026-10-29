/**
 * 只恢复 Mewoc 输出的原生文字水印；未知 VML 原样留给旧图形守卫，不能借水印 ID 放行艺术字。
 * 读取正文有效节的真实页眉关系，在附加页内容前移除已确认的装饰，原 ZIP 字节始终不改。
 */
import { getXmlChildren, getWordChild, WORD_XML } from "./docx-import-xml.js"
import { validatePageSettings } from "./page-settings.js"
import { WORD_ART_TYPE_ID, WORD_ART_PATH, WORD_ART_FORMULAS } from "./docx-watermark-wordart.js"

const VML_XML = "urn:schemas-microsoft-com:vml"
const OFFICE_XML = "urn:schemas-microsoft-com:office:office"
const WORD_VML_XML = "urn:schemas-microsoft-com:office:word"
const WORD_2010_XML = "http://schemas.microsoft.com/office/word/2010/wordml"
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
  const watermarks = new Map()
  const native = new Map()
  // 一次统计 ID，避免大量水印对整个部件重复扫描形成平方级开销。
  const ids = new Map()
  for (const node of Array.from(part.getElementsByTagNameNS("*", "*"))) {
    if (node.hasAttribute("id")) ids.set(node.getAttribute("id"), (ids.get(node.getAttribute("id")) || 0) + 1)
  }
  // 标准类型可被多个本项目水印共用，但任何同 ID 的不同定义都会使引用含义不可靠。
  const wordArtTypes = Array.from(part.getElementsByTagNameNS("*", "*"))
    .filter(node => node.getAttribute("id") === WORD_ART_TYPE_ID)
  const wordArtTypeValid = wordArtTypes.length > 0 && wordArtTypes.every(readWordArtType)
  const ordered = Array.from(part.getElementsByTagNameNS(WORD_XML, "pict"))
  for (const picture of ordered) {
    // 输出契约是页眉直接段落中的 run，不穿过未知容器、链接或 AlternateContent 取其中一部分。
    const run = picture.parentNode
    const paragraph = run?.parentNode
    if (run?.namespaceURI !== WORD_XML || run.localName !== "r" || paragraph?.namespaceURI !== WORD_XML ||
      paragraph.localName !== "p" || paragraph.parentNode !== part.documentElement) continue
    const watermark = readPicture(picture, page, ids) || (wordArtTypeValid && readWordArtPicture(picture, page, ids))
    if (watermark) { pictures.push(picture); watermarks.set(picture, watermark) }
    else {
      const shape = getXmlChildren(picture)[0]
      const match = /^MewocWatermark(Type|Shape)_([a-f\d]{32})$/.exec(shape?.getAttribute("id"))
      if (!match) continue
      if (!native.has(match[2])) native.set(match[2], {})
      const pair = native.get(match[2])
      pair[match[1]] = picture
    }
  }
  // Word 16.100.2 将 shapetype 实例化为隐藏形状，只有同段、唯一且完整验证的配对才可一起移除。
  for (const pair of native.values()) {
    const watermark = readNativePair(pair, page, ids)
    if (!watermark) continue
    pictures.push(pair.Type, pair.Shape)
    watermarks.set(pair.Shape, watermark)
  }
  // 按可见 shape 的原文位置合并两种表示；不能让较晚解析的原生配对排在 canonical 之后。
  return { pictures, watermarks: ordered.filter(picture => watermarks.has(picture)).map(picture => watermarks.get(picture)) }
}

function readNativePair(pair, page, ids) {
  if (!pair.Type || !pair.Shape || pair.Type.parentNode.parentNode !== pair.Shape.parentNode.parentNode) return undefined
  const type = readNativeShape(pair.Type, ids, true)
  const shape = readNativeShape(pair.Shape, ids, false)
  if (!type || !shape || type.node.getAttributeNS(OFFICE_XML, "spid") === shape.node.getAttributeNS(OFFICE_XML, "spid")) return undefined
  const [fill, , , , textPath] = getXmlChildren(shape.node)
  if (!hasAttributes(fill, ["|opacity"]) || !hasChildren(fill, []) ||
    !hasAttributes(textPath, ["|on", "|style", "|string"]) || !hasChildren(textPath, []) || textPath.getAttribute("on") !== "t") return undefined
  const font = readStyle(textPath.getAttribute("style"), ["font-family", "font-size"])
  if (!font || font["font-family"] !== '"Arial"') return undefined
  const size = points(font["font-size"])
  const text = textPath.getAttribute("string")
  // Word 按半 twip 舍入宽高，并将字号存成浮点；容差只覆盖该量化，不放行拉伸艺术字。
  if (!size || size > 18 * 72 / 25.4 + 0.00001 || text.length > 160 ||
    Math.abs(shape.width - Array.from(text).length * size) > 0.026 ||
    Math.abs(shape.height - 1.2 * size) > 0.026) return undefined
  const fixed = /^(\d{1,5})f$/.exec(fill.getAttribute("opacity"))
  let opacity = fixed ? Number(fixed[1]) / 65536 : undefined
  const rotation = number(shape.style.rotation)
  if (opacity === undefined || rotation === undefined || rotation < 0 || rotation >= 360) return undefined
  // 5% 契约下界可能因 16.16 定点量化稍低；其余值保留实际精度，不猜测原输入的小数位。
  if (opacity < 0.05 && 0.05 - opacity <= 1 / 65536) opacity = 0.05
  const watermark = {
    text, color: shape.node.getAttribute("fillcolor"), opacity, angle: rotation > 180 ? rotation - 360 : rotation
  }
  try { validatePageSettings({ ...page, watermark }) }
  catch { return undefined }
  return watermark
}

function readNativeShape(picture, ids, hidden) {
  if (!hasAttributes(picture, [`${WORD_2010_XML}|anchorId`]) ||
    !/^[A-F\d]{8}$/i.test(picture.getAttributeNS(WORD_2010_XML, "anchorId")) ||
    !hasChildren(picture, [[VML_XML, "shape"]])) return undefined
  const shape = getXmlChildren(picture)[0]
  const expected = ["|id", `${OFFICE_XML}|spid`, "|alt", "|style", "|coordsize", `${OFFICE_XML}|spt`, "|adj", "|path"]
  if (!hidden) expected.push(`${OFFICE_XML}|allowincell`, "|fillcolor", "|stroked")
  if (!hasAttributes(shape, expected) || ids.get(shape.getAttribute("id")) !== 1 ||
    !/^_x0000_s\d+$/.test(shape.getAttributeNS(OFFICE_XML, "spid")) || shape.getAttribute("alt") !== "" ||
    shape.getAttribute("coordsize") !== "21600,21600" || shape.getAttributeNS(OFFICE_XML, "spt") !== "100" ||
    shape.getAttribute("adj") !== "0,,0" || shape.getAttribute("path") !== "m,10800r21600,e") return undefined
  const nodes = getXmlChildren(shape)
  const expectedChildren = [[VML_XML, "stroke"], [VML_XML, "formulas"], [VML_XML, "path"], [VML_XML, "textpath"]]
  if (hidden) expectedChildren.push([OFFICE_XML, "lock"])
  else {
    expectedChildren.unshift([VML_XML, "fill"])
    expectedChildren.push([WORD_VML_XML, "wrap"])
  }
  if (!hasChildren(shape, expectedChildren)) return undefined
  const offset = hidden ? 0 : 1
  if (!leaf(nodes[offset], { joinstyle: "round" }) || !leaf(nodes[offset + 1], {})) return undefined
  const style = readNativeStyle(shape.getAttribute("style"), hidden)
  if (!style) return undefined
  const width = points(style.width), height = points(style.height)
  if (!width || !height) return undefined
  const path = nodes[offset + 2]
  if (!hasAttributes(path, ["|textpathok", `${OFFICE_XML}|connecttype`, `${OFFICE_XML}|connectlocs`, `${OFFICE_XML}|connectangles`]) ||
    !hasChildren(path, []) || path.getAttribute("textpathok") !== "t" || path.getAttributeNS(OFFICE_XML, "connecttype") !== "custom" ||
    path.getAttributeNS(OFFICE_XML, "connectangles") !== "0,0") return undefined
  const locations = /^0,(\d+);(\d+),(\d+)$/.exec(path.getAttributeNS(OFFICE_XML, "connectlocs"))
  if (!locations || locations[1] !== locations[3] || Math.abs(Number(locations[1]) - height * 6350) > 0.51 ||
    Math.abs(Number(locations[2]) - width * 12700) > 0.51) return undefined
  if (hidden) {
    const lock = nodes[4]
    if (width !== 50 || height !== 50 || !leaf(nodes[3], { on: "t" }) ||
      !hasAttributes(lock, [`${VML_XML}|ext`, "|selection"]) || !hasChildren(lock, []) ||
      lock.getAttributeNS(VML_XML, "ext") !== "edit" || lock.getAttribute("selection") !== "t") return undefined
  } else if (shape.getAttributeNS(OFFICE_XML, "allowincell") !== "f" || shape.getAttribute("stroked") !== "f" ||
    !leaf(nodes[5], { anchorx: "page", anchory: "page" })) return undefined
  return { node: shape, style, width, height }
}

function readNativeStyle(source, hidden, wordArt = false) {
  // 原生 Word 重复写入百分比 0；只允许这两个完全相同的重复声明，其他重复仍拒绝。
  const properties = source.split(";").filter(item => item.trim())
  for (const key of ["mso-width-percent", "mso-height-percent"]) {
    const values = properties.filter(item => item.trim().startsWith(`${key}:`))
    if (values.length !== 2 || values.some(item => item.trim() !== `${key}:0`)) return undefined
    properties.splice(properties.indexOf(values[0]), 1)
  }
  const constants = {
    position: "absolute", "margin-left": "0", "margin-top": "0", "mso-wrap-edited": "f",
    "mso-width-percent": "0", "mso-height-percent": "0"
  }
  if (!wordArt) constants.visibility = hidden ? "hidden" : "visible"
  if (!hidden) {
    for (const key of ["mso-wrap-style", "mso-position-horizontal", "mso-position-horizontal-relative",
      "mso-position-vertical", "mso-position-vertical-relative"]) constants[key] = STYLE_VALUES[key]
  }
  const style = readStyle(properties.join(";"), [...Object.keys(constants), "width", "height", "z-index", ...(hidden ? [] : ["rotation"])])
  if (!style || Object.entries(constants).some(([key, value]) => style[key] !== value)) return undefined
  const layer = number(style["z-index"])
  if (!Number.isInteger(layer) || hidden && layer !== 251657216 || !hidden && (layer >= 0 || layer < -2147483648)) return undefined
  return style
}

/** 固定 WordArt 模板逐项验证；不执行任意公式，也不凭标准类型名吞掉普通艺术字。 */
function readWordArtType(type) {
  if (type.namespaceURI !== VML_XML || type.localName !== "shapetype" ||
    !hasAttributes(type, ["|id", "|coordsize", `${OFFICE_XML}|spt`, "|adj", "|path"]) ||
    type.getAttribute("id") !== WORD_ART_TYPE_ID || type.getAttribute("coordsize") !== "21600,21600" ||
    type.getAttributeNS(OFFICE_XML, "spt") !== "136" || type.getAttribute("adj") !== "10800" || type.getAttribute("path") !== WORD_ART_PATH ||
    !hasChildren(type, [[VML_XML, "formulas"], [VML_XML, "path"], [VML_XML, "textpath"], [VML_XML, "handles"], [OFFICE_XML, "lock"]])) return false
  const [formulas, path, text, handles, lock] = getXmlChildren(type)
  if (!hasAttributes(formulas, []) || !hasChildren(formulas, WORD_ART_FORMULAS.map(() => [VML_XML, "f"])) ||
    getXmlChildren(formulas).some((node, index) => !leaf(node, { eqn: WORD_ART_FORMULAS[index] })) ||
    !hasAttributes(path, ["|textpathok", `${OFFICE_XML}|connecttype`, `${OFFICE_XML}|connectlocs`, `${OFFICE_XML}|connectangles`]) ||
    !hasChildren(path, []) || path.getAttribute("textpathok") !== "t" || path.getAttributeNS(OFFICE_XML, "connecttype") !== "custom" ||
    path.getAttributeNS(OFFICE_XML, "connectlocs") !== "@9,0;@10,10800;@11,21600;@12,10800" ||
    path.getAttributeNS(OFFICE_XML, "connectangles") !== "270,180,90,0" || !leaf(text, { on: "t", fitshape: "t" }) ||
    !hasAttributes(handles, []) || !hasChildren(handles, [[VML_XML, "h"]]) ||
    !leaf(getXmlChildren(handles)[0], { position: "#0,bottomRight", xrange: "6629,14971" }) ||
    !hasAttributes(lock, [`${VML_XML}|ext`, "|text", "|shapetype"]) || !hasChildren(lock, []) ||
    lock.getAttributeNS(VML_XML, "ext") !== "edit" || lock.getAttribute("text") !== "t" || lock.getAttribute("shapetype") !== "t") return false
  return true
}

function readWordArtPicture(picture, page, ids) {
  const native = picture.hasAttributeNS(WORD_2010_XML, "anchorId")
  if (!hasAttributes(picture, native ? [`${WORD_2010_XML}|anchorId`] : []) ||
    native && !/^[A-F\d]{8}$/i.test(picture.getAttributeNS(WORD_2010_XML, "anchorId")) ||
    !hasChildren(picture, [[VML_XML, "shapetype"], [VML_XML, "shape"]])) return undefined
  const [type, shape] = getXmlChildren(picture)
  if (!readWordArtType(type) || !/^MewocWatermarkShape_[a-f\d]{32}$/.test(shape.getAttribute("id")) ||
    ids.get(shape.getAttribute("id")) !== 1 || shape.getAttribute("type") !== `#${WORD_ART_TYPE_ID}`) return undefined
  const shapeAttributes = ["|id", "|type", "|style", "|fillcolor", "|stroked", `${OFFICE_XML}|allowincell`]
  if (native) shapeAttributes.push(`${OFFICE_XML}|spid`, "|alt")
  else shapeAttributes.push(`${OFFICE_XML}|allowoverlap`)
  if (!hasAttributes(shape, shapeAttributes) || shape.getAttribute("stroked") !== "f" || shape.getAttributeNS(OFFICE_XML, "allowincell") !== "f" ||
    native && (!/^_x0000_s\d+$/.test(shape.getAttributeNS(OFFICE_XML, "spid")) || shape.getAttribute("alt") !== "") ||
    !native && shape.getAttributeNS(OFFICE_XML, "allowoverlap") !== "t" ||
    !hasChildren(shape, [[VML_XML, "fill"], [VML_XML, "textpath"], [WORD_VML_XML, "wrap"]])) return undefined
  const [fill, textPath, wrap] = getXmlChildren(shape)
  const textAttributes = ["|style", "|string"]
  if (!native) textAttributes.push("|on", "|fitshape", "|xscale")
  else if (textPath.hasAttribute("fitshape")) textAttributes.push("|fitshape")
  if (!hasAttributes(fill, ["|opacity"]) || !hasChildren(fill, []) || !hasAttributes(textPath, textAttributes) || !hasChildren(textPath, []) ||
    !native && (textPath.getAttribute("on") !== "t" || textPath.getAttribute("fitshape") !== "f" || textPath.getAttribute("xscale") !== "f") ||
    native && textPath.hasAttribute("fitshape") && textPath.getAttribute("fitshape") !== "f" ||
    !leaf(wrap, { ...(native ? {} : { type: "none" }), anchorx: "page", anchory: "page" })) return undefined
  const style = native ? readNativeStyle(shape.getAttribute("style"), false, true) :
    readStyle(shape.getAttribute("style"), [...Object.keys(STYLE_VALUES), "width", "height", "rotation"])
  const font = readStyle(textPath.getAttribute("style"), ["font-family", "font-size", ...(native ? [] : ["v-text-align"])])
  if (!style || !font || font["font-family"] !== (native ? '"Arial"' : "Arial") ||
    !native && (Object.entries(STYLE_VALUES).some(([key, value]) => style[key] !== value) || font["v-text-align"] !== "center")) return undefined
  const width = points(style.width), height = points(style.height), size = points(font["font-size"])
  const text = textPath.getAttribute("string")
  const close = native ? (actual, expected) => Math.abs(actual - expected) <= 0.026 : near
  if (!width || !height || !size || size > 18 * 72 / 25.4 + (native ? 0.00001 : 1e-8) || text.length > 160 ||
    !close(width, Array.from(text).length * size) || !close(height, 1.2 * size)) return undefined
  const fixed = /^(\d{1,5})f$/.exec(fill.getAttribute("opacity"))
  let opacity = native ? (fixed ? Number(fixed[1]) / 65536 : undefined) : number(fill.getAttribute("opacity"))
  const rotation = number(style.rotation)
  if (opacity === undefined || rotation === undefined || native && (rotation < 0 || rotation >= 360)) return undefined
  if (native && opacity < 0.05 && 0.05 - opacity <= 1 / 65536) opacity = 0.05
  const watermark = { text, color: shape.getAttribute("fillcolor"), opacity, angle: native && rotation > 180 ? rotation - 360 : rotation }
  try { validatePageSettings({ ...page, watermark }) }
  catch { return undefined }
  return watermark
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
