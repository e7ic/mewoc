/**
 * 将 React 编辑会话连接到独立的保存调度器和 IndexedDB 仓库。
 * revision 表示当前编辑次数，storageVersion 表示已提交记录的版本，两者用途不同。
 */
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

  // 每次请求即时读取正文与元信息，构造可保存、可导出的完整快照；不复用过期缓存。
  const getSnapshot = useCallback(() => {
    const state = store.getState()
    const content = editor.getJSON()
    // 快照只携带被正文引用的资源元数据，Blob 和会话 URL 不能进入文档 JSON。
    const references = getReferencedAssetIds(content).map(id => {
      const asset = assets.get(id)
      if (!asset) throw new Error("资源尚未就绪，请稍后保存")
      return { id, ...(asset.kind && { kind: asset.kind }), fileName: asset.fileName, mimeType: asset.mimeType, byteLength: asset.byteLength }
    })
    // 纸张配置复制后进入快照，避免后续界面编辑改变已交给异步写入的对象。
    return validateDocument({
      ...record.document,
      title: state.title,
      page: structuredClone(state.page),
      content,
      assets: references,
      updatedAt: new Date().toISOString()
    })
  }, [editor, record, assets, store])

  // 手动保存排空所有待写 revision；调度器尚未创建时返回失败，让切换流程保持当前文档。
  const saveDocument = useCallback(() => coordinatorRef.current?.flush() ?? Promise.resolve(false), [])
  // 仓库操作需使用已提交版本进行乐观锁比较；初次挂载则沿用加载记录的基础版本。
  const getStorageVersion = useCallback(() => coordinatorRef.current?.getVersion() ?? record.storageVersion ?? 0, [record.storageVersion])

  // 每个 editor/record 生命周期只持有一条保存队列，订阅 store 即可同时覆盖正文和元信息修改。
  useEffect(() => {
    if (!editor) return
    const coordinator = createSaveCoordinator({
      getSnapshot,
      getRevision: () => store.getState().revision,
      write: (snapshot, version) => saveLocalDocument(snapshot, assets, version),
      onStatus: state => store.getState().updateSave(state),
      baseVersion: record.storageVersion ?? 0,
      initialRevision: 0
    })
    coordinatorRef.current = coordinator
    // 保存状态回写也会触发订阅，只对编辑序号变化调度，避免保存触发下一次保存。
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.revision !== previous.revision) coordinator.schedule()
    })
    // 挂载前已产生的修改也需要保存，不能只等待之后发生的订阅回调。
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
      // 先停止新任务，再销毁调度器；已经进入仓库的写入由调度器阻止回写旧会话状态。
      unsubscribe()
      coordinator.dispose()
      coordinatorRef.current = null
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [editor, getSnapshot, assets, record, store])

  return { getSnapshot, saveDocument, getStorageVersion }
}
