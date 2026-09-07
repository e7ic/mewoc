import { Button, Input, Modal } from "antd"
import { MarkdownWarnings } from "./MarkdownWarnings.jsx"
import { downloadDocument } from "../tools/file-transfer.js"
import styles from "../sass/markdown.module.scss"

export function MarkdownExportDialog({ result, onCancel }) {
  const handleDownload = () => {
    downloadDocument(new Blob([result.source], { type: "text/markdown;charset=utf-8" }), result.title, "md")
    onCancel()
  }

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
