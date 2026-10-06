/** 编辑、缩略预览、HTML 与 Word 共用的水印物理几何，避免每个出口自行估算字号。 */
import { getPageDimensions } from "./page-settings.js"

export const WATERMARK_FONT_FAMILY = 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif'

export function getWatermarkGeometry(page) {
  const { widthMm, heightMm } = getPageDimensions(page)
  const text = page.watermark?.text.trim() || ""
  // 每个 Unicode 码点预留一个 em，比按 ASCII 宽度估计中文更保守；不把代理对当成两个字。
  const units = Math.max(1, Array.from(text).length)
  const angle = (page.watermark?.angle || 0) * Math.PI / 180
  const cosine = Math.abs(Math.cos(angle))
  const sine = Math.abs(Math.sin(angle))
  // 同时约束旋转后的横/纵包围盒，±90° 与最长 80 字仍完整落在纸面；长文字没有强制最小字号。
  const fontSizeMm = Math.min(18, widthMm * 0.78 / (units * cosine + 1.2 * sine), heightMm * 0.78 / (units * sine + 1.2 * cosine))
  return { widthMm, heightMm, centerX: widthMm / 2, centerY: heightMm / 2,
    fontSizeMm, fontSizePt: fontSizeMm * 72 / 25.4, textWidthMm: units * fontSizeMm, textHeightMm: 1.2 * fontSizeMm }
}

/** 使用普通 XML/HTML 实体，不允许标题或水印文本成为标签、属性、脚本。 */
export const escapePageText = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

/** 静态 SVG 不含事件或外部资源，文本与属性都来自已校验页面快照。 */
export function createWatermarkSvg(page) {
  if (!page.watermark) return ""
  const geometry = getWatermarkGeometry(page)
  const { text, color, opacity, angle } = page.watermark
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${geometry.widthMm} ${geometry.heightMm}" aria-hidden="true" focusable="false"><text x="${geometry.centerX}" y="${geometry.centerY}" text-anchor="middle" dominant-baseline="central" font-family="${escapePageText(WATERMARK_FONT_FAMILY)}" font-size="${geometry.fontSizeMm}" fill="${color}" opacity="${opacity}" transform="rotate(${angle} ${geometry.centerX} ${geometry.centerY})">${escapePageText(text.trim())}</text></svg>`
}
