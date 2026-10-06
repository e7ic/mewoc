/**
 * 为宽于视口的工具栏提供左右翻页，依据真实布局测量箭头可用性。
 * 内容变化、字体加载、窗口尺寸和标签切换都可能改变溢出，因此同时观察容器、视口与内容。
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react"
import clsx from "clsx"
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react"
import { getToolbarOverflowState, getToolbarPageScroll } from "../tools/toolbar-overflow.js"
import styles from "../sass/toolbar-overflow.module.scss"

export function ToolbarOverflow({ children, className, activeKey }) {
  // 三个 DOM ref 区分外层可用宽度、滚动视口与完整内容宽度；frameRef 合并同帧尺寸回调。
  const containerRef = useRef(null)
  const viewportRef = useRef(null)
  const contentRef = useRef(null)
  const frameRef = useRef(0)
  const [edges, setEdges] = useState({ hasOverflow: false, canScrollLeft: false, canScrollRight: false })

  // 扣除容器 padding 计算可用宽度，再交给边界函数判断溢出；结果相同保留旧 state 避免无效渲染。
  const measure = useCallback(() => {
    const viewport = viewportRef.current
    const container = containerRef.current
    if (!viewport || !container) return
    const css = getComputedStyle(container)
    const availableWidth = container.clientWidth - Number.parseFloat(css.paddingLeft || "0") - Number.parseFloat(css.paddingRight || "0")
    const next = getToolbarOverflowState({
      scrollLeft: viewport.scrollLeft, scrollWidth: viewport.scrollWidth,
      clientWidth: viewport.clientWidth, availableWidth
    })
    setEdges(previous => previous.hasOverflow === next.hasOverflow && previous.canScrollLeft === next.canScrollLeft && previous.canScrollRight === next.canScrollRight ? previous : next)
  }, [])

  // 按一屏工具的滚动量翻页，保留平滑滚动；箭头不夺正文焦点，因此不影响格式操作目标。
  const handlePage = direction => {
    const viewport = viewportRef.current
    if (!viewport) return
    const left = getToolbarPageScroll(viewport, direction)
    viewport.scrollTo({ left, behavior: "smooth" })
  }

  // 绘制前初始化测量，后续 ResizeObserver 回调合并到动画帧；卸载解除观察并取消待测量帧。
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0
        measure()
      })
    })
    // 内容宽度会随字体加载、选中节点工具和展开状态改变，不能只观察外层窗口尺寸。
    for (const element of [containerRef.current, viewportRef.current, contentRef.current]) observer.observe(element)
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
  }, [measure])

  // 切标签或工具栏模式时回到左侧起点，让用户看到该组的首批工具，然后重算边界。
  useLayoutEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollLeft = 0
    measure()
  }, [activeKey, measure])

  useLayoutEffect(() => {
    // 箭头在正常布局里占位，出现左箭头后可见宽度也会改变，需要在本轮布局后复核右侧边界。
    measure()
  }, [children, edges.hasOverflow, edges.canScrollLeft, measure])

  // 左箭头仅在能回退时占位；发生溢出时保留右箭头，滚到末端后禁用，减少工具栏宽度反复跳变。
  return (
    <div ref={containerRef} className={clsx(styles.container, className)}>
      {edges.canScrollLeft && <button type="button" className={styles.arrow} data-toolbar-overflow-arrow="left"
        title="向左查看更多工具" aria-label="向左查看更多工具"
        onMouseDown={event => event.preventDefault()} onClick={() => handlePage("left")}><IconChevronLeft aria-hidden="true" /></button>}
      <div ref={viewportRef} className={styles.viewport} tabIndex={0} role="region" aria-label="可滚动工具栏" onScroll={measure}>
        <div ref={contentRef} className={styles.content}>{children}</div>
      </div>
      {edges.hasOverflow && <button type="button" className={styles.arrow} data-toolbar-overflow-arrow="right" disabled={!edges.canScrollRight}
        title="向右查看更多工具" aria-label="向右查看更多工具"
        onMouseDown={event => event.preventDefault()} onClick={() => handlePage("right")}><IconChevronRight aria-hidden="true" /></button>}
    </div>
  )
}
