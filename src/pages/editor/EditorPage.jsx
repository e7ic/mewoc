import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, Button, Spin, message } from "antd"
import { EditorProvider, EditorWorkspace } from "./components"
import { createDocument, validateDocument } from "./tools/document-schema.js"
import { getDocuments, getDocumentAssets } from "./tools/local-repository.js"
import { createDocumentAssetUrl } from "./tools/attachment-assets.js"
import { createId } from "./tools/create-id.js"
import styles from "./sass/page.module.scss"

const ACTIVE_DOCUMENT_KEY = "mewoc.activeDocumentId"

export default function EditorPage() {
  const [record, setRecord] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const mountedRef = useRef(true)

  const getInitialDocument = useCallback(() => {
    setLoading(true)
    setError("")
    getDocuments().then(async records => {
      const activeId = getActiveDocumentId()
      const latest = records.find(item => item.id === activeId) || records[0]
      if (!latest) return { document: createDocument(true), storageVersion: 0, assets: new Map() }
      validateDocument(latest.document)
      return { ...latest, assets: await getDocumentAssets(latest.document) }
    }).then(nextRecord => {
      if (!mountedRef.current) return
      nextRecord.assets.forEach(asset => { asset.url = createDocumentAssetUrl(asset) })
      setRecord(nextRecord)
    }).catch(failure => {
      if (mountedRef.current) setError(failure.message)
    }).finally(() => {
      if (mountedRef.current) setLoading(false)
    })
  }, [])

  const handleDocumentChange = nextRecord => setRecord({ ...nextRecord, sessionId: createId() })

  useEffect(() => {
    mountedRef.current = true
    getInitialDocument()
    return () => { mountedRef.current = false }
  }, [getInitialDocument])

  useEffect(() => {
    if (!record) return
    try {
      localStorage.setItem(ACTIVE_DOCUMENT_KEY, record.document.id)
    } catch {
      message.warning("未能记录当前文档偏好，刷新后会打开最近保存的文档")
    }
  }, [record])

  return (
    <main className={styles.container}>
      {loading && <div className={styles.loading} role="status"><Spin /><span>正在打开本地文档…</span></div>}
      {!loading && error && (
        <div className={styles.error}>
          <Alert type="error" message="文档未能打开" description={error} showIcon />
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

function getActiveDocumentId() {
  try {
    return localStorage.getItem(ACTIVE_DOCUMENT_KEY)
  } catch {
    // 此处只读取可丢失的界面偏好，正文依然从 IndexedDB 读取。
    message.warning("未能读取打开偏好，将显示最近保存的文档")
    return null
  }
}
