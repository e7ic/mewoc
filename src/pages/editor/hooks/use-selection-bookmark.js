import { useCallback, useEffect, useRef } from "react"

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
