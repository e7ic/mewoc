/**
 * 从当前正文的有效节属性读取纸张与四边边距，不改写 XML，也不把历史 sectPr 当作新的一节。
 * Word 可以逐节排版，Mewoc 只有一份全局 page；因此完整检查所有节后，只采用第一节并提示差异。
 */
import { PAGE_SIZES, getPageDimensions, validatePageSettings } from "./page-settings.js"
import { WORD_XML, getXmlChildren } from "./docx-import-xml.js"

const XMLNS = "http://www.w3.org/2000/xmlns/"
const SIDES = ["top", "right", "bottom", "left"]
const TWIPS_PER_MM = 1440 / 25.4
// 尺寸/边距各自取整到 twip 后，正文边界最多出现约两 twip 的差异；只在这个量化区间微调。
const ROUNDING_MM = 2 / TWIPS_PER_MM
const defaultPage = () => ({ size: "A4", orientation: "portrait", marginsMm: { top: 20, right: 20, bottom: 20, left: 20 } })
const isWord = (node, name) => node?.namespaceURI === WORD_XML && node.localName === name
const wordChildren = (node, name) => getXmlChildren(node).filter(child => isWord(child, name))
const attribute = (node, name) => node?.hasAttributeNS(WORD_XML, name) ? node.getAttributeNS(WORD_XML, name) : undefined
const roundMm = value => Number(value.toFixed(2))

/** 返回完整、经过共享契约校验的 page；没有水印字段，由独立的页眉水印读取器负责该部分。 */
export function readDocxPageSettings(xml, warnings) {
  const root = xml?.documentElement
  if (!isWord(root, "document")) throw new Error("Word 页面设置缺少主文档")
  const bodies = wordChildren(root, "body")
  if (bodies.length !== 1) throw new Error("Word 页面设置的正文结构无效")
  const body = bodies[0]
  const bodyChildren = getXmlChildren(body)
  const sections = Array.from(xml.getElementsByTagNameNS(WORD_XML, "sectPr")).filter(node => !isHistorical(node))
  const accepted = new Set(sections)
  let finalCount = 0
  for (const section of sections) {
    const parent = section.parentNode
    if (parent === body) {
      finalCount += 1
      if (finalCount > 1 || bodyChildren.at(-1) !== section) throw new Error("Word 最后一节的页面设置位置异常或重复")
    } else if (!isWord(parent, "pPr") || !isWord(parent.parentNode, "p") || parent.parentNode.parentNode !== body ||
      wordChildren(parent.parentNode, "pPr").length !== 1 || wordChildren(parent, "sectPr").length !== 1) {
      throw new Error("Word 页面设置的节位置异常或重复")
    }
  }
  // 只忽略合法挂在当前节下的历史记录；任意位置伪造 sectPrChange 不能用于藏匿损坏元数据。
  for (const change of Array.from(xml.getElementsByTagNameNS(WORD_XML, "sectPrChange"))) {
    if (!accepted.has(change.parentNode) || wordChildren(change.parentNode, "sectPrChange").length !== 1 ||
      getXmlChildren(change).length !== 1 || wordChildren(change, "sectPr").length !== 1) {
      throw new Error("Word 页面设置的修订记录位置异常或重复")
    }
  }
  // pgSz/pgMar 必须直接属于有效 sectPr；只按 getElementsByTagName 取首项会漏掉错位或重复元数据。
  for (const name of ["pgSz", "pgMar"]) for (const node of Array.from(xml.getElementsByTagNameNS(WORD_XML, name))) {
    if (!isHistorical(node) && !accepted.has(node.parentNode)) throw new Error("Word 纸张或页边距设置位置异常")
  }
  const parsed = sections.map((section, index) => readSection(section, index + 1, warnings))
  if (parsed.length > 1 && parsed.some(section => section.signature !== parsed[0].signature)) {
    warnings.add("Word 包含不同的分节纸张或页边距；Mewoc 只支持全局页面设置，已采用第一节设置，请保留原 DOCX")
  }
  return validatePageSettings(parsed[0]?.page || defaultPage())
}

// sectPrChange 中的旧版页面属性不是当前节；跳过整个历史子树，避免它覆盖当前尺寸或误触多节提示。
function isHistorical(node) {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) if (isWord(parent, "sectPrChange")) return true
  return false
}

