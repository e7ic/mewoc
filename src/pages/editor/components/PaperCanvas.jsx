import { useEffect, useRef, useState } from "react"
import { EditorContent } from "@tiptap/react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/paper.module.scss"
import "../sass/content.scss"

/**
 * 纸张内部按实际尺寸排版，sheet 用 transform 缩放，frame 用缩放后的宽高撑开滚动空间。
 * ResizeObserver 跟踪连续正文高度；这里没有分页排版，也不据容器高度推算页数。
 */
export function PaperCanvas() {
  const [height, setHeight] = useState(1123)
  const paperRef = useRef(null)
  const viewportRef = useRef(null)
  const { editor, store } = useDocumentEditor()
  const page = useEditorStore(state => state.page)
  const zoom = useEditorStore(state => state.zoom)
  const fitWidth = useEditorStore(state => state.fitWidth)
  const widthMm = page.orientation === "portrait" ? 210 : 297
  const heightMm = page.orientation === "portrait" ? 297 : 210
  // 浏览器 CSS 绝对单位按 96 px/in 换算，纸张缩放不改文档数据。
  const width = widthMm * 96 / 25.4
  const margins = page.marginsMm

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

  return (
    <div ref={viewportRef} className={styles.container}>
      <div className={styles.label}><span>文档编辑</span><span>A4 · {page.orientation === "portrait" ? "210 × 297" : "297 × 210"} mm</span></div>
      <div className={styles.frame} style={{ width: width * zoom, height: (height + 28) * zoom }}>
        <div className={styles.sheet} style={{ width, transform: `scale(${zoom})` }}>
          <div className={styles.ruler} aria-hidden="true">
            {Array.from({ length: Math.floor(widthMm / 10) }, (_, index) => <span key={index}>{index}</span>)}
          </div>
          <div
            ref={paperRef}
            className={styles.paper}
            style={{ minHeight: `${heightMm}mm`, padding: `${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm` }}
          >
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
      <p className={styles.hint}>文字留在这里，想法可以去更远的地方。</p>
    </div>
  )
}
