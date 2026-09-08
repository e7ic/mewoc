import { useEffect, useRef, useState } from "react"
import { Button, Form, Input, Modal } from "antd"
import { FileMarkdownOutlined } from "@ant-design/icons"
import { MarkdownWarnings } from "./MarkdownWarnings.jsx"
import { readMarkdownSource, readMarkdownDocument } from "../tools/markdown-file.js"
import styles from "../sass/markdown.module.scss"

// 草稿、预览结果与实际导入分开：只有当前草稿转换成功后，才允许交给父级切换文档。
export function MarkdownImportAction({ disabled, onImport }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ title: "Markdown 文档", source: "" })
  const [result, setResult] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  // 修改草稿、关闭或卸载都会使旧版本失效，防止迟到的读取/转换结果重新打开旧预览。
  const versionRef = useRef(0)

  const handleChange = next => {
    versionRef.current += 1
    setDraft(next)
    setResult(null)
    setError("")
  }
  const handleOpen = () => {
    handleChange({ title: "Markdown 文档", source: "" })
    setOpen(true)
  }
  const handleCancel = () => {
    if (disabled) return
    versionRef.current += 1
    setOpen(false)
    setPending(false)
    setResult(null)
  }
  const handlePreview = async file => {
    const version = ++versionRef.current
    setPending(true)
    setError("")
    setResult(null)
    try {
      const next = file ? await readMarkdownSource(file) : draft
      if (version !== versionRef.current) return
      setDraft(next)
      const converted = await readMarkdownDocument(next.source, next.title)
      if (version === versionRef.current) setResult(converted)
    } catch (failure) {
      if (version === versionRef.current) setError(failure.message)
    } finally {
      if (version === versionRef.current) setPending(false)
    }
  }
  const handleImport = async () => {
    if (!result || pending || disabled) return
    const version = versionRef.current
    setPending(true)
    try {
      // 父级先保存当前文档；返回失败时留在弹窗提示，成功则由会话切换卸载此组件。
      const changed = await onImport(result.record)
      if (!changed && version === versionRef.current) setError("当前文档未能保存，请处理保存错误后重试")
    } catch (failure) {
      if (version === versionRef.current) setError(failure.message)
    } finally {
      if (version === versionRef.current) setPending(false)
    }
  }

  useEffect(() => () => { versionRef.current += 1 }, [])

  return <>
    <button type="button" disabled={disabled} onClick={handleOpen}><FileMarkdownOutlined />导入 Markdown</button>
    <MarkdownImportDialog open={open} draft={draft} result={result} error={error} pending={pending} disabled={disabled}
      onChange={handleChange} onCancel={handleCancel} onPreview={handlePreview} onImport={handleImport} />
  </>
}

const MarkdownImportDialog = ({ open, draft, result, error, pending, disabled, onChange, onCancel, onPreview, onImport }) => {
  const fileInputRef = useRef(null)
  const handleFile = event => {
    const file = event.target.files[0]
    event.target.value = ""
    if (file) onPreview(file)
  }
  return <Modal title="导入 Markdown" open={open} onCancel={onCancel} width={720} destroyOnHidden
    classNames={{ body: styles.body }} closable={!disabled} maskClosable={!disabled} keyboard={!disabled}
    footer={<div className={styles.actions}>
      <Button loading={pending} disabled={disabled} onClick={() => onPreview()}>预览转换</Button>
      <Button type="primary" disabled={!result || pending || disabled} onClick={onImport}>导入为新文档</Button>
      <Button disabled={disabled} onClick={onCancel}>取消</Button>
    </div>}>
    <div className={styles.container}>
      <p className={styles.hint}>先查看转换结果，再创建新文档。图片保留说明和地址，完整备份请使用 Mewoc 文件。</p>
      <Button disabled={pending || disabled} onClick={() => fileInputRef.current.click()}>选择 .md 文件</Button>
      <input ref={fileInputRef} type="file" accept=".md,.markdown" aria-label="选择 Markdown 文件" hidden onChange={handleFile} />
      <Form layout="vertical" onFinish={() => onPreview()}>
        <Form.Item label="文档标题"><Input aria-label="Markdown 文档标题" value={draft.title} maxLength={100} disabled={pending || disabled}
          onChange={event => onChange({ ...draft, title: event.target.value })} /></Form.Item>
        <Form.Item label="Markdown 源码" help="UTF-8 文件不超过 1 MiB，源码不超过 200000 字符。">
          <Input.TextArea aria-label="Markdown 源码" value={draft.source} rows={8} showCount
            disabled={pending || disabled} onChange={event => onChange({ ...draft, source: event.target.value })} />
        </Form.Item>
        {result && <div className={styles.result}>
          <MarkdownWarnings warnings={result.warnings} />
          <label>导入正文（前 5000 字符纯文本预览）</label>
          <Input.TextArea aria-label="导入正文预览" value={result.preview.slice(0, 5000)} rows={5} readOnly />
        </div>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </Form>
    </div>
  </Modal>
}
