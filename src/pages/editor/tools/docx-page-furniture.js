/** Mewoc 原生 Word 页眉、页脚与页码：保留字段语义，装饰不进入正文。 */
import * as sdk from "docx"
import { createDocxWatermarkParagraph } from "./docx-watermark.js"
import { getPageFurnitureFontPt, isPageFurnitureActive } from "./page-furniture.js"

export const DOCX_FURNITURE_TAGS = Object.freeze({ header: "MewocPageHeader_v1", footer: "MewocPageFooter_v1" })
const FONT = Object.freeze({ ascii: "Arial", hAnsi: "Arial", eastAsia: "PingFang SC" })
const element = (name, attributes = {}, children = []) => new sdk.BuilderElement({
  name, attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, { key, value }])), children
})

/** 水印与普通页眉共用一个 Header；不能分别设置 default 关系而覆盖另一种装饰。 */
export function createDocxPageFurniture(page) {
  const header = []
  const watermark = createDocxWatermarkParagraph(page)
  if (watermark) header.push(watermark)
  if (isPageFurnitureActive(page.header)) header.push(createControl(page, "header"))
  const result = {}
  if (header.length) result.headers = { default: new sdk.Header({ children: header }) }
  if (isPageFurnitureActive(page.footer)) result.footers = { default: new sdk.Footer({ children: [createControl(page, "footer")] }) }
  return result
}

/** 页内容位于相应边距中央；距纸边距离不能沿用 SDK 的 12.7 mm 默认值挤入正文。 */
export function getDocxFurnitureDistances(page) {
  const result = {}
  for (const [kind, side] of [["header", "top"], ["footer", "bottom"]]) {
    if (!isPageFurnitureActive(page[kind])) continue
    const fontPt = getFontHalfPoints(page, page[kind]) / 2
    const distanceMm = page.marginsMm[side] / 2 - fontPt * 1.2 * 25.4 / 72 / 2
    result[kind] = Math.round(distanceMm * 1440 / 25.4)
  }
  return result
}

function getFontHalfPoints(page, furniture) {
  return Math.floor(getPageFurnitureFontPt(page, furniture) * 2)
}

function createControl(page, kind) {
  const furniture = page[kind]
  const size = getFontHalfPoints(page, furniture)
  const text = value => new sdk.TextRun({ text: value, font: FONT, size, color: "626777" })
  // fldSimple 有原生 PAGE / NUMPAGES 指令和缓存文字。Word 可更新，未更新时仍是完整可见内容。
  const field = instruction => element("w:fldSimple", { "w:instr": instruction }, [text("1")])
  const children = []
  if (furniture.text.trim()) children.push(text(furniture.text.trim()))
  if (furniture.pageNumber !== "none") {
    if (children.length) children.push(text(" · "))
    children.push(text("第 "), field("PAGE"))
    if (furniture.pageNumber === "page-total") children.push(text(" / "), field("NUMPAGES"))
    children.push(text(" 页"))
  }
  const paragraph = new sdk.Paragraph({ children, alignment: furniture.alignment,
    spacing: { before: 0, after: 0, line: Math.round(size / 2 * 1.2 * 20), lineRule: "exact" } })
  // 标记只提供识别入口。导入还检查完整单段、字体、对齐、中文文字与字段结构，不能凭标签吞内容。
  return element("w:sdt", {}, [element("w:sdtPr", {}, [element("w:tag", { "w:val": DOCX_FURNITURE_TAGS[kind] })]),
    element("w:sdtContent", {}, [paragraph])])
}
