/**
 * Markdown 导出结果的确认与下载弹窗，展示转换损失以及受长度限制的源码预览。
 * 上层负责生成快照，本组件始终下载结果中的完整 source。
 */
import { Button, Input, Modal } from "antd"
import { MarkdownWarnings } from "./MarkdownWarnings.jsx"
import { downloadDocument } from "../tools/file-transfer.js"
import styles from "../sass/markdown.module.scss"

// 下载复用生成时的完整 source，和用户确认的预览保持同一快照；文本框截断只影响展示。
export function MarkdownExportDialog({ result, onCancel }) {
  // 以 UTF-8 Markdown Blob 下载已确认的结果；预览截断不会影响下载正文。
  const handleDownload = () => {
    downloadDocument(new Blob([result.source], { type: "text/markdown;charset=utf-8" }), result.title, "md")
    onCancel()
  }

  // 结果存在时才展示源码；文本区域只读，避免把展示用预览误当作可回写的正文草稿。
  return <Modal title="导出 Markdown" open={!!result} onCancel={onCancel} width={720} destroyOnHidden classNames={{ body: styles.body }}
    footer={<div className={styles.actions}>
      <Button type="primary" disabled={!result} onClick={handleDownload}>下载 .md</Button>
      <Button onClick={onCancel}>取消</Button>
    </div>}>
    {result && <div className={styles.container}>
      <p className={styles.hint}>这是生成时的文档快照。Markdown 保留文字与支持的结构，完整样式和图片请用 Mewoc 文件备份。</p>
      <MarkdownWarnings warnings={result.warnings} />
      <label>Markdown 源码{result.source.length > 200000 ? "（仅预览前 200000 字符，下载包含全文）" : ""}</label>
      <Input.TextArea aria-label="导出 Markdown 源码" value={result.source.slice(0, 200000)} rows={14} readOnly />
    </div>}
  </Modal>
}
