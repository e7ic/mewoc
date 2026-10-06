/**
 * 编辑纸面、历史和模板预览共用的单次文字水印。
 * SVG viewBox 使用毫米纸张尺寸，小预览会随实际纸面同比缩放；字号与导出共享几何计算。
 * 水印独立于可编辑正文，既不截获鼠标，也不进入选区、统计、复制或正文撤销历史。
 */
import { getWatermarkGeometry, WATERMARK_FONT_FAMILY } from "../tools/page-watermark.js"
import styles from "../sass/page-watermark.module.scss"

export function PageWatermark({ page }) {
  const watermark = page?.watermark
  // 表单预览可能处于空数字或未完成的输入阶段；无效草稿不生成畸形 SVG，提交仍由页面契约校验。
  if (!watermark || !watermark.text?.trim() || !/^#[0-9a-f]{6}$/i.test(watermark.color)
    || !Number.isFinite(watermark.opacity) || !Number.isFinite(watermark.angle)) return null
  const geometry = getWatermarkGeometry(page)
  return <svg className={styles.watermark} data-mewoc-watermark="" aria-hidden="true" focusable="false" contentEditable={false}
    viewBox={`0 0 ${geometry.widthMm} ${geometry.heightMm}`} preserveAspectRatio="xMidYMid meet">
    <text data-watermark-text="" x={geometry.centerX} y={geometry.centerY} textAnchor="middle" dominantBaseline="central"
      transform={`rotate(${watermark.angle} ${geometry.centerX} ${geometry.centerY})`}
      style={{ fontFamily: WATERMARK_FONT_FAMILY, fontSize: geometry.fontSizeMm, fill: watermark.color, opacity: watermark.opacity }}>
      {watermark.text.trim()}
    </text>
  </svg>
}
