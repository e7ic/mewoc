/**
 * 音视频插入复用图片/附件的同步任务锁；文件选择前的书签由工具栏传入，读取时不改用当前选区。
 * 每次原生读取拥有 AbortController，会话卸载即时停止读取，迟到资源由核心命令回收。
 */
import { IconCircleX, IconInfoCircle } from "@tabler/icons-react"
import { createElement, useCallback, useEffect, useRef, useState } from "react"
import { message } from "antd"
import { canInsertMedia, insertDocumentMedia } from "../tools/media-commands.js"

export function useDocumentMedia(editor, assets, store, assetTaskRef) {
  const [mediaUploading, setMediaUploading] = useState(false)
  const mountedRef = useRef(true)
  const pendingRef = useRef(null)
  const insertMedia = useCallback(async (file, kind, target) => {
    const canEdit = () => !store.getState().readOnly && !store.getState().switching
    if (!file || assetTaskRef.current || !mountedRef.current || !canEdit() || !editor?.isEditable || editor.isDestroyed || editor.view.composing) {
      target?.dispose()
      return false
    }
    const selection = target ? target.getSelection() : editor.state.selection
    if (!canInsertMedia(editor, selection, canEdit)) {
      target?.dispose()
      message.info({ content: "请将光标放在普通文字段落中插入音频或视频", icon: createElement(IconInfoCircle, { "aria-hidden": true }) })
      return false
    }
    const controller = new AbortController()
    pendingRef.current = { controller, target }
    assetTaskRef.current = true
    setMediaUploading(true)
    try {
      const inserted = await insertDocumentMedia({
        editor, assets, file, kind, target, signal: controller.signal, canEdit,
        isActive: () => mountedRef.current, subscribeSession: callback => store.subscribe(callback)
      })
      if (inserted && mountedRef.current && !editor.isDestroyed) editor.commands.focus()
      return inserted
    } catch (error) {
      if (mountedRef.current && !editor.isDestroyed && error.name !== "AbortError" && !controller.signal.aborted && canEdit()) {
        message.error({ content: error.message, icon: createElement(IconCircleX, { "aria-hidden": true }) })
      }
      return false
    } finally {
      target?.dispose()
      pendingRef.current = null
      assetTaskRef.current = false
      if (mountedRef.current) setMediaUploading(false)
    }
  }, [editor, assets, store, assetTaskRef])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingRef.current?.controller.abort()
      pendingRef.current?.target?.dispose()
    }
  }, [])

  return { insertMedia, mediaUploading }
}
