import { Alert, Button, Modal } from "antd"
import { downloadDocument } from "../tools/file-transfer.js"
import styles from "../sass/docx.module.scss"

export function DocxExportDialog({ result, onCancel }) {
  const handleDownload = () => {
    if (!result) return
    downloadDocument(result.blob, result.title, "docx")
    onCancel()
  }

  return <Modal title="导出 Word 文档" open={!!result} onCancel={onCancel} width={600} destroyOnHidden
    footer={<>
      <Button onClick={onCancel}>取消</Button>
      <Button type="primary" disabled={!result} onClick={handleDownload}>下载 .docx</Button>
    </>}>
    {result && <div className={styles.container}>
      <p>已生成「{result.title}」的 Word 文档。下载内容为点击导出时的快照。</p>
      {result.warnings.length > 0 && <Alert type="warning" showIcon message="以下内容已转换"
        description={<ul className={styles.warnings}>{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>} />}
      <p className={styles.hint}>Word 中的字体和分页可能与浏览器不同。需要保留全部编辑内容和附件时，请同时保存 Mewoc 文件。</p>
    </div>}
  </Modal>
}
