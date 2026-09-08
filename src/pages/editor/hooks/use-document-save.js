import { useCallback, useEffect, useRef } from "react"
import { createSaveCoordinator } from "../tools/save-coordinator.js"
import { getReferencedAssetIds, validateDocument } from "../tools/document-schema.js"
import { saveLocalDocument } from "../tools/local-repository.js"

/**
 * 连接正文、元信息与保存队列。正文始终从 editor 读取，store 只提供标题、纸张和 revision。
 * 同一 getSnapshot 同时供保存与导出使用，导出不需要依赖上一次本地保存成功。
 */
export function useDocumentSave(editor, record, assets, store) {
  const coordinatorRef = useRef(null)

  const getSnapshot = useCallback(() => {
    const state = store.getState()
    const content = editor.getJSON()
    // 快照只携带被正文引用的资源元数据，Blob 和会话 URL 不能进入文档 JSON。
    const references = getReferencedAssetIds(content).map(id => {
      const asset = assets.get(id)
      if (!asset) throw new Error("资源尚未就绪，请稍后保存")
      return { id, ...(asset.kind && { kind: asset.kind }), fileName: asset.fileName, mimeType: asset.mimeType, byteLength: asset.byteLength }
    })
    return validateDocument({
      ...record.document,
      title: state.title,
      page: structuredClone(state.page),
      content,
      assets: references,
      updatedAt: new Date().toISOString()
    })
  }, [editor, record, assets, store])

  const saveDocument = useCallback(() => coordinatorRef.current?.flush() ?? Promise.resolve(false), [])

  useEffect(() => {
    if (!editor) return
    const coordinator = createSaveCoordinator({
      getSnapshot,
      getRevision: () => store.getState().revision,
      write: (snapshot, version) => saveLocalDocument(snapshot, assets, version),
      onStatus: state => store.getState().updateSave(state),
      baseVersion: record.storageVersion,
      initialRevision: 0
    })
    coordinatorRef.current = coordinator
    // 保存状态回写也会触发订阅，只对编辑序号变化调度，避免保存触发下一次保存。
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.revision !== previous.revision) coordinator.schedule()
    })
    if (store.getState().revision) coordinator.schedule()
    // 关闭前仅提示存在未保存内容；浏览器退出时无法保证异步 IndexedDB 写入完成。
    const handleBeforeUnload = event => {
      const state = store.getState()
      if (state.revision === state.savedRevision) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      unsubscribe()
      coordinator.dispose()
      coordinatorRef.current = null
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [editor, getSnapshot, assets, record, store])

  return { getSnapshot, saveDocument }
}
