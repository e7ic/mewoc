/**
 * Word 导入采用读取转换、结果预览、确认新文档三步流程，错误保留在当前弹窗。
 * 转换版本号、AbortController 和同步导入锁共同防止旧结果回写与重复会话切换。
 */
import { useEffect, useRef, useState } from "react"
import { Alert, Button, Input, Modal } from "antd"
import { IconAlertTriangle, IconFileTypeDocx, IconLoader2 } from "@tabler/icons-react"
import { readDocxDocument } from "../tools/docx-import-file.js"
import { getPreviewPage } from "../tools/page-preview.js"
import { PageWatermark } from "./PageWatermark.jsx"
import { PageFurniture } from "./PageFurniture.jsx"
import styles from "../sass/docx.module.scss"

export function DocxImportAction({ disabled, onImport }) {
  // result 只保存本轮成功转换的记录；pending 表示读取/转换，importing 表示父级保存并切换。
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState(null)
  const [pending, setPending] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState("")
  // inputRef 触发文件选择；abortRef 中止转换；versionRef 排除过期结果；importingRef 立即阻止双击。
  const inputRef = useRef(null)
  const abortRef = useRef(null)
  const versionRef = useRef(0)
  const importingRef = useRef(false)

  // 重新打开先让旧任务失效并中止它，清除旧结果与错误，再建立新的预览流程。
  const handleOpen = () => {
    versionRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    setResult(null)
    setError("")
    setOpen(true)
  }
  // 实际导入或父级切换期间不允许关闭；普通取消使读取版本失效并回收转换任务。
  const handleCancel = () => {
    if (importingRef.current || disabled) return
    versionRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setResult(null)
    setPending(false)
    setOpen(false)
  }
  // 新文件替换旧转换；清空原生输入值允许重新选择同一文件，只有最新版本能更新预览和忙碌状态。
  const handleFile = async event => {
    const file = event.target.files[0]
    event.target.value = ""
    if (!file || importingRef.current || disabled) return
    const version = ++versionRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setResult(null)
    setError("")
    setPending(true)
    try {
      const converted = await readDocxDocument(file, controller.signal)
      if (version === versionRef.current) setResult(converted)
    } catch (failure) {
      if (version === versionRef.current && failure.name !== "AbortError") setError(failure.message)
    } finally {
      if (version === versionRef.current) {
        setPending(false)
        abortRef.current = null
      }
    }
  }
  // 确认后先占同步锁，再请求父级保存当前正文并切换；失败不丢弃已经转换好的结果。
  const handleImport = async () => {
    if (!result || pending || disabled || importingRef.current) return
    importingRef.current = true
    setImporting(true)
    setError("")
    const version = versionRef.current
    try {
      // 与打开本地文件共用切换契约：先保存旧正文，失败留在当前会话并保留待导入结果。
      const changed = await onImport(result.record)
      if (version !== versionRef.current) return
      if (!changed) setError("当前文档未能保存，请处理保存错误后重试")
      else {
        setOpen(false)
        setResult(null)
      }
    } catch (failure) {
      if (version === versionRef.current) setError(failure.message)
    } finally {
      importingRef.current = false
      if (version === versionRef.current) setImporting(false)
    }
  }

  // 卸载时使版本失效并中止转换，即使转换器随后完成也不能写回已离开的会话。
  useEffect(() => () => {
    versionRef.current += 1
    abortRef.current?.abort()
  }, [])

  // 页面摘要只读转换结果，不引用当前会话；取消预览不会提前应用纸张、边距或水印。
  const previewPage = result ? getPreviewPage(result.record.document.page) : null

  // 转换期间显示进度，完成后展示预览；提交期间锁定关闭入口，避免文件切换中断父级保存契约。
  return <>
    <button type="button" disabled={disabled} onClick={handleOpen}><IconFileTypeDocx aria-hidden="true" />导入 Word</button>
    <Modal title="导入 Word 文档" open={open} onCancel={handleCancel} width={720} style={{ top: 24 }} destroyOnHidden
      classNames={{ body: styles.body }} closable={!importing && !disabled} maskClosable={!importing && !disabled} keyboard={!importing && !disabled}
      footer={<div className={styles.actions}>
        <Button disabled={importing || disabled} onClick={handleCancel}>取消</Button>
        <Button type="primary" loading={(importing) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }} disabled={!result || pending || disabled} onClick={handleImport}>导入为新文档</Button>
      </div>}>
      <div className={styles.container}>
        <p className={styles.hint}>选择 .docx 文件，查看内容与转换说明后创建新文档。请保留原文件，以便核对原始格式。</p>
        <Button loading={(pending) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }} disabled={importing || disabled} onClick={() => inputRef.current.click()}>{pending ? "正在转换 Word…" : "选择 .docx 文件"}</Button>
        <input ref={inputRef} type="file" accept=".docx" aria-label="选择 Word 文件" hidden onChange={handleFile} />
        {pending && <p role="status">正在检查文档与图片，可以取消本次转换。</p>}
        {result && <div className={styles.result}>
          <p>将创建「{result.record.document.title}」</p>
          <div className={styles.pageSummary}>
            <div className={styles.pagePreview} data-docx-import-page-preview="" style={previewPage.style} aria-hidden="true">
              <PageWatermark page={result.record.document.page} />
              <PageFurniture page={result.record.document.page} />
              <div className={styles.previewLines}><span /><span /><span /><span /></div>
            </div>
            <div>
              <p aria-label="Word 导入页面设置">{previewPage.description}</p>
              <p className={styles.hint}>页面设置示意；正文按内容语义导入，原始分页不保证保留。</p>
            </div>
          </div>
          {result.warnings.length > 0 && <Alert type="warning" icon={<IconAlertTriangle aria-hidden="true" />} showIcon message="转换说明"
            description={<ul className={styles.warnings}>{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>} />}
          <label>导入正文（前 5000 字符纯文本预览）</label>
          <Input.TextArea aria-label="Word 导入正文预览" value={result.preview.slice(0, 5000)} rows={6} readOnly />
        </div>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
    </Modal>
  </>
}
