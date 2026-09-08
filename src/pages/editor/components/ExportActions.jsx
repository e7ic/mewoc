import { useEffect, useRef, useState } from "react"
import { Button, Dropdown, message } from "antd"
import { DownloadOutlined, DownOutlined, PrinterOutlined } from "@ant-design/icons"
import { useDocumentEditor } from "./EditorProvider.jsx"
import { MarkdownExportDialog } from "./MarkdownExportDialog.jsx"
import { createDocumentMarkdown } from "../tools/markdown-file.js"
import { createDocumentHtml, createPortableFile, downloadDocument } from "../tools/file-transfer.js"
import { printDocument } from "../tools/print-document.js"
import styles from "../sass/document-bar.module.scss"

const EXPORT_ITEMS = [
  { key: "json", label: "Mewoc 文件（含图片与附件）" },
  { key: "html", label: "HTML 网页" },
  { key: "markdown", label: "Markdown 文档" },
  { key: "text", label: "纯文本" }
]

export function ExportActions() {
  const [pending, setPending] = useState(false)
  const [markdown, setMarkdown] = useState(null)
  const mountedRef = useRef(true)
  const printCleanupRef = useRef(null)
  const printAbortRef = useRef(null)
  const { editor, assets, getSnapshot, uploading } = useDocumentEditor()

  // 直接捕获当前内容，允许本地保存失败时仍尝试导出备份；异步转换完成后再检查会话存活。
  const handleExport = async ({ key }) => {
    if (pending) return
    setPending(true)
    try {
      const snapshot = getSnapshot()
      if (key === "json") {
        const source = await createPortableFile(snapshot, assets)
        if (mountedRef.current) downloadDocument(new Blob([JSON.stringify(source)], { type: "application/json" }), snapshot.title, "mewoc.json")
      }
      if (key === "text") downloadDocument(new Blob([editor.getText()], { type: "text/plain;charset=utf-8" }), snapshot.title, "txt")
      if (key === "markdown") {
        const result = await createDocumentMarkdown(snapshot)
        if (mountedRef.current) setMarkdown(result)
      }
      if (key === "html" || key === "print") {
        const html = await createDocumentHtml(snapshot, assets)
        if (!mountedRef.current) return
        if (key === "html") downloadDocument(new Blob([html], { type: "text/html;charset=utf-8" }), snapshot.title, "html")
        if (key === "print") {
          const tables = [...editor.view.dom.querySelectorAll("table")]
          if (tables.some(table => table.offsetWidth > editor.view.dom.clientWidth + 1)) {
            message.warning("表格超过纸张正文宽度，请缩小列宽或切换横版后打印")
            return
          }
          // 新打印替换旧任务；卸载时也同时中止加载和释放已创建的打印 iframe。
          printCleanupRef.current?.()
          printAbortRef.current?.abort()
          const controller = new AbortController()
          printAbortRef.current = controller
          printCleanupRef.current = await printDocument(html, controller.signal)
        }
      }
    } catch (error) {
      if (mountedRef.current && error.name !== "AbortError") message.error(error.message)
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }

  useEffect(() => () => {
    mountedRef.current = false
    printAbortRef.current?.abort()
    printCleanupRef.current?.()
  }, [])

  return (
    <>
      <Button
        className={styles.print}
        icon={<PrinterOutlined />}
        disabled={pending || uploading}
        onClick={() => handleExport({ key: "print" })}
      >打印</Button>
      <Dropdown
        menu={{ items: EXPORT_ITEMS, onClick: handleExport }}
        disabled={pending || uploading}
      >
        <Button
          type="primary"
          loading={pending}
          icon={<DownloadOutlined />}
        >导出文档 <DownOutlined /></Button>
      </Dropdown>
      <MarkdownExportDialog result={markdown} onCancel={() => setMarkdown(null)} />
    </>
  )
}
