/**
 * 恢复经过完整结构验证的 Mewoc 页眉/页脚 SDT，字段保留为页面设置而不静态追加进正文。
 * 原 ZIP 不改写；只在有效节关系、单段内容和所有格式都通过后删除内存 DOM 的装饰控件。
 */
import { getXmlChildren, getWordChild, WORD_XML } from "./docx-import-xml.js"
import { normalizeDocxFields } from "./docx-import-fields.js"
import { getPageFurnitureFontPt, validatePageFurniture } from "./page-furniture.js"
import { validatePageSettings } from "./page-settings.js"

const REL_XML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const PACKAGE_XML = "http://schemas.openxmlformats.org/package/2006/relationships"
const XMLNS_XML = "http://www.w3.org/2000/xmlns/"
const XML_XML = "http://www.w3.org/XML/1998/namespace"
const TAGS = { header: "MewocPageHeader_v1", footer: "MewocPageFooter_v1" }
const invalid = () => new Error("Mewoc 页眉、页脚或页码结构无法可靠恢复，请保留原 DOCX")
const invalidReference = () => new Error("页眉、页脚的节引用或资源关系无效，请保留原 DOCX")

/** 首节 default 才能成为全局设置，首/偶页及后续节专用内容不能扩展到所有页面。 */
export function extractDocxPageFurniture(parts, page, warnings) {
  const scope = collectPageScope(parts, warnings)
  const decorations = new Map()
  for (const [path, kind] of scope.parts) decorations.set(path, readDecoration(parts.get(path), page, kind))
  const patch = {}
  for (const kind of ["header", "footer"]) {
    const values = [...decorations.values()].filter(value => value?.kind === kind)
    if (!values.length) continue
    const selected = decorations.get(scope.ranges[0]?.[kind]?.default)?.furniture
    const label = kind === "header" ? "页眉" : "页脚"
    const key = value => value ? JSON.stringify(value) : ""
    if (!selected) warnings.add(`首节默认${label}没有可恢复的 Mewoc 设置；首/偶页或后续节专用${label}未保留，请保留原 DOCX`)
    else {
      patch[kind] = { ...selected }
      const active = scope.ranges.flatMap(range => [range[kind].default,
        ...(range.firstEnabled ? [range[kind].first] : []), ...(range.evenEnabled ? [range[kind].even] : [])])
      if (active.some(path => key(decorations.get(path)?.furniture) !== key(selected)) || values.some(value => key(value.furniture) !== key(selected))) {
        warnings.add(`原文分节或首/偶页${label}不同，编辑器统一采用首节默认${label}的 Mewoc 设置；其他页的独立设置不保留，请保留原 DOCX`)
      }
    }
  }
  // 整数 twips 的 12 mm 边界会读成 11.99 mm；仅恢复已验证装饰时消除这半 twip 量化误差。
  for (const [kind, side] of [["header", "top"], ["footer", "bottom"]]) {
    if (patch[kind] && page.marginsMm[side] < 12 && page.marginsMm[side] >= 11.99) {
      patch.marginsMm ||= { ...page.marginsMm }
      patch.marginsMm[side] = 12
      warnings.add("页眉、页脚的 12 mm 最小边距已消除 Word 整数单位的量化误差")
    }
  }
  if (Object.keys(patch).length) validatePageSettings({ ...page, ...patch })
  // 延迟删除：任意一个当前 canonical 控件损坏时整份导入拒绝，不能先吞掉另一侧完整内容。
  for (const value of decorations.values()) if (value) value.control.parentNode.removeChild(value.control)
  return patch
}

/**
 * 控件提取后才静态化当前及孤立页部件中的普通第三方域。历史快照专用部件保持原样。
 * 孤立部件不提取自有控件；未知控件或无缓存域仍按旧规则拒绝，不以空 textContent 跳过错误。
 */
