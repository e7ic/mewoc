/**
 * 将图片选择、剪贴板和拖入入口统一为同一批次处理流程。
 * 会话资源保存图片字节与显示地址，正文节点仅保存引用及尺寸；图片和附件共享任务锁。
 */
import { IconCircleX } from "@tabler/icons-react"
import { createElement, useCallback, useEffect, useRef, useState } from "react"
import { message } from "antd"
import { TextSelection } from "@tiptap/pm/state"
import { readImageFile } from "../tools/image-assets.js"
import { checkAssetCapacity } from "../tools/document-schema.js"
import { replaceDocumentImage } from "../tools/image-replacement.js"

/**
 * 顺序解码并插入一批本地图片；批次中途失败时，已经插入的图片保留。
 * 文件读取期间正文仍可能变化，使用 bookmark 跟踪原插入位置，目标被删除则停止。
 * 成功资源交由会话回收，异步完成后发现会话失效的资源立即释放 URL。
 */
export function useDocumentImages(editor, assets, store, assetTaskRef) {
  // uploading 驱动界面忙碌状态，mountedRef 则决定异步读取结束后是否还能更新该会话。
  const [uploading, setUploading] = useState(false)
  const mountedRef = useRef(true)

  // position 由拖入坐标提供；省略时使用当前选区，随后通过书签跟踪插入位置。
  const insertImages = useCallback(async (files, position) => {
    if (!editor?.isEditable || assetTaskRef.current || store.getState().readOnly || store.getState().switching) return
    // 先检查整批容量，避免明显超限的批次在读取多个文件后才失败。
    const incomingBytes = files.reduce((sum, file) => sum + file.size, 0)
    try {
      checkAssetCapacity(editor.getJSON(), assets, incomingBytes)
    } catch (error) {
      message.error({ content: error.message, icon: createElement(IconCircleX, { "aria-hidden": true }) })
      return
    }
    const selection = position === undefined ? editor.state.selection : TextSelection.create(editor.state.doc, position)
    let bookmark = selection.getBookmark()
    let deleted = false
    let inserting = false
    // 用户编辑导致目标删除时整批停止；inserting 排除本批次自己的插入事务。
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
      // 顺序等待既控制解码开销，也保证多张图片保持文件列表中的顺序。
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
        // 先登记资源再提交节点，NodeView 创建时即可解析图片；后续文件接在最新选区之后。
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
      if (mountedRef.current) message.error({ content: error.message, icon: createElement(IconCircleX, { "aria-hidden": true }) })
    } finally {
      // 监听仅在批次期间存在；失败也必须释放锁，使后续图片或附件仍能插入。
      editor.off("transaction", handleTransaction)
      assetTaskRef.current = false
      if (mountedRef.current) setUploading(false)
    }
  }, [editor, assets, store, assetTaskRef])

  // 替换与插入/附件共享同步锁。文件选择时已经捕获目标，等待读取时不会重新使用当前选区。
  const replaceImage = useCallback(async (file, target) => {
    const canEdit = () => {
      const state = store.getState()
      return !state.readOnly && !state.switching
    }
    if (!editor?.isEditable || editor.isDestroyed || editor.view.composing || assetTaskRef.current || !canEdit()) {
      target?.dispose()
      return false
    }
    assetTaskRef.current = true
    setUploading(true)
    try {
      const replaced = await replaceDocumentImage({
        editor, assets, target, file, canEdit,
        isActive: () => mountedRef.current,
        subscribeSession: callback => store.subscribe(callback)
      })
      if (!replaced && mountedRef.current && !editor.isDestroyed) {
        message.error({ content: "原图片已被删除或替换，或当前不可编辑；请重新选择图片", icon: createElement(IconCircleX, { "aria-hidden": true }) })
      }
      if (replaced) editor.commands.focus()
      return replaced
    } catch (error) {
      if (mountedRef.current && !editor.isDestroyed) message.error({ content: error.message, icon: createElement(IconCircleX, { "aria-hidden": true }) })
      return false
    } finally {
      target?.dispose()
      assetTaskRef.current = false
      if (mountedRef.current) setUploading(false)
    }
  }, [editor, assets, store, assetTaskRef])

  // 会话销毁后，正在解码的文件只能释放资源，不能把结果写进旧编辑器。
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  return { insertImages, replaceImage, uploading }
}