function readSection(section, number, warnings) {
  const pageSize = uniqueChild(section, "pgSz")
  const pageMargins = uniqueChild(section, "pgMar")
  checkLeaf(pageSize, ["w", "h", "orient", "code"])
  checkLeaf(pageMargins, [...SIDES, "header", "footer", "gutter"])
  const orientation = attribute(pageSize, "orient")
  if (orientation !== undefined && !["portrait", "landscape"].includes(orientation)) throw new Error("Word 纸张方向无效")
  const defaults = getPageDimensions({ size: "A4", orientation: orientation || "portrait" })
  const width = readTwips(pageSize, "w", defaults.widthMm * TWIPS_PER_MM, { positive: true })
  const height = readTwips(pageSize, "h", defaults.heightMm * TWIPS_PER_MM, { positive: true })
  // code 只是打印机纸型标记；实际 w/h 才决定物理尺寸，但显式损坏的 code 仍须拒绝。
  readTwips(pageSize, "code", 0)
  const physicalOrientation = width > height ? "landscape" : "portrait"
  if (orientation && orientation !== physicalOrientation) {
    warnings.add(`Word 第 ${number} 节方向标记与纸面宽高不一致，已按实际宽高恢复方向，请保留原 DOCX`)
  }
  const size = matchPaper(width, height)
  const page = { ...defaultPage(), size: size || "A4", orientation: physicalOrientation }
  if (!size) warnings.add(`Word 第 ${number} 节纸张 ${roundMm(width / TWIPS_PER_MM)} × ${roundMm(height / TWIPS_PER_MM)} mm 暂不支持，已改用 A4 ${physicalOrientation === "landscape" ? "横版" : "竖版"}，请保留原 DOCX`)
  const margins = Object.fromEntries(SIDES.map(side => [side, readTwips(pageMargins, side, 20 * TWIPS_PER_MM, { signed: ["top", "bottom"].includes(side) })]))
  const gutter = readTwips(pageMargins, "gutter", 0)
  readTwips(pageMargins, "header", 0)
  readTwips(pageMargins, "footer", 0)
  if (gutter) warnings.add(`Word 第 ${number} 节的装订线边距暂不支持，已保留四边页边距，装订线未恢复，请保留原 DOCX`)
  page.marginsMm = Object.fromEntries(SIDES.map(side => [side, roundMm(margins[side] / TWIPS_PER_MM)]))
  // 负 top/bottom 在 Word 中表示允许正文与页眉/页脚重叠，不能取绝对值伪装成普通正边距。
  if (SIDES.some(side => margins[side] < 0)) {
    page.marginsMm = defaultPage().marginsMm
    warnings.add(`Word 第 ${number} 节包含负页边距，Mewoc 无法表示该布局，四边已改用 20 mm，请保留原 DOCX`)
  } else {
    const dimensions = getPageDimensions(page)
    const widthAdjusted = repairRoundedBoundary(page.marginsMm, "left", "right", dimensions.widthMm - 40)
    const heightAdjusted = repairRoundedBoundary(page.marginsMm, "top", "bottom", dimensions.heightMm - 40)
    if (widthAdjusted || heightAdjusted) warnings.add(`Word 第 ${number} 节页边距存在 twip 取整误差，已微调边界以保留至少 40 mm 正文区域`)
    try { validatePageSettings(page) }
    catch {
      page.marginsMm = defaultPage().marginsMm
      warnings.add(`Word 第 ${number} 节页边距无法保留至少 40 mm 正文区域，四边已改用 20 mm，请保留原 DOCX`)
    }
  }
  // 受支持纸型先合并容许的 1 twip 差异；其它来源值不以回退后的 page 比较。
  // 两个不同的未知纸型不能因为都变为 A4 就被误判为相同，负边距回退也不能遮蔽多节差异。
  return { page, signature: JSON.stringify({ paper: size || { width, height }, orientation: physicalOrientation, margins, gutter }) }
}

function uniqueChild(section, name) {
  if (getXmlChildren(section).some(node => node.localName === name && node.namespaceURI !== WORD_XML)) {
    throw new Error("Word 纸张或页边距设置的命名空间无效")
  }
  const nodes = wordChildren(section, name)
  if (nodes.length > 1) throw new Error("Word 纸张或页边距设置重复")
  return nodes[0]
}

/** 关键元数据是叶元素；同名无命名空间或伪命名空间属性不能静默变成「没有配置」。 */
function checkLeaf(node, keys) {
  if (!node) return
  if (getXmlChildren(node).length || node.textContent.trim()) throw new Error("Word 纸张或页边距设置包含异常内容")
  for (const attr of Array.from(node.attributes)) {
    if (attr.namespaceURI === XMLNS) continue
    if (attr.namespaceURI !== WORD_XML || !keys.includes(attr.localName)) throw new Error("Word 纸张或页边距设置包含异常属性")
  }
}

function readTwips(node, name, fallback, { signed = false, positive = false } = {}) {
  const raw = attribute(node, name)
  if (raw === undefined) return Math.round(fallback)
  // XML 整数允许前后空白和正号，但不允许指数、十六进制、小数、Infinity 或数值尾随文本。
  const text = raw.trim()
  const value = Number(text)
  if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(value) ||
    value < (signed ? -2147483648 : 0) || value > (signed ? 2147483647 : 4294967295) || (positive && value <= 0)) {
    throw new Error("Word 纸张或页边距数字无效")
  }
  return value
}

// Word/各导出器可能各轴相差 1 twip；匹配的是整数 twip，不用宽松毫米容差吞掉真正的自定义纸型。
function matchPaper(width, height) {
  const short = Math.min(width, height), long = Math.max(width, height)
  return Object.keys(PAGE_SIZES).find(size => {
    const paper = PAGE_SIZES[size]
    return Math.abs(short - Math.round(paper.widthMm * TWIPS_PER_MM)) <= 1 && Math.abs(long - Math.round(paper.heightMm * TWIPS_PER_MM)) <= 1
  })
}

/**
 * 合法 40 mm 边界经过纸张与两边边距分别量化，可能超出约 1 twip。
 * 只对小于两 twip 的超量收窄一侧；先规范为 0.01 mm，再校正，下一轮导出/导入不会继续漂移。
 */
function repairRoundedBoundary(margins, first, last, limit) {
  const excess = margins[first] + margins[last] - limit
  if (excess <= 0 || excess > ROUNDING_MM) return false
  const side = margins[last] >= excess ? last : first
  const other = side === last ? first : last
  margins[side] = Math.max(0, roundMm(limit - margins[other]))
  if (margins[first] + margins[last] > limit) margins[side] = Math.max(0, roundMm(margins[side] - 0.01))
  return true
}
