import { useEffect, useRef, useState } from "react"
import { message } from "antd"
import { FileAddOutlined, FolderOpenOutlined, SaveOutlined } from "@ant-design/icons"
import { LocalDocumentsAction } from "./LocalDocumentsAction.jsx"
import { MarkdownImportAction } from "./MarkdownImportAction.jsx"
import { useDocumentEditor } from "./EditorProvider.jsx"
import { createDocument } from "../tools/document-schema.js"
import { readPortableFile } from "../tools/file-transfer.js"
import { getDocuments, getDocumentAssets } from "../tools/local-repository.js"
import styles from "../sass/document-bar.module.scss"

export function FileActions({ onDocumentChange }) {
  const [pending, setPending] = useState(false)
  const fileInputRef = useRef(null)
  const mountedRef = useRef(true)
  const { editor, store, saveDocument, uploading } = useDocumentEditor()

  const changeDocument = async nextRecord => {
    const readOnly = store.getState().readOnly
    setPending(true)
    store.getState().updateView({ switching: true })
    editor.setEditable(false, false)
    let changed = false
    try {
      if (!await saveDocument() || !mountedRef.current) return
      if (nextRecord.storageVersion) {
        const records = await getDocuments()
        const latest = records.find(item => item.id === nextRecord.document.id)
        if (!latest) throw new Error("所选本地文档已经不可用")
        nextRecord = { ...latest, assets: await getDocumentAssets(latest.document) }
      }
      if (!mountedRef.current) return
      nextRecord.assets.forEach(asset => { asset.url = URL.createObjectURL(asset.blob) })
      changed = true
      onDocumentChange(nextRecord)
      return true
    } catch (error) {
      if (mountedRef.current) message.error(error.message)
    } finally {
      if (mountedRef.current && !changed) {
        setPending(false)
        store.getState().updateView({ switching: false })
        editor.setEditable(!readOnly, false)
      }
    }
  }

  const handleNewDocument = () => changeDocument({ document: createDocument(), storageVersion: 0, assets: new Map() })
  const handleOpenFile = async event => {
    const file = event.target.files[0]
    event.target.value = ""
    if (!file) return
    setPending(true)
    try {
      const nextRecord = await readPortableFile(file)
      if (mountedRef.current) await changeDocument(nextRecord)
    } catch (error) {
      if (mountedRef.current) message.error(error.message)
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }

  useEffect(() => () => { mountedRef.current = false }, [])

  return (
    <nav className={styles.files} aria-label="文档操作">
      <button type="button" disabled={pending || uploading} onClick={handleNewDocument}><FileAddOutlined />新建</button>
      <button type="button" disabled={pending || uploading} onClick={() => fileInputRef.current.click()}><FolderOpenOutlined />打开</button>
      <MarkdownImportAction disabled={pending || uploading} onImport={changeDocument} />
      <button type="button" disabled={pending || uploading} onClick={saveDocument}><SaveOutlined />保存</button>
      <LocalDocumentsAction disabled={pending || uploading} onSelect={changeDocument} />
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