export function normalizeDocxCurrentPageFields(parts, warnings) {
  const scope = collectPageScope(parts, warnings)
  for (const [path, part] of parts) {
    if (scope.historical.has(path) && !scope.parts.has(path)) continue
    if (isWord(part.documentElement, "hdr") || isWord(part.documentElement, "ftr")) normalizeDocxFields(part, warnings)
  }
}

function collectPageScope(parts, warnings) {
  const body = getWordChild(parts.get("word/document.xml")?.documentElement, "body")
  if (!body) return { parts: new Map(), ranges: [], historical: new Set() }
  const sections = []
  for (const child of getXmlChildren(body)) {
    if (child.namespaceURI !== WORD_XML) continue
    if (child.localName === "sectPr") sections.push(child)
    else if (child.localName === "p") {
      const nested = getXmlChildren(getWordChild(child, "pPr")).filter(node => isWord(node, "sectPr"))
      if (nested.length > 1) throw invalidReference()
      sections.push(...nested)
    }
  }
  const relations = Array.from(parts.get("word/_rels/document.xml.rels")?.getElementsByTagNameNS(PACKAGE_XML, "Relationship") || [])
  const ids = new Map()
  for (const relation of relations) {
    const id = relation.getAttribute("Id")
    if (!ids.has(id)) ids.set(id, [])
    ids.get(id).push(relation)
  }
  const settings = relations.filter(node => node.getAttribute("Type") === `${REL_XML}/settings`)
  if (settings.length > 1) throw invalidReference()
  const settingsPart = settings.length ? parts.get(partTarget(settings[0])) : undefined
  if (settings.length && !isWord(settingsPart?.documentElement, "settings")) throw invalidReference()
  const even = onOff(getWordChild(settingsPart?.documentElement, "evenAndOddHeaders"))
  const used = new Map()
  const ranges = []
  let inherited = { header: {}, footer: {} }
  for (const section of sections) {
    const current = { header: { ...inherited.header }, footer: { ...inherited.footer } }
    for (const kind of ["header", "footer"]) {
      const seen = new Set()
      for (const reference of getXmlChildren(section).filter(node => isWord(node, `${kind}Reference`))) {
        const typed = reference.hasAttributeNS(WORD_XML, "type")
        const type = typed ? reference.getAttributeNS(WORD_XML, "type") : "default"
        const id = reference.getAttributeNS(REL_XML, "id")
        if (!["default", "first", "even"].includes(type) || seen.has(type) || !id ||
          !attributes(reference, [...(typed ? [`${WORD_XML}|type`] : []), `${REL_XML}|id`]) || !children(reference, [])) throw invalidReference()
        seen.add(type)
        if (!typed) warnings.add(`原文${kind === "header" ? "页眉" : "页脚"}引用缺少页型，已按默认读取；首/偶页适用范围不保证保留`)
        const matches = ids.get(id) || []
        if (matches.length !== 1 || matches[0].getAttribute("Type") !== `${REL_XML}/${kind}`) throw invalidReference()
        const path = partTarget(matches[0])
        if (!isWord(parts.get(path)?.documentElement, kind === "header" ? "hdr" : "ftr") || used.has(path) && used.get(path) !== kind) throw invalidReference()
        used.set(path, kind)
        current[kind][type] = path
      }
    }
    inherited = current
    ranges.push({ ...current, firstEnabled: onOff(getWordChild(section, "titlePg")), evenEnabled: even })
  }
  // 仅明确属于修订快照且关系、部件根有效的部件可跳过当前字段处理；共用当前部件仍须处理。
  const historical = new Set()
  for (const kind of ["header", "footer"]) {
    for (const reference of Array.from(body.getElementsByTagNameNS(WORD_XML, `${kind}Reference`))) {
      if (!hasSectionHistory(reference)) continue
      const matches = ids.get(reference.getAttributeNS(REL_XML, "id")) || []
      if (matches.length !== 1 || matches[0].getAttribute("Type") !== `${REL_XML}/${kind}`) throw invalidReference()
      const path = partTarget(matches[0])
      if (!isWord(parts.get(path)?.documentElement, kind === "header" ? "hdr" : "ftr")) throw invalidReference()
      historical.add(path)
    }
  }
  return { parts: used, ranges, historical }
}

