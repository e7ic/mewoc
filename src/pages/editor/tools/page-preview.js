/**
 * 历史与模板只读预览共用纸张比例和说明，尺寸从文档快照取得而不读取当前编辑会话。
 * 弹窗窄于真实纸张时按纸宽缩小边距；保存的毫米值与正文仍保持原样。
 */
import { getPageDimensions } from "./page-settings.js"
import { getPageFurnitureText, isPageFurnitureActive } from "./page-furniture.js"

export function getPreviewPage(page) {
  const { widthMm, heightMm } = getPageDimensions(page)
  const { top, right, bottom, left } = page.marginsMm
  const furnitureDescription = [["header", "页眉"], ["footer", "页脚"]]
    .filter(([position]) => isPageFurnitureActive(page[position]))
    .map(([position, label]) => ` · ${label}：${getPageFurnitureText(page[position])}`).join("")
  // CSS min 仅用于缩窄预览，宽屏仍显示真实毫米边距；四边使用同一个缩放比例。
  const inset = value => `min(${value}mm, ${value / widthMm * 100}%)`
  return {
    description: `${page.size}${page.orientation === "landscape" ? "横向" : "竖向"} · 页边距：上 ${top} / 右 ${right} / 下 ${bottom} / 左 ${left} mm${page.watermark ? ` · 水印：${page.watermark.text.trim()}` : ""}${furnitureDescription}`,
    style: { width: `${widthMm}mm`, aspectRatio: `${widthMm} / ${heightMm}`, padding: [top, right, bottom, left].map(inset).join(" ") }
  }
}
