/**
 * 编辑、历史、模板和 Word 导入预览的非交互页眉页脚装饰。
 * 编辑页由分页布局传入实际编号；历史、模板和导入缩略预览保留默认示意字符串。
 * SVG 按实际毫米纸宽缩放，缩略预览无需复制正文或调整持久数据。
 */
import { getPageDimensions } from "../tools/page-settings.js"
import { getPageFurnitureFontPt, getPageFurnitureText, isPageFurnitureActive } from "../tools/page-furniture.js"
import styles from "../sass/page-furniture.module.scss"

export function PageFurniture({ page, pageNumber, pageTotal }) {
  const { widthMm } = getPageDimensions(page)
  return <>{["header", "footer"].map(position => {
    const furniture = page[position]
    if (!isPageFurnitureActive(furniture)) return null
    // 弹窗可能暂存超长文字或不够的边距；预览不崩溃，提交由共享契约给出可操作错误。
    let fontPt
    try { fontPt = getPageFurnitureFontPt(page, furniture) } catch { return null }
    const left = Math.max(0, Number(page.marginsMm.left) || 0)
    const right = Math.max(0, Number(page.marginsMm.right) || 0)
    const margin = Math.max(0, Number(page.marginsMm[position === "header" ? "top" : "bottom"]) || 0)
    const x = furniture.alignment === "left" ? left : furniture.alignment === "right" ? widthMm - right : (widthMm + left - right) / 2
    const y = margin / 2
    const anchor = { left: "start", center: "middle", right: "end" }[furniture.alignment]
    return <svg key={position} className={`${styles.furniture} ${styles[position]}`} data-mewoc-page-furniture={position}
      aria-hidden="true" focusable="false" contentEditable={false} viewBox={`0 0 ${widthMm} ${margin}`} preserveAspectRatio="xMidYMid meet">
      <text data-page-furniture-text="" x={x} y={y} textAnchor={anchor} dominantBaseline="central"
        style={{ fontFamily: 'Arial, "PingFang SC", sans-serif', fontSize: fontPt * 25.4 / 72, fill: "#626777" }}>
        {getPageFurnitureText(furniture, { ...(pageNumber !== undefined && { pageNumber }), ...(pageTotal !== undefined && { pageTotal }) })}
      </text>
    </svg>
  })}</>
}
