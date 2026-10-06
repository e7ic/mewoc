/**
 * 展示已经生成的 Word 快照与转换说明，用户确认后下载同一份 Blob。
 * 转换工作和异步取消属于导出入口，弹窗仅持有结果，不再次读取正在编辑的正文。
 */
import { IconAlertTriangle } from "@tabler/icons-react"
import { Alert, Button, Modal } from "antd"
import { downloadDocument } from "../tools/file-transfer.js"
import styles from "../sass/docx.module.scss"

export function DocxExportDialog({ result, onCancel }) {
  // 关闭或尚未生成时不启动下载；使用结果中的标题命名，保证下载与预览对应同一快照。
  const handleDownload = () => {
    if (!result) return
    downloadDocument(result.blob, result.title, "docx")
    onCancel()
  }

  // 警告逐项说明转换损失；结果存在时才展示内容并允许下载，取消仅释放上层结果引用。
  return <Modal title="导出 Word 文档" open={!!result} onCancel={onCancel} width={600} destroyOnHidden
    footer={<>
      <Button onClick={onCancel}>取消</Button>
      <Button type="primary" disabled={!result} onClick={handleDownload}>下载 .docx</Button>
    </>}>
    {result && <div className={styles.container}>
      <p>已生成「{result.title}」的 Word 文档。下载内容为点击导出时的快照。</p>
      {result.warnings.length > 0 && <Alert type="warning" icon={<IconAlertTriangle aria-hidden="true" />} showIcon message="以下内容已转换"
        description={<ul className={styles.warnings}>{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>} />}
      <p className={styles.hint}>Word 中的字体和分页可能与浏览器不同。需要保留全部编辑内容和附件时，请同时保存 Mewoc 文件。</p>
    </div>}
  </Modal>
}
