/**
 * 文件与本地库操作的协调层：在离开当前正文前完成保存，并在互斥锁内执行读写和会话切换。
 * 图片/附件临时 URL 只在确认提交新记录时创建，失败立即回收；旧编辑器由父级 key 切换卸载。
 */
import { useEffect, useRef, useState } from "react"
import { message } from "antd"
import { IconCircleX, IconDeviceFloppy, IconFilePlus, IconFolderOpen } from "@tabler/icons-react"
import { LocalDocumentsAction } from "./LocalDocumentsAction.jsx"
import { DocxImportAction } from "./DocxImportAction.jsx"
import { MarkdownImportAction } from "./MarkdownImportAction.jsx"
import { DocumentTemplatesAction } from "./DocumentTemplatesAction.jsx"
import { useDocumentEditor } from "./EditorProvider.jsx"
import { createDocument } from "../tools/document-schema.js"
import { readPortableFile } from "../tools/file-transfer.js"
import { getLocalDocument, getDocumentAssets, renameLocalDocument, duplicateLocalDocument, trashLocalDocument, restoreLocalDocument } from "../tools/local-repository.js"
import { createDocumentAssetUrl } from "../tools/attachment-assets.js"
import { createDocumentVersion, restoreDocumentVersion, duplicateDocumentVersion } from "../tools/document-history-repository.js"
import { createDocumentTemplate, instantiateDocumentTemplate } from "../tools/document-template-repository.js"
import styles from "../sass/document-bar.module.scss"

