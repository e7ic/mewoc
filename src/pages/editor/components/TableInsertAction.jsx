/**
 * 表格插入浮层提供尺寸网格与自定义行列，并始终插到打开时捕获的正文位置。
 * 表格内光标使用命令定义的表后插入策略，网格悬停只预览尺寸，不预先修改正文。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Popover } from "antd"
import { IconTable, IconChevronDown, IconArrowLeft } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { createId } from "../tools/create-id.js"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import { captureTableInsertTarget, getTableInsertSelection, insertTableAtTarget, mapTableInsertTarget, supportsTableInsertSelection, TABLE_INSERT_LIMITS, validateTableSize } from "../tools/table-insert.js"
import styles from "../sass/table-insert.module.scss"

// 常用尺寸网格固定为 8 行 10 列，实际自定义限制来自工具常量，避免 UI 与命令校验范围分叉。
const GRID_ROWS = 8
const GRID_COLS = 10
const cells = Array.from({ length: GRID_ROWS * GRID_COLS }, (_, index) => ({ rows: Math.floor(index / GRID_COLS) + 1, cols: index % GRID_COLS + 1 }))

export function TableInsertAction({ active = true, layoutKey = "", label = "表格" }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const supported = useEditorState({ editor, selector: ({ editor: current }) => supportsTableInsertSelection(current) })
  // 网格预览与键盘焦点分开；custom 切换输入模式，values 保存自定义草稿，withHeaderRow 两种模式共用。
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  const [preview, setPreview] = useState({ rows: 1, cols: 1 })
  const [focusIndex, setFocusIndex] = useState(0)
  const [values, setValues] = useState({ rows: 3, cols: 3 })
  const [withHeaderRow, setWithHeaderRow] = useState(true)
  const [error, setError] = useState("")
  const [valid, setValid] = useState(true)
  const [id] = useState(() => `mewoc-table-insert-${createId()}`)
  // 入口 ref 用于 Escape 恢复焦点，panelRef 管理网格导航；目标与事务订阅由当前弹层持有。
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const targetRef = useRef(null)
  const stopTrackingRef = useRef(null)
  // 每次草稿变化都做尺寸组合校验，既检查行列范围，也检查总单元格上限。
  const size = validateTableSize({ rows: Number(values.rows), cols: Number(values.cols), withHeaderRow })

  // 关闭释放目标订阅并清错误，下一轮打开重捕获位置，不沿用旧光标或旧失败状态。
  const handleClose = useCallback(() => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    targetRef.current = null
    setOpen(false)
    setError("")
    setValid(true)
  }, [])
  const getBlocked = () => {
    const current = store.getState()
    return !active || !canEditRibbon(editor, current.readOnly || current.switching)
  }
  // 成功捕获目标后才打开；重置网格、草稿和表头选项，正文变化时映射原位置并反馈失效。
  const handleOpenChange = next => {
    if (!next) { handleClose(); return }
    if (getBlocked()) return
    const target = captureTableInsertTarget(editor)
    if (!target) return
    handleClose()
    targetRef.current = target
    // 面板获得焦点后继续追踪打开时的位置；其他编辑事务不能把插入重定向到新光标。
    const track = ({ transaction, appendedTransactions = [] }) => {
      if (targetRef.current !== target) return
      for (const current of [transaction, ...appendedTransactions]) mapTableInsertTarget(target, current)
      const available = !!getTableInsertSelection(editor, target)
      setValid(available)
      if (!available) setError("原插入位置已被删除或替换，请关闭后重新选择。")
    }
    editor.on("transaction", track)
    stopTrackingRef.current = () => editor.off("transaction", track)
    setCustom(false)
    setPreview({ rows: 1, cols: 1 })
    setFocusIndex(0)
    setValues({ rows: 3, cols: 3 })
    setWithHeaderRow(true)
    setOpen(true)
  }
  // 网格与自定义提交共用插入命令，携带表头选项并再次检查会话状态；失败留面板，成功回正文。
  const handleInsert = dimensions => {
    if (getBlocked()) return
    const result = insertTableAtTarget(editor, targetRef.current, { ...dimensions, withHeaderRow }, getBlocked())
    if (!result.ok) { setError(result.error); return }
    handleClose()
    editor.commands.focus()
  }
  // Escape 结束插入并返回入口；方向键只操作尺寸网格，按行列钳制边界，Home/End 到网格首尾。
  const handleKey = event => {
    if (event.isComposing || editor.view.composing) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      handleClose()
      triggerRef.current?.focus({ preventScroll: true })
      return
    }
    if (!event.target.matches("[data-table-size]") || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const buttons = [...panelRef.current.querySelectorAll("[data-table-size]")]
    const index = buttons.indexOf(event.target)
    const row = Math.floor(index / GRID_COLS)
    const col = index % GRID_COLS
    // 边缘方向键停在当前格，避免从最后一列意外跳到下一行第一列。
    const next = ({ ArrowLeft: row * GRID_COLS + Math.max(0, col - 1), ArrowRight: row * GRID_COLS + Math.min(GRID_COLS - 1, col + 1),
      ArrowUp: Math.max(0, row - 1) * GRID_COLS + col, ArrowDown: Math.min(GRID_ROWS - 1, row + 1) * GRID_COLS + col,
      Home: 0, End: buttons.length - 1 })[event.key]
    buttons[next]?.focus()
  }
  // 面板失活、只读或布局改变终止本轮插入；卸载解除事务映射监听。
  useEffect(() => { if (!active || readOnly) handleClose() }, [active, readOnly, handleClose])
  useEffect(() => { handleClose() }, [layoutKey, handleClose])
  useEffect(() => () => { stopTrackingRef.current?.() }, [editor])
  // 切入自定义模式聚焦行数，回到网格聚焦首格，确保两种模式都能用键盘继续选择。
  useEffect(() => {
    if (open) panelRef.current?.querySelector(custom ? '[aria-label="行数"]' : '[data-table-size="1x1"]')?.focus()
  }, [open, custom])

  // 网格状态播报尺寸；自定义表单关联校验错误及确认按钮，目标失效或只读时禁止插入。
  return <Popover trigger="click" placement="bottomLeft" open={open} onOpenChange={handleOpenChange} destroyOnHidden
    afterOpenChange={visible => { if (visible && open) panelRef.current?.querySelector('[data-table-size="1x1"]')?.focus() }}
    content={<div ref={panelRef} id={id} className={styles.panel} role="dialog" aria-modal="false" aria-label="插入表格" onKeyDown={handleKey}>
      <div className={styles.heading}><strong>插入表格</strong>{!custom && <span role="status" aria-live="polite">{preview.rows} 行 × {preview.cols} 列</span>}</div>
      {!custom ? <>
        <div className={styles.grid} role="group" aria-label="选择表格行列数">
          {cells.map((cell, index) => <button key={index} type="button" data-table-size={`${cell.rows}x${cell.cols}`}
            data-active={cell.rows <= preview.rows && cell.cols <= preview.cols} aria-label={`插入表格：${cell.rows} 行 × ${cell.cols} 列`}
            tabIndex={index === focusIndex ? 0 : -1} disabled={readOnly || !valid}
            onMouseEnter={() => setPreview(cell)} onFocus={() => { setPreview(cell); setFocusIndex(index) }}
            onMouseDown={event => event.preventDefault()} onClick={() => handleInsert(cell)} />)}
        </div>
        <p className={styles.hint}>移动鼠标或按方向键选择，点击或按 Enter 插入。</p>
      </> : <form id={`${id}-form`} className={styles.form} onSubmit={event => {
        event.preventDefault()
        if (!size.ok) { setError(size.error); return }
        handleInsert({ rows: size.rows, cols: size.cols })
      }}>
        <div className={styles.fields}>{[["rows", "行数"], ["cols", "列数"]].map(([key, name]) => <label key={key}>{name}
          <input type="number" aria-label={name} min={1} max={TABLE_INSERT_LIMITS[key]} step={1} value={values[key]} required
            disabled={readOnly || !valid} aria-invalid={!size.ok} aria-describedby={!size.ok ? `${id}-size-error` : undefined}
            onChange={event => { setValues({ ...values, [key]: event.target.value }); setError("") }} />
        </label>)}</div>
        <p className={styles.hint}>最多 {TABLE_INSERT_LIMITS.rows} 行、{TABLE_INSERT_LIMITS.cols} 列，共 {TABLE_INSERT_LIMITS.cells} 个单元格。</p>
        {!size.ok && <p id={`${id}-size-error`} className={styles.error} role="alert">{size.error}</p>}
      </form>}
      <label className={styles.checkbox}><input type="checkbox" checked={withHeaderRow} disabled={readOnly || !valid}
        onChange={event => setWithHeaderRow(event.target.checked)} />首行作为表头</label>
      {targetRef.current?.kind === "after-table" && <p className={styles.hint}>新表格将插入在原表格之后。</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.footer}>{custom ? <>
        <button type="button" className={styles.back} onClick={() => { setCustom(false); setError("") }}><IconArrowLeft aria-hidden="true" />返回网格</button>
        <button type="submit" form={`${id}-form`} className={styles.primary} disabled={readOnly || !valid || !size.ok}>确认插入</button>
      </> : <button type="button" className={styles.custom} onClick={() => setCustom(true)}>自定义行列</button>}</div>
    </div>}>
    <button ref={triggerRef} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      title={supported ? "选择行列数插入表格" : "请将光标放入正文或单个单元格"} disabled={!active || readOnly || !supported}
      onMouseDown={event => event.preventDefault()} onKeyDown={open ? handleKey : undefined}>
      <IconTable aria-hidden="true" /><span className={styles.triggerLabel}>{label}<IconChevronDown className={styles.chevron} aria-hidden="true" /></span>
    </button>
  </Popover>
}
