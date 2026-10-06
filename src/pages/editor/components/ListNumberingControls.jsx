import { useCallback, useEffect, useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Popover } from "antd"
import { IconChevronDown } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import { createId } from "../tools/create-id.js"
import { applyListNumbering, captureListNumberingTarget, mapListNumberingTarget, readListNumberingSettings, supportsListNumberingSelection, LIST_NUMBERING_MAX_START } from "../tools/list-numbering.js"
import styles from "../sass/list-numbering.module.scss"
import ribbonStyles from "../sass/ribbon-controls.module.scss"

const TYPES = [["1", "数字", "1、2、3"], ["a", "小写字母", "a、b、c"], ["A", "大写字母", "A、B、C"],
  ["i", "小写罗马数字", "i、ii、iii"], ["I", "大写罗马数字", "I、II、III"]]

/** 编号面板只编辑打开时的那一个列表，输入框获得焦点后不重新读取当前光标。 */
export function ListNumberingControls({ active = true, resetKey = "" }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const supported = useEditorState({ editor, selector: ({ editor: current }) => supportsListNumberingSelection(current) })
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ type: "1", start: 1 })
  const [error, setError] = useState("")
  const [valid, setValid] = useState(true)
  const [id] = useState(() => `mewoc-numbering-${createId()}`)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const targetRef = useRef(null)
  const stopTrackingRef = useRef(null)
  const start = Number(draft.start)
  const validStart = String(draft.start).trim() !== "" && Number.isSafeInteger(start) && start >= 1 && start <= LIST_NUMBERING_MAX_START
  const close = useCallback(() => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    targetRef.current = null
    setOpen(false)
    setError("")
    setValid(true)
  }, [])
  const blocked = () => {
    const current = store.getState()
    return !active || !canEditRibbon(editor, current.readOnly || current.switching)
  }
  const handleOpenChange = next => {
    if (!next) { close(); return }
    if (blocked()) return
    const target = captureListNumberingTarget(editor)
    const values = readListNumberingSettings(editor, target)
    if (!values) return
    close()
    targetRef.current = target
    setDraft(values)
    // 逐个映射追加事务，防止列表结构修复后仍指向旧位置；只移动正文光标不会转移目标。
    const track = ({ transaction, appendedTransactions = [] }) => {
      for (const current of [transaction, ...appendedTransactions]) mapListNumberingTarget(target, current)
      const available = !!readListNumberingSettings(editor, target)
      setValid(available)
      if (!available) setError("原列表已被删除或替换，请关闭后重新选择。")
    }
    editor.on("transaction", track)
    stopTrackingRef.current = () => editor.off("transaction", track)
    setOpen(true)
  }
  const handleApply = event => {
    event.preventDefault()
    if (blocked() || !validStart) return
    const result = applyListNumbering(editor, targetRef.current, { type: draft.type, start }, blocked())
    if (!result.ok) { setError(result.error); return }
    close()
    editor.commands.focus()
  }
  const handleKey = event => {
    if (event.key !== "Escape" || event.isComposing || editor.view.composing) return
    event.preventDefault()
    event.stopPropagation()
    close()
    triggerRef.current?.focus({ preventScroll: true })
  }
  useEffect(() => { if (!active || readOnly) close() }, [active, readOnly, close])
  useEffect(() => { close() }, [resetKey, close])
  useEffect(() => () => stopTrackingRef.current?.(), [editor])
  const focusChoice = () => panelRef.current?.querySelector('input[type="radio"]:checked')?.focus()

  return <Popover trigger="click" placement="bottomLeft" open={open} onOpenChange={handleOpenChange} destroyOnHidden
    afterOpenChange={visible => { if (visible && open) focusChoice() }}
    content={<form ref={panelRef} className={styles.panel} role="dialog" aria-label="编号设置" onSubmit={handleApply} onKeyDown={handleKey}>
      <strong>编号设置</strong>
      <fieldset className={styles.choices} disabled={!valid || readOnly}>
        <legend>编号样式</legend>
        {TYPES.map(([type, label, sample]) => <label key={type} className={styles.choice} data-selected={draft.type === type}>
          <input type="radio" name={`${id}-type`} value={type} checked={draft.type === type} aria-label={label}
            onChange={() => setDraft(current => ({ ...current, type }))} />
          <span>{label}</span><span className={styles.sample} aria-hidden="true">{sample}</span>
        </label>)}
      </fieldset>
      <label className={styles.field}>起始编号
        <input type="number" aria-label="起始编号" value={draft.start} min={1} max={LIST_NUMBERING_MAX_START} step={1} required
          disabled={!valid || readOnly} aria-invalid={!validStart} onChange={event => setDraft(current => ({ ...current, start: event.target.value }))} />
      </label>
      {!validStart && <p className={styles.error} role="alert">请输入 1–{LIST_NUMBERING_MAX_START} 之间的整数。</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" onClick={() => { close(); triggerRef.current?.focus({ preventScroll: true }) }}>取消</button>
        <button className={styles.primary} type="submit" disabled={!valid || !validStart || readOnly}>应用编号</button>
      </div>
    </form>}>
    <button ref={triggerRef} type="button" className={ribbonStyles.arrow} aria-label="编号设置" aria-haspopup="dialog" aria-expanded={open}
      title={supported ? "编号样式与起始号" : "将光标放入一个有序列表后设置编号"} disabled={!active || readOnly || !supported}
      onMouseDown={event => event.preventDefault()}><IconChevronDown aria-hidden="true" /></button>
  </Popover>
}
