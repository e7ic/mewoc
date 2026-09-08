import { useCallback, useEffect, useRef } from "react"

/**
 * 弹窗会抢走正文焦点，因此打开前捕获选区，确认时再解析到当前文档。
 * bookmark 随每次事务映射，不能直接复用旧 from/to；原起点被删除后返回 null。
 * 只在弹窗打开期间监听，调用方在确认或取消时清空书签。
 */
export function useSelectionBookmark(editor, open) {
  const selectionRef = useRef(null)

  const captureSelection = useCallback(() => {
    const selection = editor.state.selection
    selectionRef.current = { bookmark: selection.getBookmark(), from: selection.from, deleted: false }
  }, [editor])

  const getSelection = useCallback(() => {
    const current = selectionRef.current
    if (!current || current.deleted) return null
    return current.bookmark.resolve(editor.state.doc)
  }, [editor])

  const clearSelection = useCallback(() => { selectionRef.current = null }, [])

  useEffect(() => {
    if (!open) return
    const handleTransaction = ({ transaction }) => {
      const current = selectionRef.current
      if (!current) return
      const mapped = transaction.mapping.mapResult(current.from)
      current.deleted = current.deleted || mapped.deleted
      current.from = mapped.pos
      current.bookmark = current.bookmark.map(transaction.mapping)
    }
    editor.on("transaction", handleTransaction)
    return () => editor.off("transaction", handleTransaction)
  }, [editor, open])

  return { captureSelection, getSelection, clearSelection }
}
