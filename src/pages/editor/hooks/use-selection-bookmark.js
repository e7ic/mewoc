/** 弹窗和正文之间的选区桥梁：保存原选区书签，在打开期间按监听到的事务映射逻辑位置。 */
import { useCallback, useEffect, useRef } from "react"

/**
 * 弹窗会抢走正文焦点，因此打开前捕获选区，确认时再解析到当前文档。
 * bookmark 按 transaction 事件中的映射更新，不能直接复用旧 from/to；原起点被删除后返回 null。
 * 只在弹窗打开期间监听，调用方在确认或取消时清空书签。
 */
export function useSelectionBookmark(editor, open) {
  const selectionRef = useRef(null)

  // 必须在弹窗夺走焦点前调用；from 额外用于判断原目标是否被删除。
  const captureSelection = useCallback(() => {
    const selection = editor.state.selection
    selectionRef.current = { bookmark: selection.getBookmark(), from: selection.from, deleted: false }
  }, [editor])

  // 确认时解析书签；无捕获记录或目标已删除时返回 null，由调用方提示重新选择位置。
  const getSelection = useCallback(() => {
    const current = selectionRef.current
    if (!current || current.deleted) return null
    return current.bookmark.resolve(editor.state.doc)
  }, [editor])

  // 关闭或提交后清空，避免下次打开误用上一轮选区。
  const clearSelection = useCallback(() => { selectionRef.current = null }, [])

  // 只在打开期间监听，效果清理与 editor 变更都会解绑原实例。
  useEffect(() => {
    if (!open) return
    const handleTransaction = ({ transaction }) => {
      const current = selectionRef.current
      if (!current) return
      const mapped = transaction.mapping.mapResult(current.from)
      // 删除标记不可逆，即使之后撤销删除也不让一次已失效的弹窗操作重新获得提交资格。
      current.deleted = current.deleted || mapped.deleted
      current.from = mapped.pos
      current.bookmark = current.bookmark.map(transaction.mapping)
    }
    editor.on("transaction", handleTransaction)
    return () => editor.off("transaction", handleTransaction)
  }, [editor, open])

  return { captureSelection, getSelection, clearSelection }
}
