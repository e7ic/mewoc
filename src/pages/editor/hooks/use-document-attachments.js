/**
 * 管理附件从本机文件到正文卡片的完整生命周期。
 * assets 保存原始 Blob 和下载 URL，assetTaskRef 与图片插入共用互斥状态，避免两个资源任务交错提交。
 * 这里的 uploading 表示本地读取过程；持久化由正文变化触发的保存流程完成。
 */
import { IconCircleX, IconInfoCircle } from "@tabler/icons-react"
import { createElement, useCallback, useEffect, useRef, useState } from "react"
import { message } from "antd"
import { readAttachmentFile, createDocumentAssetUrl } from "../tools/attachment-assets.js"
import { canInsertAttachment, insertAttachmentNode } from "../tools/attachment-commands.js"
import { checkAssetCapacity } from "../tools/document-schema.js"

/**
 * 附件读取成功后才创建卡片，原始文件字节保存在会话资源中，正文只写 assetId。
 * 插入失败或目标失效时撤回尚未被正文接纳的资源；成功后的资源保留以支持撤销。
 */
export function useDocumentAttachments(editor, assets, store, assetTaskRef) {
  // mountedRef 阻止迟到结果更新已卸载组件；cleanupRef 允许会话结束时立即移除选区订阅。
  const [attachmentUploading, setAttachmentUploading] = useState(false)
  const mountedRef = useRef(true)
  const cleanupRef = useRef(null)

  // 返回是否真正插入，调用方可据此收起入口；取消或校验失败统一返回 false。
  const insertAttachment = useCallback(async file => {
    if (assetTaskRef.current || store.getState().readOnly || store.getState().switching) return false
    if (!canInsertAttachment(editor, editor?.state.selection)) {
      message.info({ content: "请将光标放在普通文字段落中插入附件", icon: createElement(IconInfoCircle, { "aria-hidden": true }) })
      return false
    }
    // 检查通过后才占用资源任务，读取前捕获原目标，避免文件选择器改变正文焦点。
    assetTaskRef.current = true
    setAttachmentUploading(true)
    const target = trackAttachmentSelection(editor, store)
    cleanupRef.current = target.clear
    let asset = null
    let inserted = false
    try {
      // 先按文件大小预检，再在读取完成后按当前正文复检；等待期间资源引用可能发生变化。
      checkAssetCapacity(editor.getJSON(), assets, file.size)
      asset = await readAttachmentFile(file)
      if (!mountedRef.current || editor.isDestroyed || !editor.isEditable || target.cancelled()) return false
      const selection = target.getSelection()
      if (!canInsertAttachment(editor, selection)) return false
      checkAssetCapacity(editor.getJSON(), assets, asset.byteLength)
      // 正文只接收资源 ID；卡片视图和下载按钮从会话表解析其 URL。
      asset.url = createDocumentAssetUrl(asset)
      assets.set(asset.id, asset)
      // 插入会替换原选区，先结束监听，避免把自己的事务当成目标被删除。
      target.clear()
      inserted = insertAttachmentNode(editor, selection, asset.id)
      if (!inserted) throw new Error("附件未能插入，请重新选择插入位置")
      editor.commands.focus()
      return true
    } catch (error) {
      if (mountedRef.current && !target.cancelled()) message.error({ content: error.message, icon: createElement(IconCircleX, { "aria-hidden": true }) })
      return false
    } finally {
      // 无论成功、取消或异常都释放任务锁；只有未接纳的资源可以立即回收，成功资源需支持撤销。
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

  // 卸载不取消底层读取，但先撤销监听与提交资格，使后续结果走 finally 的资源清理。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cleanupRef.current?.()
    }
  }, [])

  return { insertAttachment, attachmentUploading }
}

// 取消是不可逆的：读取期间进入过只读/切换态，即使随后恢复编辑也不再提交这次附件。
// 这里只阻止迟到结果写入，不会取消底层文件读取；clear 负责解绑两种订阅。
function trackAttachmentSelection(editor, store) {
  let selection = editor.state.selection
  let bookmark = selection.getBookmark()
  let cancelled = false
  // 同时映射起止点与书签：任何端点被删除都使本次目标失效，不能插到相邻的新段落。
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
