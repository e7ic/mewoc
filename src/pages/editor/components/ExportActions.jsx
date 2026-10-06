/**
 * 从点击时正文快照生成完整备份、文本、Markdown、Word、HTML 或打印/PDF。
 * 导出独立于本地保存成功与否，能作为保存失败时的备份出口；转换和打印资源由本组件持有并清理。
 */
import { useEffect, useRef, useState } from "react"
import { Button, Dropdown, message } from "antd"
import { IconAlertTriangle, IconChevronDown, IconCircleX, IconCode, IconDownload, IconFileCode, IconFileText, IconFileTypeDocx, IconLoader2, IconMarkdown, IconPrinter } from "@tabler/icons-react"
import { useDocumentEditor } from "./EditorProvider.jsx"
import { MarkdownExportDialog } from "./MarkdownExportDialog.jsx"
import { DocxExportDialog } from "./DocxExportDialog.jsx"
import { createDocumentMarkdown } from "../tools/markdown-file.js"
import { createDocumentDocx } from "../tools/docx-file.js"
import { createDocumentHtml, createPortableFile, downloadDocument } from "../tools/file-transfer.js"
import { printDocument } from "../tools/print-document.js"
import { createDocumentText, getDocumentTextWarnings } from "../tools/document-text.js"
import styles from "../sass/document-bar.module.scss"
import toolbarStyles from "../sass/toolbar.module.scss"

// 菜单与功能区使用同一导出 key，外观不同但共享快照生成和错误处理路径。
const EXPORT_ITEMS = [
  { key: "json", label: "Mewoc 文件（含图片、附件与批注）" },
  { key: "docx", label: "Word 文档（.docx）" },
  { key: "html", label: "HTML 网页" },
  { key: "markdown", label: "Markdown 文档" },
  { key: "text", label: "纯文本" }
]

const RIBBON_EXPORTS = [
  { key: "json", label: "Mewoc 文档（.json）", icon: IconFileCode },
  { key: "docx", label: "Word 文档（.docx）", icon: IconFileTypeDocx },
  { key: "html", label: "HTML 文档（.html）", icon: IconCode },
  { key: "markdown", label: "Markdown（.md）", icon: IconMarkdown },
  { key: "text", label: "纯文本（.txt）", icon: IconFileText },
  { key: "print", label: "打印 / PDF", icon: IconPrinter }
]

