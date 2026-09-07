import { useCallback, useEffect, useRef, useState } from "react"
import { message } from "antd"
import { TextSelection } from "@tiptap/pm/state"
import { readImageFile } from "../tools/image-assets.js"
import { getReferencedAssetIds } from "../tools/document-schema.js"
import { MAX_ASSET_BYTES } from "../constants/editor-constants.js"

export function useDocumentImages(editor, assets, store) {
  const [uploading, setUploading] = useState(false)
  const mountedRef = useRef(true)
  const pendingRef = useRef(false)

  const insertImages = useCallback(async (files, position) => {
    if (!editor?.isEditable || pendingRef.current) return
    const ids = getReferencedAssetIds(editor.getJSON())
    const currentBytes = ids.map(id => assets.get(id).byteLength).reduce((sum, size) => sum + size, 0)
    const incomingBytes = files.reduce((sum, file) => sum + file.size, 0)
    if (currentBytes + incomingBytes > MAX_ASSET_BYTES) {
      message.error("当前文档图片总量不能超过 20 MiB")
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
    pendingRef.current = true
    setUploading(true)
    try {
      for (const file of files) {
        const asset = await readImageFile(file)
        if (!mountedRef.current || editor.isDestroyed || !editor.isEditable || deleted || store.getState().readOnly) {
          URL.revokeObjectURL(asset.url)
          return
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
      pendingRef.current = false
      if (mountedRef.current) setUploading(false)
    }
  }, [editor, assets, store])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  return { insertImages, uploading }
}