function hasSectionHistory(node) {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) if (isWord(parent, "sectPrChange")) return true
  return false
}

function partTarget(relation) {
  const target = relation.getAttribute("Target")
  const mode = relation.getAttribute("TargetMode")
  if (!target || mode && mode !== "Internal" || /[:\\?#]/.test(target)) throw invalidReference()
  const path = target.startsWith("/") ? [] : ["word"]
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") { if (!path.length) throw invalidReference(); path.pop() }
    else path.push(segment)
  }
  return path.join("/")
}

function onOff(node) {
  if (!node) return false
  if (!node.hasAttributeNS(WORD_XML, "val") || ["1", "true", "on"].includes(node.getAttributeNS(WORD_XML, "val"))) return true
  if (["0", "false", "off"].includes(node.getAttributeNS(WORD_XML, "val"))) return false
  throw invalidReference()
}

function readDecoration(part, page, kind) {
  const marked = Array.from(part.getElementsByTagNameNS(WORD_XML, "sdt")).filter(control =>
    Object.values(TAGS).includes(getWordChild(getWordChild(control, "sdtPr"), "tag")?.getAttributeNS(WORD_XML, "val")))
  if (!marked.length) return undefined
  if (marked.length !== 1) throw invalid()
  const control = marked[0]
  if (control.parentNode !== part.documentElement || !attributes(control, []) || !children(control, ["sdtPr", "sdtContent"])) throw invalid()
  const [properties, content] = getXmlChildren(control)
  if (!attributes(properties, []) || !children(properties, ["tag"]) || !attributes(content, []) || !children(content, ["p"])) throw invalid()
  const tag = getXmlChildren(properties)[0]
  if (!leaf(tag, { val: TAGS[kind] })) throw invalid()
  const paragraph = getXmlChildren(content)[0]
  if (!attributes(paragraph, [])) throw invalid()
  const nodes = getXmlChildren(paragraph)
  if (!isWord(nodes[0], "pPr") || nodes.length < 2 || !noStructuralText(paragraph)) throw invalid()
  const formatting = readParagraphFormat(nodes[0])
  const runs = nodes.slice(1).map(node => readRunOrField(node, formatting.size))
  let furniture
  if (runs.every(run => run.type === "text")) {
    if (runs.length !== 1) throw invalid()
    furniture = { text: runs[0].text, alignment: formatting.alignment, pageNumber: "none" }
  } else {
    const fieldAt = runs.findIndex(run => run.type === "field")
    if (fieldAt !== 1 && fieldAt !== 3) throw invalid()
    const text = fieldAt === 3 ? runs[0].text : ""
    if (fieldAt === 3 && (runs[0].type !== "text" || !sameText(runs[1], " · "))) throw invalid()
    const offset = fieldAt - 1
    if (!sameText(runs[offset], "第 ") || !sameField(runs[offset + 1], "PAGE")) throw invalid()
    const numbered = runs.slice(offset)
    if (numbered.length === 3 && sameText(numbered[2], " 页")) furniture = { text, alignment: formatting.alignment, pageNumber: "page" }
    else if (numbered.length === 5 && sameText(numbered[2], " / ") && sameField(numbered[3], "NUMPAGES") && sameText(numbered[4], " 页")) {
      furniture = { text, alignment: formatting.alignment, pageNumber: "page-total" }
    } else throw invalid()
  }
  if (furniture.text !== furniture.text.trim() || furniture.pageNumber === "none" && !furniture.text) throw invalid()
  try {
    validatePageFurniture(furniture)
    const expected = Math.floor(getPageFurnitureFontPt(page, furniture) * 2)
    // 页面整数 twips 量化可能恰好跨半磅字号门槛，最多允许相邻一个半磅整数，绝不接受任意字体。
    if (Math.abs(expected - formatting.size) > 1) throw invalid()
  } catch { throw invalid() }
  return { kind, furniture, control }
}

function readParagraphFormat(node) {
  if (!attributes(node, []) || !children(node, ["spacing", "jc"])) throw invalid()
  const [spacing, alignment] = getXmlChildren(node)
  if (!attributes(spacing, ["after", "before", "line", "lineRule"].map(name => `${WORD_XML}|${name}`)) || !children(spacing, []) ||
    spacing.getAttributeNS(WORD_XML, "after") !== "0" || spacing.getAttributeNS(WORD_XML, "before") !== "0" || spacing.getAttributeNS(WORD_XML, "lineRule") !== "exact" ||
    !attributes(alignment, [`${WORD_XML}|val`]) || !children(alignment, []) || !["left", "center", "right"].includes(alignment.getAttributeNS(WORD_XML, "val"))) throw invalid()
  const line = spacing.getAttributeNS(WORD_XML, "line")
  if (!/^\d+$/.test(line)) throw invalid()
  const size = Number(line) / 12
  if (!Number.isInteger(size) || size < 12 || size > 18) throw invalid()
  return { size, alignment: alignment.getAttributeNS(WORD_XML, "val") }
}

function readRunOrField(node, size) {
  if (isWord(node, "r")) return { type: "text", text: readTextRun(node, size) }
  if (!isWord(node, "fldSimple") || !attributes(node, [`${WORD_XML}|instr`]) || !children(node, ["r"])) throw invalid()
  const instruction = node.getAttributeNS(WORD_XML, "instr")
  if (!["PAGE", "NUMPAGES"].includes(instruction)) throw invalid()
  // Word 可更新缓存数字；不执行字段代码、不以缓存数字作为编辑器的分页事实。
  const cached = readTextRun(getXmlChildren(node)[0], size)
  if (!/^[1-9]\d{0,4}$/.test(cached)) throw invalid()
  return { type: "field", instruction }
}

function readTextRun(node, size) {
  if (!attributes(node, []) || !children(node, ["rPr", "t"])) throw invalid()
  const [properties, text] = getXmlChildren(node)
  if (!attributes(properties, []) || !children(properties, ["rFonts", "color", "sz", "szCs"])) throw invalid()
  const [fonts, color, normal, complex] = getXmlChildren(properties)
  if (!leaf(fonts, { ascii: "Arial", eastAsia: "PingFang SC", hAnsi: "Arial" }) || !leaf(color, { val: "626777" }) ||
    !leaf(normal, { val: String(size) }) || !leaf(complex, { val: String(size) }) || !attributes(text, [`${XML_XML}|space`]) ||
    text.getAttributeNS(XML_XML, "space") !== "preserve" || getXmlChildren(text).length || Array.from(text.childNodes).some(child => ![3, 4].includes(child.nodeType))) throw invalid()
  return text.textContent
}

const sameText = (run, text) => run?.type === "text" && run.text === text
const sameField = (run, instruction) => run?.type === "field" && run.instruction === instruction
const isWord = (node, name) => node?.namespaceURI === WORD_XML && node.localName === name
const noStructuralText = node => !Array.from(node.childNodes || []).some(child => [3, 4].includes(child.nodeType) && child.textContent.trim())
function attributes(node, expected) {
  const actual = Array.from(node?.attributes || []).filter(attr => attr.namespaceURI !== XMLNS_XML).map(attr => `${attr.namespaceURI || ""}|${attr.localName}`)
  return actual.length === expected.length && actual.every(value => expected.includes(value))
}
function children(node, expected) {
  const actual = getXmlChildren(node)
  return noStructuralText(node) && actual.length === expected.length && actual.every((value, index) => isWord(value, expected[index]))
}
function leaf(node, values) {
  return attributes(node, Object.keys(values).map(name => `${WORD_XML}|${name}`)) && children(node, []) &&
    Object.entries(values).every(([name, value]) => node.getAttributeNS(WORD_XML, name) === value)
}