export function ExportActions({ variant = "menu" }) {
  // pending 控制进度，pendingRef 同步互斥防双击；markdown/docx 持有已生成结果供确认下载。
  const [pending, setPending] = useState(false)
  const [markdown, setMarkdown] = useState(null)
  const [docx, setDocx] = useState(null)
  // 生命周期 ref 阻止迟到转换更新旧会话；AbortController 管转换/打印加载，cleanup 管已创建 iframe。
  const mountedRef = useRef(true)
  const exportAbortRef = useRef(null)
  const pendingRef = useRef(false)
  const printCleanupRef = useRef(null)
  const printAbortRef = useRef(null)
  const { editor, assets, getSnapshot, uploading } = useDocumentEditor()

  // 直接捕获当前内容，允许本地保存失败时仍尝试导出备份；异步转换完成后再检查会话存活。
  const handleExport = async ({ key }) => {
    if (pendingRef.current || uploading) return
    pendingRef.current = true
    setPending(true)
    try {
      // 仅捕获一次标题、正文、页面和资源引用；后续编辑不会混入这轮异步输出，预览与下载一致。
      const snapshot = getSnapshot()
      // 便携备份包含文档资源原数据，等待编码完成后再下载；会话已离开时不继续触发下载。
      if (key === "json") {
        const source = await createPortableFile(snapshot, assets)
        if (mountedRef.current) downloadDocument(new Blob([JSON.stringify(source)], { type: "application/json" }), snapshot.title, "mewoc.json")
      }
      // 纯文本按快照资源元信息解释节点并追加批注说明，不依赖临时 URL 或当前正文选区。
      if (key === "text") {
        const text = createDocumentText(snapshot)
        downloadDocument(new Blob([text], { type: "text/plain;charset=utf-8" }), snapshot.title, "txt")
        // 纯文本没有纸面背景；说明作为界面提示，不能把水印内容追加到正文文件中。
        const warnings = getDocumentTextWarnings(snapshot)
        if (warnings.length) message.warning({ content: warnings.join(" "), icon: <IconAlertTriangle aria-hidden="true" /> })
      }
      // Markdown 结果先交确认弹窗，用户可看到转换说明；生成结果不立即触发文件下载。
      if (key === "markdown") {
        const result = await createDocumentMarkdown(snapshot)
        if (mountedRef.current) setMarkdown(result)
      }
      // Word 转换绑定可中止信号，资源图片编码等异步工作随组件卸载取消，成功后等待用户确认。
      if (key === "docx") {
        const controller = new AbortController()
        exportAbortRef.current = controller
        const result = await createDocumentDocx(snapshot, assets, controller.signal)
        if (mountedRef.current) setDocx(result)
      }
      // HTML 下载与打印共用快照 HTML；生成结束先检查所有者，再下载或建立打印文档。
      if (key === "html" || key === "print") {
        const html = await createDocumentHtml(snapshot, assets)
        if (!mountedRef.current) return
        if (key === "html") downloadDocument(new Blob([html], { type: "text/html;charset=utf-8" }), snapshot.title, "html")
        if (key === "print") {
          // 打印前检查实际表格宽度，避免超出正文纸宽导致裁切；需要用户调整纸张/列宽时提示并停止本轮打印。
          const tables = [...editor.view.dom.querySelectorAll("table")]
          if (tables.some(table => table.offsetWidth > editor.view.dom.clientWidth + 1)) {
            message.warning({ content: "表格超过纸张正文宽度，请缩小列宽或切换横版后打印", icon: <IconAlertTriangle aria-hidden="true" /> })
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
    // 转换失败只对存活会话显示消息，中止是正常清理不报错；finally 无论成功失败都释放导出锁。
    } catch (error) {
      if (mountedRef.current && error.name !== "AbortError") message.error({ content: error.message, icon: <IconCircleX aria-hidden="true" /> })
    } finally {
      pendingRef.current = false
      exportAbortRef.current = null
      if (mountedRef.current) setPending(false)
    }
  }

  // 会话卸载同时中止转换与打印加载，并调用打印资源清理，避免后台任务留下 iframe/临时对象。
  useEffect(() => () => {
    mountedRef.current = false
    exportAbortRef.current?.abort()
    printAbortRef.current?.abort()
    printCleanupRef.current?.()
  }, [])

  // 两种入口共用一份任务状态；确认弹窗稳定挂载，不因标签隐藏而丢失已生成结果。
  return (
    <>
      {variant === "ribbon" ? <div className={toolbarStyles.exports} aria-busy={pending}>
        {RIBBON_EXPORTS.map(({ key, label, icon: Icon }) => <button key={key} type="button"
          disabled={pending || uploading} onClick={() => handleExport({ key })}><Icon aria-hidden="true" /><span>{label}</span></button>)}
      </div> : <>
      <Button
        className={styles.print}
        icon={<IconPrinter aria-hidden="true" />}
        disabled={pending || uploading}
        onClick={() => handleExport({ key: "print" })}
      >打印</Button>
      <Dropdown
        menu={{ items: EXPORT_ITEMS, onClick: handleExport }}
        disabled={pending || uploading}
      >
        <Button
          type="primary"
          loading={(pending) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }}
          icon={<IconDownload aria-hidden="true" />}
        >导出文档 <IconChevronDown aria-hidden="true" /></Button>
      </Dropdown>
      </>}
      <MarkdownExportDialog result={markdown} onCancel={() => setMarkdown(null)} />
      <DocxExportDialog result={docx} onCancel={() => setDocx(null)} />
    </>
  )
}