export function FileActions({ onDocumentChange }) {
  // pending 控制 UI 禁用，operationRef 在 React 渲染前立即拦截重复动作；mountedRef 排除离开会话后的回写。
  const [pending, setPending] = useState(false)
  const fileInputRef = useRef(null)
  const mountedRef = useRef(true)
  const operationRef = useRef(false)
  const { editor, store, documentId, getStorageVersion, saveDocument, uploading } = useDocumentEditor()

  // 文件读取、切换和文档库写入共享互斥锁，避免快速双击在 React 回显禁用前重复提交。
  const runLocked = async action => {
    if (operationRef.current || uploading) return false
    operationRef.current = true
    const readOnly = store.getState().readOnly
    setPending(true)
    store.getState().updateView({ switching: true })
    editor.setEditable(false, false)
    let changed = false
    try {
      // commit 是唯一会话切换入口：先确认所有者仍在，再分配 URL 并通知页面；中途失败回收已分配资源。
      return await action(nextRecord => {
        if (!mountedRef.current) return false
        const urls = []
        try {
          nextRecord.assets.forEach(asset => {
            asset.url = createDocumentAssetUrl(asset)
            urls.push(asset.url)
          })
          onDocumentChange(nextRecord)
          changed = true
          return true
        } catch (failure) {
          urls.forEach(url => URL.revokeObjectURL(url))
          throw failure
        }
      })
    // 操作结束释放同步锁；仅未切走且仍挂载时恢复原只读状态，不能把新会话或已销毁编辑器解锁。
    } finally {
      operationRef.current = false
      if (mountedRef.current && !changed) {
        setPending(false)
        store.getState().updateView({ switching: false })
        editor.setEditable(!readOnly, false)
      }
    }
  }

  // 打开文档/模板库前先显式保存当前输入，错误向弹窗传播，让列表中的当前文档版本可靠。
  const prepareLibrary = () => runLocked(async () => {
    if (!await saveDocument()) throw new Error(store.getState().saveError || "当前文档未能保存，请处理保存错误后重试")
    return mountedRef.current
  })

  // 保存成功且会话仍存在后才提交新记录；已持久化目标还要重新查询，避免打开列表快照中的旧版本。
  const openRecord = async (nextRecord, commit) => {
    if (!await saveDocument() || !mountedRef.current) return false
    // 列表只是弹窗打开时的快照，切换前重新读取活跃记录，回收记录不能重新打开。
    if (nextRecord.id || nextRecord.storageVersion) {
      const latest = await getLocalDocument(nextRecord.document.id)
      if (!latest) throw new Error("所选本地文档已经不可用，请刷新文档库")
      nextRecord = { ...latest, assets: await getDocumentAssets(latest.document) }
    }
    return commit(nextRecord)
  }

  // 新建、文件导入与库打开复用统一切换契约；失败显示消息并返回 false，让调用方保留预览或草稿。
  const changeDocument = async nextRecord => {
    try { return await runLocked(commit => openRecord(nextRecord, commit)) }
    catch (error) {
      if (mountedRef.current) message.error({ content: error.message, icon: <IconCircleX aria-hidden="true" /> })
      return false
    }
  }

  // 库操作携带目标存储版本做并发校验；当前文档先 flush 并核对最新版本，其他记录直接走仓库事务。
  const manageDocument = (action, target, title) => runLocked(async commit => {
    const current = target.id === documentId
    // 恢复不依赖活跃版本；当前文档若在另一窗口被回收且仍有未保存编辑，保留正文供导出。
    if (action === "restore") {
      const state = store.getState()
      if (current && state.revision !== state.savedRevision) throw new Error("当前文档还有未保存内容，请先导出副本再恢复回收站版本")
      const restoredAssets = current ? await getDocumentAssets(target.document) : null
      const restored = await restoreLocalDocument(target.id, target.storageVersion)
      return current ? commit({ ...restored, assets: restoredAssets }) : true
    }
    let version = target.storageVersion ?? 0
    if (current) {
      if (!await saveDocument()) throw new Error(store.getState().saveError || "当前文档未能保存，请处理保存错误后重试")
      version = getStorageVersion()
      const latest = await getLocalDocument(target.id)
      if (!latest || (latest.storageVersion ?? 0) !== version) throw new Error("当前文档已在另一标签页变更，请先导出副本，再刷新读取最新版本")
    }
    if (!mountedRef.current) return false
    // 重命名当前文档走同一保存队列以保留选区/撤销；副本和回收在仓库执行，不把旧正文重写为新 ID。
    if (action === "rename") {
      const value = typeof title === "string" ? title.trim() : ""
      if (!value || value.length > 100) throw new Error("文档标题应为 1–100 个字符")
      if (current) {
        // 当前标题走保存队列，维持存储版本同步，同时保留正文选区和撤销历史。
        store.getState().updateTitle(value)
        if (!await saveDocument()) throw new Error(store.getState().saveError || "重命名未能保存，请重试")
      } else await renameLocalDocument(target.id, value, version)
    } else if (action === "duplicate") await duplicateLocalDocument(target.id, version)
    else if (action === "trash") {
      await trashLocalDocument(target.id, version)
      // 已回收的旧会话不能再 flush；直接新建会话，旧保存队列随卸载销毁。
      if (current) return commit({ document: createDocument(), storageVersion: 0, assets: new Map() })
    } else throw new Error("未知文档库操作")
    return true
  })

  // 仅打开当前文档历史时需要保存正文，浏览其他记录的历史不会额外刷新当前内容。
  const prepareHistory = target => runLocked(async () => {
    if (target.id === documentId && !await saveDocument()) {
      throw new Error(store.getState().saveError || "当前文档未能保存，请处理保存错误后重试")
    }
    return mountedRef.current
  })

  // 历史正文读取保持只读；检查点、恢复与另存通过共用锁执行，打开前保存由 prepareHistory 负责。
  const manageHistory = (action, target, versionId, label) => runLocked(async commit => {
    const current = target.id === documentId
    let version = target.storageVersion ?? 0
    if (current) {
      // 恢复前把尚未落盘的输入提交，仓库才能在同一恢复事务中保留完整的当前版本。
      if (!await saveDocument()) throw new Error(store.getState().saveError || "当前文档未能保存，请处理保存错误后重试")
      version = getStorageVersion()
      const latest = await getLocalDocument(target.id)
      if (!latest || (latest.storageVersion ?? 0) !== version) {
        throw new Error("当前文档已在另一标签页变更，请先导出副本，再刷新读取最新版本")
      }
    }
    if (!mountedRef.current) return false
    if (action === "checkpoint") await createDocumentVersion(target.id, version, label)
    else if (action === "duplicateVersion") await duplicateDocumentVersion(target.id, versionId, version)
    else if (action === "restoreVersion") {
      const restored = await restoreDocumentVersion(target.id, versionId, version)
      // 新存储版本及资源由恢复事务一并返回，直接重建会话，不再 flush 已替换的旧正文。
      if (current) return commit(restored)
    } else throw new Error("未知历史版本操作")
    return true
  })

  // 模板快照必须来自完成保存的版本，仓库再核对源版本，防止另一标签页更新后保存旧内容。
  const saveAsTemplate = name => runLocked(async () => {
    if (!await saveDocument()) throw new Error(store.getState().saveError || "当前文档未能保存，请处理保存错误后重试")
    if (!mountedRef.current) return false
    return createDocumentTemplate(documentId, getStorageVersion(), name)
  })

  const createFromTemplate = target => runLocked(async commit => {
    if (!await saveDocument()) throw new Error(store.getState().saveError || "当前文档未能保存，请处理保存错误后重试")
    if (!mountedRef.current) return false
    const record = await instantiateDocumentTemplate(target.id, target.storageVersion)
    // 新文档与资源已原子落盘，直接切换会话；不通过 openRecord 再次保存旧编辑器。
    return commit(record)
  })

  // 新建空白仍通过保存后切换流程；新记录没有持久化版本和资源，交给新会话首次保存。
  const handleNewDocument = () => changeDocument({ document: createDocument(), storageVersion: 0, assets: new Map() })
  // 读取 Mewoc 便携文件在互斥锁内执行，格式/资源校验失败停留原会话，成功再应用保存后切换。
  const handleOpenFile = async event => {
    const file = event.target.files[0]
    // 清空文件控件值，保证再次选择同一个文件也会触发 change。
    event.target.value = ""
    if (!file) return
    try {
      await runLocked(async commit => {
        const nextRecord = await readPortableFile(file)
        return mountedRef.current ? openRecord(nextRecord, commit) : false
      })
    } catch (error) {
      if (mountedRef.current) message.error({ content: error.message, icon: <IconCircleX aria-hidden="true" /> })
    }
  }

  // 卸载标记会话结束，所有待完成库操作和文件读取在 commit 前据此拒绝更新旧 UI。
  useEffect(() => () => { mountedRef.current = false }, [])

  // 文件、导入、模板、文档库与历史入口共享 busy/uploading 限制；隐藏文件框只负责原生选择。
  return (
    <nav className={styles.files} aria-label="文档操作">
      <button type="button" disabled={pending || uploading} onClick={handleNewDocument}><IconFilePlus aria-hidden="true" />新建</button>
      <DocumentTemplatesAction disabled={pending || uploading} onPrepare={prepareLibrary}
        onSave={saveAsTemplate} onCreate={createFromTemplate} />
      <button type="button" disabled={pending || uploading} onClick={() => fileInputRef.current.click()}><IconFolderOpen aria-hidden="true" />打开</button>
      <MarkdownImportAction disabled={pending || uploading} onImport={changeDocument} />
      <DocxImportAction disabled={pending || uploading} onImport={changeDocument} />
      <button type="button" disabled={pending || uploading} onClick={saveDocument}><IconDeviceFloppy aria-hidden="true" />保存</button>
      <LocalDocumentsAction disabled={pending || uploading} currentDocumentId={documentId}
        onPrepare={prepareLibrary} onManage={manageDocument} onSelect={changeDocument}
        onPrepareHistory={prepareHistory} onManageHistory={manageHistory} />
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.mewoc.json"
        aria-label="打开 Mewoc 文件"
        hidden
        onChange={handleOpenFile}
      />
    </nav>
  )
}
