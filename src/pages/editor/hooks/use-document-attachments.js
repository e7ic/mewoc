import { useCallback, useEffect, useRef, useState } from "react"
import { message } from "antd"
import { readAttachmentFile, createDocumentAssetUrl } from "../tools/attachment-assets.js"
import { canInsertAttachment, insertAttachmentNode } from "../tools/attachment-commands.js"
import { checkAssetCapacity } from "../tools/document-schema.js"

export function useDocumentAttachments(editor, assets, store, assetTaskRef) {
  const [attachmentUploading, setAttachmentUploading] = useState(false)
  const mountedRef = useRef(true)
  const cleanupRef = useRef(null)

  const insertAttachment = useCallback(async file => {
    if (assetTaskRef.current || store.getState().readOnly || store.getState().switching) return false
    if (!canInsertAttachment(editor, editor?.state.selection)) {
      message.info("请将光标放在普通文字段落中插入附件")
      return false
    }
    assetTaskRef.current = true
    setAttachmentUploading(true)
    const target = trackAttachmentSelection(editor, store)
    cleanupRef.current = target.clear
    let asset = null
    let inserted = false
    try {
      checkAssetCapacity(editor.getJSON(), assets, file.size)
      asset = await readAttachmentFile(file)
      if (!mountedRef.current || editor.isDestroyed || !editor.isEditable || target.cancelled()) return false
      const selection = target.getSelection()
      if (!canInsertAttachment(editor, selection)) return false
      checkAssetCapacity(editor.getJSON(), assets, asset.byteLength)
      asset.url = createDocumentAssetUrl(asset)
      assets.set(asset.id, asset)
      // 插入会替换原选区，先结束监听，避免把自己的事务当成目标被删除。
      target.clear()
      inserted = insertAttachmentNode(editor, selection, asset.id)
      if (!inserted) throw new Error("附件未能插入，请重新选择插入位置")
      editor.commands.focus()
      return true
    } catch (error) {
      if (mountedRef.current && !target.cancelled()) message.error(error.message)
      return false
    } finally {
      target.clear()
      cleanupRef.current = null
      if (asset && !inserted) {
        assets.delete(asset.id)
        if (asset.url) URL.revokeObjectURL(asset.url)
      }
      assetTaskRef.current = false
      if (mountedRef.current) setAttachmentUploading(false)
    }
  }, [editor, assets, store, assetTaskRef])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cleanupRef.current?.()
    }
  }, [])

  return { insertAttachment, attachmentUploading }
}

function trackAttachmentSelection(editor, store) {
  let selection = editor.state.selection
  let bookmark = selection.getBookmark()
  let cancelled = false
  const handleTransaction = ({ transaction }) => {
    if (!editor.isEditable) cancelled = true
    if (!transaction.docChanged) return
    const from = transaction.mapping.mapResult(selection.from)
    const to = transaction.mapping.mapResult(selection.to)
    cancelled = cancelled || from.deleted || to.deleted
    bookmark = bookmark.map(transaction.mapping)
    selection = bookmark.resolve(transaction.doc)
  }
  editor.on("transaction", handleTransaction)
  const unsubscribe = store.subscribe(state => { if (state.readOnly || state.switching) cancelled = true })
  return {
    cancelled: () => cancelled,
    getSelection: () => bookmark.resolve(editor.state.doc),
    clear: () => {
      editor.off("transaction", handleTransaction)
      unsubscribe()
    }
  }
}
