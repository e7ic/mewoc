/**
 * 按当前纸张规格展示连续正文，独立处理毫米到像素换算、视图缩放与滚动区域尺寸。
 * 正文内容尺寸始终保持文档原始比例，缩放仅作用于视觉容器，不修改保存数据。
 */
import { useEffect, useRef, useState } from "react"
import { EditorContent } from "@tiptap/react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { PageWatermark } from "./PageWatermark.jsx"
import { getPageDimensions } from "../tools/page-settings.js"
import styles from "../sass/paper.module.scss"
import "../sass/content.scss"
import "../sass/editor-interaction.scss"

/**
 * 纸张内部按实际尺寸排版，sheet 用 transform 缩放，frame 用缩放后的宽高撑开滚动空间。
 * ResizeObserver 跟踪连续正文高度；这里没有分页排版，也不据容器高度推算页数。
 */
export function PaperCanvas() {
  // height 是纸张实测高度；paperRef 用于内容测量，viewportRef 用于计算可见宽度。
  // 默认高度保证首次测量前已有合理滚动空间，后续随正文增长更新。
  const [height, setHeight] = useState(1123)
  const paperRef = useRef(null)
  const viewportRef = useRef(null)
  const { editor, store } = useDocumentEditor()
  const page = useEditorStore(state => state.page)
  const zoom = useEditorStore(state => state.zoom)
  const fitWidth = useEditorStore(state => state.fitWidth)
  const { widthMm, heightMm } = getPageDimensions(page)
  // 浏览器 CSS 绝对单位按 96 px/in 换算，纸张缩放不改文档数据。
  const width = widthMm * 96 / 25.4
  const margins = page.marginsMm

  // 观察正文实际高度以同步缩放后的外框；清理观察器和待执行帧，避免卸载后继续测量。
  useEffect(() => {
    const paper = paperRef.current
    let frame = 0
    // 将测量后的 React 更新合并到下一帧，避免在同一轮 ResizeObserver 回调中反复布局。
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (paperRef.current === paper) setHeight(paper.offsetHeight)
      })
    })
    observer.observe(paper)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  // 适应宽度模式才持续追踪视口；纸张方向改变导致 width 改变时重建观察，重新计算缩放。
  useEffect(() => {
    if (!fitWidth) return
    const viewport = viewportRef.current
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (viewportRef.current !== viewport) return
        // 扣除视口左右各 32px 留白，保持与纸张容器 padding 一致，并沿用 50%–150% 范围。
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

  // frame 预留缩放后的滚动占位，sheet 保持未缩放的排版宽度；标尺只是辅助视觉，不参与正文。
  return (
    <div ref={viewportRef} className={styles.container}>
      <div className={styles.label}><span>文档编辑</span><span>{page.size} · {widthMm} × {heightMm} mm</span></div>
      <div className={styles.frame} style={{ width: width * zoom, height: (height + 28) * zoom }}>
        <div className={styles.sheet} style={{ width, transform: `scale(${zoom})` }}>
          <div className={styles.ruler} aria-hidden="true">
            {Array.from({ length: Math.floor(widthMm / 10) }, (_, index) => <span key={index}>{index}</span>)}
          </div>
          <div
            ref={paperRef}
            className={styles.paper}
            data-mewoc-editor-surface=""
            style={{ minHeight: `${heightMm}mm`, padding: `${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm` }}
          >
            {/* 水印固定于首个物理纸面；内容变长只延伸正文，不按高度生成重复水印或虚构页数。 */}
            <PageWatermark page={page} />
            <div className={styles.paperContent}><EditorContent editor={editor} /></div>
          </div>
        </div>
      </div>
    </div>
  )
}
