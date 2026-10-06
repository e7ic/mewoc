/**
 * 详细段落弹窗为原选区编辑段前/段后间距与分页属性，所有输入先保存在草稿。
 * 只提交用户实际修改的字段，混合范围中未触碰的值保持各段落原设置。
 */
import { useEffect, useRef, useState } from "react"
import { Button, Modal } from "antd"
import { useEditorState } from "@tiptap/react"
import { IconAdjustmentsHorizontal } from "@tabler/icons-react"
import { ToolbarButton } from "./ToolbarButton.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { applyParagraphSettings, captureParagraphTarget, mapParagraphTarget, readParagraphSettings } from "../tools/paragraph-settings.js"
import styles from "../sass/paragraph-settings.module.scss"

// 允许提交的字段白名单；mixed 表示范围内不同值，null 表示使用默认，分页 false 表示明确关闭。
const PARAGRAPH_FIELDS = ["spaceBefore", "spaceAfter", "keepWithNext", "keepTogether"]
const PARAGRAPH_MIXED = "mixed"
const PAGINATION_OPTIONS = [["default", "默认"], ["true", "开启"], ["false", "关闭"]]

export function ParagraphSettings({ compact = false }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  // draft 控制弹窗并保存临时值，dirty 标记补丁字段，count 记录捕获时段落数量用于说明范围。
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState({})
  const [count, setCount] = useState(0)
  const [error, setError] = useState("")
  // 目标与订阅保存在 ref，使正文事务更新位置时不重置用户输入的草稿。
  const targetRef = useRef(null)
  const stopTrackingRef = useRef(null)
  const hasParagraph = useEditorState({ editor, selector: ({ editor: current }) => !!captureParagraphTarget(current) })

  // 每次操作检查实时只读/切换、编辑器生命周期和输入法，避免弹窗期间状态变化后继续提交。
  const getBlocked = () => {
    const state = store.getState()
    return state.readOnly || state.switching || !editor || editor.isDestroyed || !editor.isEditable || editor.view.composing
  }

  // 统一解除原范围事务跟踪，防止关闭后的段落继续更新旧弹窗目标。
  const handleClearTarget = () => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    targetRef.current = null
  }
  // 捕获有效范围并复制汇总属性，随后只映射目标位置；正文选区改变不会重新初始化草稿。
  const handleOpen = () => {
    if (getBlocked()) return
    const target = captureParagraphTarget(editor)
    const record = target && readParagraphSettings(editor, target)
    if (!record) return
    handleClearTarget()
    targetRef.current = target
    // 捕获后立即跟踪完整事务链，焦点、只读切换均不重新读取或覆盖正在编辑的草稿。
    const handleTransaction = ({ transaction, appendedTransactions = [] }) => {
      if (targetRef.current !== target) return
      for (const current of [transaction, ...appendedTransactions]) mapParagraphTarget(target, current)
      if (target.valid === false) setError("原段落已被删除或替换，请关闭弹窗后重新选择。")
    }
    editor.on("transaction", handleTransaction)
    stopTrackingRef.current = () => editor.off("transaction", handleTransaction)
    setDraft({ ...record.values })
    setCount(record.count)
    setDirty({})
    setError("")
  }
  // 取消与成功提交共用清理路径，释放目标、草稿、脏字段和数量/错误提示。
  const handleCancel = () => {
    handleClearTarget()
    setDraft(null)
    setDirty({})
    setCount(0)
    setError("")
  }
  // 只在可编辑时更新单个草稿字段并标脏，保存时据此生成最小补丁。
  const handleChange = (field, value) => {
    if (getBlocked()) return
    setDraft(current => ({ ...current, [field]: value }))
    setDirty(current => ({ ...current, [field]: true }))
  }
  const handleNumericChange = (field, event) => {
    // 原生数字框仍保留越界值；空值恢复默认，0 是明确的零间距，未完成的数值不能当默认保存。
    const input = event.target
    const value = input.validity.badInput ? NaN : input.value === "" ? null : Number(input.value)
    handleChange(field, value)
  }
  // 表单字符串解析成 null/boolean，使默认、开启、关闭三种语义不被混为一谈。
  const handlePaginationChange = (field, event) => {
    const value = event.target.value
    handleChange(field, value === "default" ? null : value === "true")
  }
  // 恢复默认将四个字段都标为已修改，保证明确的默认选择覆盖原选区中所有相关属性。
  const handleRestore = () => {
    if (getBlocked()) return
    setDraft({ spaceBefore: null, spaceAfter: null, keepWithNext: null, keepTogether: null })
    setDirty({ spaceBefore: true, spaceAfter: true, keepWithNext: true, keepTogether: true })
    if (targetRef.current?.valid !== false) setError("")
  }
  // 阻止原生表单刷新后构造字段补丁，工具函数统一验证数值、映射目标及撤销边界；失败保留草稿。
  const handleSave = event => {
    event.preventDefault()
    const blocked = getBlocked()
    if (blocked) {
      setError("当前文档不可编辑，草稿已保留；恢复编辑后可以应用。")
      return
    }
    const patch = {}
    // 未触碰的混合值不进入补丁，避免用一个段落的设置覆盖整个原选区。
    for (const field of PARAGRAPH_FIELDS) {
      if (dirty[field]) patch[field] = draft[field]
    }
    const result = applyParagraphSettings(editor, targetRef.current, patch, blocked)
    if (!result.ok) {
      setError(result.error || "原段落已变化，请关闭弹窗后重新选择。")
      return
    }
    handleCancel()
    editor.commands.focus()
  }

  // 卸载解除正文事务订阅并清空目标，避免会话切换留下对旧编辑器的引用。
  useEffect(() => () => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    targetRef.current = null
  }, [editor])

  // compact 仅改变入口外观；弹窗在只读时保留草稿并禁用输入，目标失效时阻止应用但允许取消。
  return <>
    {compact ? <ToolbarButton label="段落设置" disabled={readOnly || !hasParagraph} onClick={handleOpen}><IconAdjustmentsHorizontal aria-hidden="true" /></ToolbarButton>
      : <Button disabled={readOnly || !hasParagraph} onMouseDown={event => event.preventDefault()} onClick={handleOpen}>段落设置</Button>}
    <Modal className={styles.modal} style={{ top: 24 }} title="段落设置" open={!!draft} onCancel={handleCancel}
      footer={null} width={520} destroyOnHidden>
      {draft && <form className={styles.form} noValidate onSubmit={handleSave}>
        <p className={styles.hint}>应用到打开弹窗时选中的 {count} 个段落。混合值表示设置不同，只有修改的字段会应用。</p>
        <fieldset className={styles.section} disabled={readOnly}>
          <legend>段落间距</legend>
          <div className={styles.grid}>
            <ParagraphNumber label="段前间距" value={draft.spaceBefore} disabled={readOnly}
              onChange={event => handleNumericChange("spaceBefore", event)} />
            <ParagraphNumber label="段后间距" value={draft.spaceAfter} disabled={readOnly}
              onChange={event => handleNumericChange("spaceAfter", event)} />
          </div>
          <p className={styles.hint}>可设置 0–120 pt，步进 0.5 pt；留空使用默认间距。</p>
        </fieldset>
        <fieldset className={styles.section} disabled={readOnly}>
          <legend>分页</legend>
          <div className={styles.grid}>
            <ParagraphPagination label="与下段同页" value={draft.keepWithNext} disabled={readOnly}
              onChange={event => handlePaginationChange("keepWithNext", event)} />
            <ParagraphPagination label="段内不分页" value={draft.keepTogether} disabled={readOnly}
              onChange={event => handlePaginationChange("keepTogether", event)} />
          </div>
          <p className={styles.hint}>分页设置用于打印和 Word，长段落仍可能跨页。</p>
        </fieldset>
        <Button disabled={readOnly || targetRef.current?.valid === false} onClick={handleRestore}>恢复默认</Button>
        {readOnly && <p role="status" className={styles.hint}>当前文档为只读或正在切换，草稿已保留。</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.footer}>
          <Button onClick={handleCancel}>取消</Button>
          <Button type="primary" htmlType="submit" disabled={readOnly || targetRef.current?.valid === false}>应用段落设置</Button>
        </div>
      </form>}
    </Modal>
  </>
}

// 原生数字输入允许保存暂时无效的草稿，空值显示默认，混合值通过占位提示而不是冒充具体数值。
const ParagraphNumber = ({ label, value, disabled, onChange }) => <label className={styles.field}>
  <span>{label} <small>pt</small></span>
  <input aria-label={label} type="number" min={0} max={120} step={0.5} disabled={disabled}
    value={value === PARAGRAPH_MIXED || value === null || Number.isNaN(value) ? "" : value}
    placeholder={value === PARAGRAPH_MIXED ? "混合（保持各自设置）" : "默认"} onChange={onChange} />
</label>

// 分页选择区分混合占位和默认值，只在用户选定实际选项后产生补丁。
const ParagraphPagination = ({ label, value, disabled, onChange }) => <label className={styles.field}>
  <span>{label}</span>
  <select aria-label={label} value={value === null ? "default" : String(value)} disabled={disabled} onChange={onChange}>
    {value === PARAGRAPH_MIXED && <option value={PARAGRAPH_MIXED} disabled>混合（保持各自设置）</option>}
    {PAGINATION_OPTIONS.map(([option, text]) => <option value={option} key={option}>{text}</option>)}
  </select>
</label>
