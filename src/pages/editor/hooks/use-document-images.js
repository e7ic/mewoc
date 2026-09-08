import { useCallback, useEffect, useRef, useState } from "react"
import { message } from "antd"
import { TextSelection } from "@tiptap/pm/state"
import { readImageFile } from "../tools/image-assets.js"
import { checkAssetCapacity } from "../tools/document-schema.js"

/**
 * 顺序解码并插入一批本地图片；批次中途失败时，已经插入的图片保留。
 * 文件读取期间正文仍可能变化，使用 bookmark 跟踪原插入位置，目标被删除则停止。
 * 成功资源交由会话回收，异步完成后发现会话失效的资源立即释放 URL。
 */
export function useDocumentImages(editor, assets, store, assetTaskRef) {
  const [uploading, setUploading] = useState(false)
  const mountedRef = useRef(true)

  const insertImages = useCallback(async (files, position) => {
    if (!editor?.isEditable || assetTaskRef.current || store.getState().readOnly || store.getState().switching) return
    const incomingBytes = files.reduce((sum, file) => sum + file.size, 0)
    try {
      checkAssetCapacity(editor.getJSON(), assets, incomingBytes)
    } catch (error) {
      message.error(error.message)
      return
    }
    const selection = position === undefined ? editor.state.selection : TextSelection.create(editor.state.doc, position)
    let bookmark = selection.getBookmark()
    let deleted = false
    let inserting = false
    const handleTransaction = ({ transaction }) => {
      if (transaction.docChanged && !inserting) {
        deleted = deleted || transaction.mapping.mapResult(bookmark.anchor ?? selection.from).deleted
        bookmark = bookmark.map(transaction.mapping)
      }
    }
    editor.on("transaction", handleTransaction)
    assetTaskRef.current = true
    setUploading(true)
    try {
      for (const file of files) {
        const asset = await readImageFile(file)
        if (!mountedRef.current || editor.isDestroyed || !editor.isEditable || deleted || store.getState().readOnly || store.getState().switching) {
          URL.revokeObjectURL(asset.url)
          return
        }
        try {
          // 读取期间正文引用可能变化，插入前按最新正文再次核对容量。
          checkAssetCapacity(editor.getJSON(), assets, asset.byteLength)
        } catch (error) {
          URL.revokeObjectURL(asset.url)
          throw error
        }
        assets.set(asset.id, asset)
        const target = bookmark.resolve(editor.state.doc)
        // 自己插入图片也会替换原选区，不能将其当作用户删除而中止后续文件。
        inserting = true
        try {
          editor.chain().focus().setTextSelection(target.from).insertContent({
            type: "image",
            attrs: { assetId: asset.id, width: asset.width, height: asset.height, alt: file.name, title: "" }
          }).run()
        } finally {
          inserting = false
        }
        bookmark = editor.state.selection.getBookmark()
      }
    } catch (error) {
      if (mountedRef.current) message.error(error.message)
    } finally {
      editor.off("transaction", handleTransaction)
      assetTaskRef.current = false
      if (mountedRef.current) setUploading(false)
    }
  }, [editor, assets, store, assetTaskRef])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  return { insertImages, uploading }
}
