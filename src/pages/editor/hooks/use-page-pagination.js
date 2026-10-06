/**
 * 将分页插件的测量结果连接到纸面与状态栏；布局只属于当前编辑会话，不进入文档快照。
 * 正文仍由一个 ProseMirror 视图拥有，页数、纸面高度与页间占位都由同一插件计算。
 */
import { useEffect } from "react"
import { useStore } from "zustand"
import { getPagePagination } from "../extensions/page-pagination.js"
import { getPageDimensions } from "../tools/page-settings.js"

export const PAGE_GAP_PX = 24
const PX_PER_MM = 96 / 25.4

export function usePagePagination(editor, page, store) {
  const pagination = useStore(store, state => state.pagination)
  const { heightMm } = getPageDimensions(page)
  const pageHeightPx = heightMm * PX_PER_MM
  const marginTopPx = page.marginsMm.top * PX_PER_MM
  const marginBottomPx = page.marginsMm.bottom * PX_PER_MM

  // 先订阅再设置纸张参数，接住首次测量；命令和事件都不修改正文或增加保存修订。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined
    const publish = layout => store.getState().updateView({ pagination: layout })
    editor.on("paginationUpdate", publish)
    const current = getPagePagination(editor)
    if (current) publish(current)
    return () => {
      editor.off("paginationUpdate", publish)
      // 单个 PaperCanvas 关闭后移除仅供分页视图使用的装饰，编辑器若已销毁则无需派发。
      if (!editor.isDestroyed) editor.commands.setPaginationSettings({ enabled: false })
    }
  }, [editor, store])

  // 缩放不参与实际正文排版。只有纸型、方向和上下边距改变才重新设置物理页面预算。
  // 左右边距通过 PaperCanvas 的正文宽度作用于真实 DOM，再由插件的尺寸观察触发测量。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.commands.setPaginationSettings({ enabled: true, pageHeightPx, marginTopPx, marginBottomPx, gapPx: PAGE_GAP_PX })
  }, [editor, pageHeightPx, marginTopPx, marginBottomPx])

  // 初次排版前保留一张标准纸，正文从不裁切；插件首轮测量后用实际页层替换占位。
  return pagination || {
    pages: [{ index: 0, top: 0, height: pageHeightPx, overflow: false }],
    pageCount: 1, overflowCount: 0, contentHeight: 0, status: "pending", breaks: [], constraintCount: 0
  }
}
