import { useEffect, useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { NodeSelection } from "@tiptap/pm/state"
import { Button, Form, Input, Modal, Select } from "antd"
import { FunctionOutlined } from "@ant-design/icons"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { useSelectionBookmark } from "../hooks/use-selection-bookmark.js"
import { FORMULA_TYPES, MAX_FORMULA_LENGTH, renderFormula } from "../tools/formula.js"
import { applyFormula, removeFormula } from "../tools/formula-commands.js"
import { FormulaPreview } from "./FormulaPreview.jsx"
import styles from "../sass/formula.module.scss"

export function FormulaAction() {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const selected = useEditorState({ editor, selector: ({ editor: current }) => current.state.selection instanceof NodeSelection
    && FORMULA_TYPES.includes(current.state.selection.node.type.name) })
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ type: "inlineMath", latex: "", original: null })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const versionRef = useRef(0)
  const { captureSelection, getSelection, clearSelection } = useSelectionBookmark(editor, open)

  const handleOpen = () => {
    captureSelection()
    const node = selected ? editor.state.selection.node : null
    // 保存原类型和源码供提交时核对，书签只跟踪位置，不能证明目标仍是同一份公式内容。
    const original = node ? { type: node.type.name, latex: node.attrs.latex } : null
    setDraft({ type: original?.type || "inlineMath", latex: original?.latex || "E = mc^2", original })
    setError("")
    setOpen(true)
    versionRef.current += 1
  }
  const handleCancel = () => {
    versionRef.current += 1
    clearSelection()
    setOpen(false)
    setPending(false)
  }
  const handleSave = async () => {
    if (pending || readOnly) return
    const version = versionRef.current
    setPending(true)
    setError("")
    try {
      // 先确认 LaTeX 可渲染，再解析当前书签并写正文；关闭弹窗会让本轮异步结果失效。
      await renderFormula(draft.latex, draft.type === "blockMath")
      if (version !== versionRef.current || editor.isDestroyed) return
      if (!applyFormula(editor, getSelection(), draft, draft.original)) throw new Error("原选区或公式已变化，或当前不可编辑；请关闭后重新选择")
      handleCancel()
      editor.commands.focus()
    } catch (failure) {
      if (version === versionRef.current) setError(failure.message)
    } finally {
      if (version === versionRef.current) setPending(false)
    }
  }
  const handleRemove = () => {
    if (!removeFormula(editor, getSelection(), draft.original)) {
      setError("原公式已变化或当前不可编辑，请关闭后重新选择")
      return
    }
    handleCancel()
    editor.commands.focus()
  }
  useEffect(() => () => { versionRef.current += 1 }, [])

  return <>
    <button type="button" disabled={readOnly} onMouseDown={event => event.preventDefault()} onClick={handleOpen}>
      <FunctionOutlined /><span>{selected ? "编辑公式" : "公式"}</span>
    </button>
    <FormulaDialog open={open} draft={draft} setDraft={setDraft} error={error} pending={pending} readOnly={readOnly}
      onCancel={handleCancel} onSave={handleSave} onRemove={handleRemove} />
  </>
}

const FormulaDialog = ({ open, draft, setDraft, error, pending, readOnly, onCancel, onSave, onRemove }) => (
  <Modal title={draft.original ? "编辑公式" : "插入公式"} open={open} onCancel={onCancel} footer={null} destroyOnHidden>
    <div className={styles.container}>
      <Form layout="vertical" onFinish={onSave}>
        <Form.Item label="显示方式">
          <Select aria-label="公式显示方式" value={draft.type} disabled={!!draft.original || pending || readOnly}
            options={[{ value: "inlineMath", label: "行内公式" }, { value: "blockMath", label: "独立公式" }]}
            onChange={type => setDraft({ ...draft, type })} />
        </Form.Item>
        <Form.Item label="LaTeX 源码" help="直接输入源码，无需添加 $ 分隔符。">
          <Input.TextArea aria-label="LaTeX 源码" value={draft.latex} rows={4} maxLength={MAX_FORMULA_LENGTH} showCount autoFocus
            disabled={pending || readOnly} onChange={event => setDraft({ ...draft, latex: event.target.value })} />
        </Form.Item>
        {open && <FormulaPreview latex={draft.latex} type={draft.type} />}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <Button type="primary" htmlType="submit" loading={pending} disabled={readOnly}>应用公式</Button>
          <Button onClick={onCancel}>取消</Button>
          {draft.original && <Button danger disabled={pending || readOnly} onClick={onRemove}>删除公式</Button>}
        </div>
      </Form>
    </div>
  </Modal>
)
