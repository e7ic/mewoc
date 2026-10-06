/**
 * 页眉页脚是页面装饰，不作为正文节点导出。静态 HTML 保留单份示意；
 * 打印交给 @page 的边距框与 page/pages 原生计数，不能按正文字符猜页数。
 */
import { getPageDimensions } from "./page-settings.js"
import { isPageFurnitureActive, getPageFurnitureFontPt, getPageFurnitureText } from "./page-furniture.js"
import { escapePageText } from "./page-watermark.js"

export const PAGE_FURNITURE_PRINT_HINT = "页眉、页脚与页码打印需要支持页面边距框的浏览器（Chrome 131 或以上）；请关闭系统打印的页眉和页脚。"

// CSS 字符串和 HTML 文本属于不同上下文；逐码点十六进制编码同时阻止引号、反斜杠与 </style> 闭合。
export function escapeCssPageText(text) {
  return `"${Array.from(text, character => `\\${character.codePointAt(0).toString(16)} `).join("")}"`
}

export function hasPageFurniture(page) {
  return [page.header, page.footer].some(isPageFurnitureActive)
}

function createContent(furniture) {
  const text = furniture.text.trim()
  const parts = text ? [escapeCssPageText(text)] : []
  if (furniture.pageNumber !== "none") {
    parts.push(escapeCssPageText(text ? " · 第 " : "第 "), "counter(page)")
    if (furniture.pageNumber === "page-total") parts.push(escapeCssPageText(" / "), "counter(pages)")
    parts.push(escapeCssPageText(" 页"))
  }
  return parts.join(" ")
}

/** 每侧只用一个全宽边距框，其余两个置空；不让三个 flex 盒把长文字挤出纸边。 */
export function createPageFurnitureExport(page) {
  if (!hasPageFurniture(page)) return { marginBoxes: "", furniture: "", hint: "", styles: "" }
  const { widthMm } = getPageDimensions(page)
  const innerWidth = widthMm - page.marginsMm.left - page.marginsMm.right
  const marginBoxes = []
  const furniture = []
  for (const [key, edge] of [["header", "top"], ["footer", "bottom"]]) {
    const value = page[key]
    const active = isPageFurnitureActive(value)
    // 始终用 center 的全宽框，文字对齐独立设置。页码与普通文字共用一行、一份字号预算。
    for (const slot of ["left", "center", "right"]) {
      const content = active && slot === "center" ? createContent(value) : "none"
      marginBoxes.push(`@${edge}-${slot} { content: ${content};${active && slot === "center" ? ` width: ${innerWidth}mm; font-family: Arial, "PingFang SC", sans-serif; font-size: ${getPageFurnitureFontPt(page, value)}pt; line-height: 1.2; color: #626777; text-align: ${value.alignment}; vertical-align: middle; white-space: nowrap;` : ""} }`)
    }
    if (active) {
      furniture.push(`<div class="mewoc-export-${key}" data-mewoc-page-${key}="" aria-hidden="true" style="height:${page.marginsMm[edge]}mm;left:${page.marginsMm.left}mm;right:${page.marginsMm.right}mm;font-size:${getPageFurnitureFontPt(page, value)}pt;text-align:${value.alignment}"><span>${escapePageText(getPageFurnitureText(value))}</span></div>`)
    }
  }
  return {
    marginBoxes: marginBoxes.join("\n"), furniture: furniture.join(""),
    hint: `<p class="mewoc-export-furniture-hint">编辑纸面和网页中的页码为示意；实际页码与总页数由打印或 Word 排版生成。${PAGE_FURNITURE_PRINT_HINT}</p>`,
    styles: `.mewoc-export-header, .mewoc-export-footer { position: absolute; display: flex; align-items: center; pointer-events: none; user-select: none; font-family: Arial, "PingFang SC", sans-serif; line-height: 1.2; color: #626777; white-space: nowrap; }
.mewoc-export-header { top: 0; } .mewoc-export-footer { bottom: 0; }
.mewoc-export-header span, .mewoc-export-footer span { width: 100%; }
.mewoc-export-furniture-hint { max-width: ${widthMm}mm; margin: 12px auto; color: #626777; font: 12px/1.6 Arial, "PingFang SC", sans-serif; }
@media print { .mewoc-export-header, .mewoc-export-footer, .mewoc-export-furniture-hint { display: none; } }`
  }
}

/** CSS.supports 不检测嵌套 at-rule；只检查解析出的真实页边距规则，不猜浏览器版本。 */
export function supportsPageMarginBoxes() {
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync('@page { @top-center { content: "Mewoc"; } }')
    return sheet.cssRules[0]?.cssRules?.[0]?.name === "top-center"
  } catch { return false }
}
