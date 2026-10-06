/** 静态 HTML 的物理纸张和水印规则；屏幕和打印复用同一层，打印不复制正文或额外插入一份水印。 */
import { getPageDimensions } from "./page-settings.js"
import { createWatermarkSvg } from "./page-watermark.js"
import { createPageFurnitureExport } from "./page-furniture-export.js"

export function createPageExportLayout(page) {
  const { widthMm, heightMm } = getPageDimensions(page)
  const { top, right, bottom, left } = page.marginsMm
  const furniture = createPageFurnitureExport(page)
  // 浏览器 @page 的内容区已扣边距，print 时清掉屏幕模拟纸面的 padding，不能再扣一次。
  const styles = `@page { size: ${widthMm}mm ${heightMm}mm; margin: ${top}mm ${right}mm ${bottom}mm ${left}mm;${furniture.marginBoxes ? ` ${furniture.marginBoxes}` : ""} }
body { margin: 0; background: #fff; }
.mewoc-export-page { position: relative; isolation: isolate; box-sizing: border-box; width: ${widthMm}mm; min-height: ${heightMm}mm; margin: 0 auto; padding: ${top}mm ${right}mm ${bottom}mm ${left}mm; }
.mewoc-export-page > .mewoc-content { position: relative; z-index: 1; }
.mewoc-export-watermark { position: absolute; top: 0; left: 0; width: ${widthMm}mm; height: ${heightMm}mm; pointer-events: none; user-select: none; z-index: 0; }
.mewoc-export-watermark svg { display: block; width: 100%; height: 100%; overflow: visible; }
.mewoc-export-watermark img { display: none; width: 100%; height: 100%; }
@media print {
  .mewoc-export-page { width: auto; min-height: 0; margin: 0; padding: 0; isolation: auto; }
  .mewoc-export-watermark { position: fixed; left: -${left}mm; top: -${top}mm; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .mewoc-export-watermark svg { display: none; }
  .mewoc-export-watermark img { display: block; }
}\n${furniture.styles}`
  // Chrome 实际 PDF 会把 fixed 层内的行内 SVG 多页副本叠在首张纸上。
  // 同一安全 SVG 以 data 图片供打印绘制，屏幕仍显示可检查的 SVG；两个表示只显示其中一个。
  const svg = createWatermarkSvg(page)
  const watermark = svg ? `<div class="mewoc-export-watermark" aria-hidden="true">${svg}<img src="data:image/svg+xml,${encodeURIComponent(svg)}" alt="" /></div>` : ""
  return { styles, watermark, furniture: furniture.furniture, furnitureHint: furniture.hint }
}
