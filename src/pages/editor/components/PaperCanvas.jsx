/**
 * 一个可编辑正文覆盖多张独立纸面。分页插件只增加屏幕占位，不复制正文或改变文档结构。
 * 每张纸面单独呈现页眉、页脚和水印；超高整块展开所在编辑页，保证正文完整可见。
 */
import { useEffect, useRef } from "react"
import { EditorContent } from "@tiptap/react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { PageWatermark } from "./PageWatermark.jsx"
import { PageFurniture } from "./PageFurniture.jsx"
import { getPageDimensions } from "../tools/page-settings.js"
import { usePagePagination } from "../hooks/use-page-pagination.js"
import styles from "../sass/paper.module.scss"
import "../sass/content.scss"
import "../sass/editor-interaction.scss"
import "../sass/page-pagination.scss"

const PX_PER_MM = 96 / 25.4

export function PaperCanvas() {
  const viewportRef = useRef(null)
  const { editor, store } = useDocumentEditor()
  const page = useEditorStore(state => state.page)
  const zoom = useEditorStore(state => state.zoom)
  const fitWidth = useEditorStore(state => state.fitWidth)
  const pagination = usePagePagination(editor, page, store)
  const { widthMm, heightMm } = getPageDimensions(page)
  // CSS 绝对单位按 96 px/in 换算。缩放仅作用于视觉容器，不改变插件的纸面排版预算。
  const width = widthMm * PX_PER_MM
  const pageHeight = heightMm * PX_PER_MM
  const margins = page.marginsMm
  const pages = pagination.pages?.length ? pagination.pages : [{ index: 0, top: 0, height: pageHeight, overflow: false }]
  const lastPage = pages[pages.length - 1]
  const height = Math.max(pageHeight, lastPage.top + lastPage.height)

  // 自动适宽沿用 50%–150% 范围；纸型/方向改变时重算，视口的左右留白始终各 32px。
  useEffect(() => {
    if (!fitWidth) return undefined
    const viewport = viewportRef.current
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (viewportRef.current !== viewport) return
        const nextZoom = Math.max(0.5, Math.min(1.5, (viewport.clientWidth - 64) / width))
        store.getState().updateView({ zoom: nextZoom })
      })
    })
    observer.observe(viewport)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [fitWidth, width, store])

  return (
    <div ref={viewportRef} className={styles.container}>
      <div className={styles.label}><span>文档编辑</span><span>{page.size} · {widthMm} × {heightMm} mm</span></div>
      <div className={styles.frame} style={{ width: width * zoom, height: (height + 28) * zoom }}>
        <div className={styles.sheet} style={{ width, transform: `scale(${zoom})` }}>
          <div className={styles.ruler} aria-hidden="true">
            {Array.from({ length: Math.floor(widthMm / 10) }, (_, index) => <span key={index}>{index}</span>)}
          </div>
          <div className={styles.paper} data-mewoc-editor-surface="" data-mewoc-pagination-status={pagination.status}
            style={{ minHeight: pageHeight, height, padding: `${margins.top}mm ${margins.right}mm 0 ${margins.left}mm` }}>
            {/* 底层纸面不接收鼠标、不进入选区；页间空隙露出画布本色，正文仍是一份连续编辑视图。 */}
            <div className={styles.pageLayers} data-mewoc-page-layer="" aria-hidden="true">
              {pages.map(sheetPage => <div key={sheetPage.index} className={styles.page}
                data-mewoc-page-index={sheetPage.index} data-mewoc-page-overflow={sheetPage.overflow ? "true" : "false"}
                style={{ top: sheetPage.top, height: sheetPage.height }}>
                {/* 展开页的水印保持原纸型大小，整体平移到该编辑页中部，不撑高或改变正文。 */}
                <div className={styles.watermarkLayer} style={{ top: Math.max(0, (sheetPage.height - pageHeight) / 2) }}><PageWatermark page={page} /></div>
                <PageFurniture page={page} pageNumber={sheetPage.index + 1} pageTotal={pages.length} />
                {sheetPage.overflow && <span className={styles.overflowLabel} data-mewoc-overflow-label="">超高内容页</span>}
              </div>)}
            </div>
            <div className={styles.paperContent} data-mewoc-editor-body=""><EditorContent editor={editor} /></div>
          </div>
        </div>
      </div>
    </div>
  )
}
