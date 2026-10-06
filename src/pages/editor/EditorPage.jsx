/**
 * 编辑页面的加载边界：从本浏览器仓库恢复文档和资源，再建立独立编辑会话。
 * 加载、失败重试、当前文档偏好由页面负责；正文编辑和保存生命周期交给 Provider。
 */
import { IconAlertTriangle, IconCircleX } from "@tabler/icons-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, Button, Spin, message } from "antd"
import { EditorProvider, EditorWorkspace } from "./components"
import { createDocument, validateDocument } from "./tools/document-schema.js"
import { getDocuments, getDocumentAssets } from "./tools/local-repository.js"
import { createDocumentAssetUrl } from "./tools/attachment-assets.js"
import { createId } from "./tools/create-id.js"
import styles from "./sass/page.module.scss"

const ACTIVE_DOCUMENT_KEY = "mewoc.activeDocumentId"

// 页面负责加载/切换文档记录，实际编辑与资源清理由下层 Provider 按会话承担。
export default function EditorPage() {
  // record 只在读取成功或文档切换时更换；loading/error 控制编辑器挂载前的界面。
  // mountedRef 让异步仓库读取在页面离开后停止回写，也避免为失去所有者的资源创建 URL。
  const [record, setRecord] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const mountedRef = useRef(true)

  // 初始化与“重新读取”使用相同流程，先清除上一次错误；没有记录时提供初始文档。
  // 正文结构先校验，资源 Blob 随后加载，任一步失败都保留明确的重试入口。
  const getInitialDocument = useCallback(() => {
    setLoading(true)
    setError("")
    getDocuments().then(async records => {
      const activeId = getActiveDocumentId()
      // 优先恢复上次打开的文档；偏好丢失时采用按更新时间排序后的第一条记录。
      const latest = records.find(item => item.id === activeId) || records[0]
      if (!latest) return { document: createDocument(true), storageVersion: 0, assets: new Map() }
      validateDocument(latest.document)
      return { ...latest, assets: await getDocumentAssets(latest.document) }
    }).then(nextRecord => {
      if (!mountedRef.current) return
      // 先确认页面仍在，再创建需要显式回收的 URL，避免迟到加载产生无人持有的资源。
      nextRecord.assets.forEach(asset => { asset.url = createDocumentAssetUrl(asset) })
      setRecord(nextRecord)
    }).catch(failure => {
      if (mountedRef.current) setError(failure.message)
    }).finally(() => {
      if (mountedRef.current) setLoading(false)
    })
  }, [])

  // 即使重开相同文档也分配新 key，确保旧选区、撤销栈和保存队列不会沿用。
  const handleDocumentChange = nextRecord => setRecord({ ...nextRecord, sessionId: createId() })

  // 页面挂载时启动一次读取；清理只标记失效，底层读取即使完成也不会更新已卸载页面。
  useEffect(() => {
    mountedRef.current = true
    getInitialDocument()
    return () => { mountedRef.current = false }
  }, [getInitialDocument])

  // 当前文档 ID 是可丢失的界面偏好，记录它用于刷新恢复，不替代正文的 IndexedDB 保存。
  useEffect(() => {
    if (!record) return
    try {
      localStorage.setItem(ACTIVE_DOCUMENT_KEY, record.document.id)
    } catch {
      message.warning({ content: "未能记录当前文档偏好，刷新后会打开最近保存的文档", icon: <IconAlertTriangle aria-hidden="true" /> })
    }
  }, [record])

  // 将加载、失败、成功三种状态分开呈现；只有完整记录可用时才创建编辑器和资源所有者。
  return (
    <main className={styles.container}>
      {loading && <div className={styles.loading} role="status"><Spin /><span>正在打开本地文档…</span></div>}
      {!loading && error && (
        <div className={styles.error}>
          <Alert type="error" icon={<IconCircleX aria-hidden="true" />} message="文档未能打开" description={error} showIcon />
          <Button onClick={getInitialDocument}>重新读取</Button>
        </div>
      )}
      {!loading && !error && record && (
        <EditorProvider key={record.sessionId || record.document.id} record={record}>
          <EditorWorkspace onDocumentChange={handleDocumentChange} />
        </EditorProvider>
      )}
    </main>
  )
}

// 偏好读取失败时返回空 ID，让调用方自然回退到最近文档，正文读取流程仍可继续。
function getActiveDocumentId() {
  try {
    return localStorage.getItem(ACTIVE_DOCUMENT_KEY)
  } catch {
    // 此处只读取可丢失的界面偏好，正文依然从 IndexedDB 读取。
    message.warning({ content: "未能读取打开偏好，将显示最近保存的文档", icon: <IconAlertTriangle aria-hidden="true" /> })
    return null
  }
}
