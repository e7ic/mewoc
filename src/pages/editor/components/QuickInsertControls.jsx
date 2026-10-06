/**
 * 在原正文位置插入日期时间、特殊字符或表情，三个浮层共享一次目标跟踪流程。
 * 日期值在打开时按本机时间生成，插入为普通文本；正文后续变化不会自动更新时间。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Popover } from "antd"
import { IconCalendarTime, IconOmega, IconMoodSmile } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import { captureQuickInsertTarget, getQuickDateOptions, getQuickInsertSelection, insertQuickText, mapQuickInsertTarget, QUICK_CHARACTER_GROUPS, QUICK_EMOJI_GROUPS, supportsQuickInsertSelection } from "../tools/quick-insert.js"
import { createId } from "../tools/create-id.js"
import styles from "../sass/quick-insert.module.scss"

// 入口配置同时驱动按钮、图标和浮层标题；不同内容复用捕获目标与键盘访问逻辑。
const controls = [["date", "日期时间", IconCalendarTime], ["character", "特殊字符", IconOmega], ["emoji", "表情", IconMoodSmile]]

export function QuickInsertControls({ active = true, layoutKey = "", compact = false }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const supported = useEditorState({ editor, selector: ({ editor: current }) => supportsQuickInsertSelection(current) })
  // 同一时刻只开启一种插入面板，valid/error 反馈原目标是否仍可用；稳定 ID 关联入口与内容。
  const [openControl, setOpenControl] = useState("")
  const [dates, setDates] = useState([])
  const [error, setError] = useState("")
  const [valid, setValid] = useState(true)
  const [id] = useState(() => `mewoc-quick-insert-${createId()}`)
  // 目标与订阅跨 UI 渲染保留；入口和面板 ref 支持 Escape 返回按钮、打开后聚焦首个可用选项。
  const targetRef = useRef(null)
  const stopTrackingRef = useRef(null)
  const triggerRefs = useRef({})
  const panelRefs = useRef({})

  // 统一停止事务跟踪、释放目标并清除错误；关闭并不修改正文。
  const handleClose = useCallback(() => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    targetRef.current = null
    setOpenControl("")
    setError("")
    setValid(true)
  }, [])
  const getBlocked = () => {
    const current = store.getState()
    return !active || !canEditRibbon(editor, current.readOnly || current.switching)
  }
  // 先验证编辑状态并捕获插入范围，再替换旧交互；按完整事务链映射，丢失目标时禁用选项。
  const handleOpenChange = (control, open) => {
    if (!open) { handleClose(); return }
    if (getBlocked()) return
    const target = captureQuickInsertTarget(editor)
    if (!target) return
    handleClose()
    targetRef.current = target
    // 插件追加事务也会移动正文，必须按完整事务链映射原选区，不能取当前工具栏焦点。
    const handleTransaction = ({ transaction, appendedTransactions = [] }) => {
      if (targetRef.current !== target) return
      for (const current of [transaction, ...appendedTransactions]) mapQuickInsertTarget(target, current)
      const available = !!getQuickInsertSelection(editor, target)
      setValid(available)
      if (!available) setError("原文字选区已被删除或替换，请关闭后重新选择。")
    }
    editor.on("transaction", handleTransaction)
    stopTrackingRef.current = () => editor.off("transaction", handleTransaction)
    setDates(getQuickDateOptions())
    setOpenControl(control)
  }
  // 插入命令核对原范围并建立可撤销事务；成功才关闭，错误留在面板中说明目标变化。
  const handleInsert = value => {
    if (getBlocked()) return
    const result = insertQuickText(editor, targetRef.current, value, getBlocked())
    if (!result.ok) { setError(result.error); return }
    handleClose()
    editor.commands.focus()
  }
  // 组合输入时不处理导航，Escape 返回原入口；字符/表情网格支持横纵方向与首尾跳转。
  const handleKeyDown = event => {
    if (event.isComposing || editor.view.composing) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      const trigger = triggerRefs.current[openControl]
      handleClose()
      trigger?.focus()
      return
    }
    const grid = event.target.closest("[data-quick-insert-grid]")
    if (!grid || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    // 分类各有一行八格，上下键应跨分类保留列位置，不能只在当前一行内钳到两端。
    const buttons = [...panelRefs.current[openControl].querySelectorAll("[data-quick-insert-grid] button:not(:disabled)")]
    const index = buttons.indexOf(event.target.closest("button"))
    if (index < 0) return
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 })[event.key]
    event.preventDefault()
    buttons[next >= 0 && next < buttons.length ? next : index]?.focus()
  }
  // 标签失活、只读或布局变化关闭浮层；会话卸载解除监听，旧目标不参与后续文档。
  useEffect(() => { if (!active || readOnly) handleClose() }, [active, readOnly, handleClose])
  useEffect(() => { handleClose() }, [layoutKey, compact, handleClose])
  useEffect(() => () => { stopTrackingRef.current?.() }, [editor])

  // 分类网格只渲染可插入文本，按钮标签描述实际字符/表情，面板无效或只读时整组禁用。
  const symbols = (groups, emoji) => groups.map(group => <fieldset className={styles.category} key={group.label} disabled={readOnly || !valid}>
    <legend>{group.label}</legend>
    <div className={`${styles.grid} ${emoji ? styles.emoji : ""}`} data-quick-insert-grid>
      {group.items.map(([value, label]) => <button key={value} type="button" aria-label={`插入${emoji ? "表情" : "字符"}：${label}`} title={`${label} ${value}`}
        onMouseDown={event => event.preventDefault()} onClick={() => handleInsert(value)}><span aria-hidden="true">{value}</span></button>)}
    </div>
  </fieldset>)
  // 日期面板展示打开时生成的值，字符和表情按各自分组渲染；所有内容共享同一目标错误提示。
  const content = control => <div ref={element => { panelRefs.current[control] = element }} id={`${id}-${control}`} className={styles.panel}
    role="dialog" aria-modal="false" aria-label={`插入${controls.find(([key]) => key === control)[1]}`} onKeyDown={handleKeyDown}>
    {control === "date" ? <>
      <p className={styles.hint}>按本机时间插入普通文本，之后不会自动更新。</p>
      <div className={styles.dates}>{dates.map(({ id, label, value }) => <button type="button" key={id} aria-label={`插入${label}`} disabled={readOnly || !valid}
        onMouseDown={event => event.preventDefault()} onClick={() => handleInsert(value)}><span>{label}</span><strong>{value}</strong></button>)}</div>
    </> : symbols(control === "emoji" ? QUICK_EMOJI_GROUPS : QUICK_CHARACTER_GROUPS, control === "emoji")}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>

  // 面板打开完成后聚焦首个可用按钮；入口按下保留正文选区，禁用不受支持的正文节点选区。
  return <>{controls.map(([control, label, Icon]) => <Popover key={control} title={`插入${label}`} trigger="click" placement="bottomLeft" destroyOnHidden
    open={openControl === control} onOpenChange={open => handleOpenChange(control, open)} content={content(control)}
    afterOpenChange={open => { if (open && openControl === control) panelRefs.current[control]?.querySelector("button:not(:disabled)")?.focus() }}>
    <button type="button" ref={element => { triggerRefs.current[control] = element }} className={styles.trigger} data-quick-insert={control} data-quick-insert-compact={compact}
      aria-label={label} title={label} aria-haspopup="dialog" aria-controls={openControl === control ? `${id}-${control}` : undefined}
      aria-expanded={openControl === control} disabled={!active || readOnly || !supported}
      onMouseDown={event => event.preventDefault()} onKeyDown={openControl === control ? handleKeyDown : undefined}><Icon aria-hidden="true" /><span>{label}</span></button>
  </Popover>)}</>
}
