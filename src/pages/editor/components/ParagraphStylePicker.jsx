/**
 * 正文/六级标题样式卡片，支持常驻首行、portal 扩展行与完整键盘导航。
 * 样式应用始终使用进入卡片时捕获的段落目标，浮层定位和焦点状态不改变正文目标范围。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useEditorState } from "@tiptap/react"
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { mapParagraphTarget } from "../tools/paragraph-settings.js"
import { createId } from "../tools/create-id.js"
import { applyParagraphStyle, captureParagraphStyleTarget, getNextParagraphStyleLevel, readParagraphStyle } from "../tools/paragraph-style.js"
import styles from "../sass/paragraph-style-picker.module.scss"

// 0 表示正文，1–6 表示标题级别；常驻首行展示常用级别，其余在扩展浮层中提供。
const PRIMARY_LEVELS = [0, 1, 2, 3]
const EXTRA_LEVELS = [4, 5, 6]

export function ParagraphStylePicker({ active = true, layoutKey }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  // 当前正文级别和正文焦点用于选中回显；捕获目标后改用 targetLevel，避免新光标干扰旧范围显示。
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    level: readParagraphStyle(current), focused: current.view.hasFocus()
  }) })
  // expanded/focused/focusLevel 分别控制浮层、选中视觉和键盘 roving tabIndex；panelId 稳定关联展开入口。
  const [expanded, setExpanded] = useState(false)
  const [focused, setFocused] = useState(false)
  const [focusLevel, setFocusLevel] = useState(0)
  const [targetLevel, setTargetLevel] = useState(null)
  const [panelPosition, setPanelPosition] = useState(null)
  const [error, setError] = useState("")
  const [panelId] = useState(() => `mewoc-paragraph-style-${createId()}`)
  // picker/panel ref 合并常驻与 portal 两个焦点区域；按钮 ref 定位级别，目标和订阅 ref 跟踪正文事务。
  const pickerRef = useRef(null)
  const panelRef = useRef(null)
  const buttonsRef = useRef([])
  const targetRef = useRef(null)
  const stopTrackingRef = useRef(null)
  const keyboardFocusRef = useRef(false)
  const level = targetRef.current ? targetLevel : state.level
  const selectedLevel = state.focused || focused || expanded ? level : null
  const disabled = readOnly || level === null || targetRef.current?.valid === false

  // 实时保护应用和焦点恢复，正文只读、切换、销毁或组合输入时暂停修改。
  const getBlocked = useCallback(() => {
    const record = store.getState()
    return record.readOnly || record.switching || editor.isDestroyed || !editor.isEditable || editor.view.composing
  }, [editor, store])
  const containsPicker = element => element instanceof Node && (pickerRef.current?.contains(element) || panelRef.current?.contains(element))
  // 按入口边界选择向上/向下展开，并限制视口左右与高度，避免 portal 被工具栏裁切或越出屏幕。
  const getPanelPosition = () => {
    const rect = pickerRef.current?.getBoundingClientRect()
    if (!rect) return null
    const width = Math.min(rect.width, window.innerWidth - 16)
    const top = window.innerHeight - rect.bottom >= 54 ? rect.bottom - 4 : Math.max(8, rect.top - 50)
    return { top, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, maxHeight: window.innerHeight - top - 8 }
  }

  // 解除事务监听再释放捕获范围，下一轮键盘或鼠标进入时必须重新读取正文。
  const handleClearTarget = useCallback(() => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    targetRef.current = null
    setTargetLevel(null)
  }, [])
  // 一次交互只捕获一次目标，卡片之间切换复用同一范围；目标失效时保留说明而不套用新选区。
  const handleCapture = () => {
    if (getBlocked()) return null
    if (targetRef.current) return targetRef.current
    const target = captureParagraphStyleTarget(editor)
    if (!target) return null
    targetRef.current = target
    setTargetLevel(readParagraphStyle(editor, target))
    setError("")
    // 第二行展开后正文仍可能变化；原目标跟随完整事务链，不改后来移到的新光标段落。
    const handleTransaction = ({ transaction, appendedTransactions = [] }) => {
      if (targetRef.current !== target) return
      for (const current of [transaction, ...appendedTransactions]) mapParagraphTarget(target, current)
      setTargetLevel(readParagraphStyle(editor, target))
      if (!target.valid) setError("原段落已被删除或替换，请收起后重新选择。")
    }
    editor.on("transaction", handleTransaction)
    stopTrackingRef.current = () => editor.off("transaction", handleTransaction)
    return target
  }
  // 关闭浮层统一清理焦点视觉、键盘标记、错误和目标；需要时才把焦点还给可编辑正文。
  const handleClose = useCallback((focusEditor = false) => {
    setExpanded(false)
    setFocused(false)
    setError("")
    keyboardFocusRef.current = false
    handleClearTarget()
    if (focusEditor && !getBlocked()) editor.commands.focus()
  }, [editor, getBlocked, handleClearTarget])
  // 展开前必须成功捕获正文段落，并读取浮层位置；收起结束本轮样式目标跟踪。
  const handleToggle = () => {
    if (expanded) return handleClose()
    if (!handleCapture()) return
    setPanelPosition(getPanelPosition())
    setExpanded(true)
  }
  // 样式命令验证原范围与级别并创建正文事务；成功结束本轮交互，失败保留可见错误。
  const handleApply = nextLevel => {
    if (getBlocked()) return
    const target = handleCapture()
    if (!target) return
    const result = applyParagraphStyle(editor, target, nextLevel, getBlocked())
    if (!result.ok) {
      // 常驻卡片失败后没有浮层的外部关闭监听，释放旧范围，让下一次操作重新读取正文选区。
      if (!expanded) handleClearTarget()
      setError(result.error)
      return
    }
    handleClose(true)
  }
  const handleMouseDown = event => {
    if (event.button !== 0) return
    // 鼠标操作保留正文的原生选区；键盘进入卡片则用捕获的书签恢复同一范围。
    event.preventDefault()
    handleCapture()
  }
  const handleMoreMouseDown = event => {
    // 展开按钮沿用原生按钮焦点；先捕获正文选区，再让编辑器失焦并移除段落聚焦底色。
    if (event.button === 0) handleCapture()
  }
  // 焦点从正文进入卡片/portal 时捕获范围，内部卡片迁移则保持同一目标，避免重捕获已失焦正文。
  const handleFocus = event => {
    if (!containsPicker(event.relatedTarget)) handleCapture()
    setFocused(true)
    const nextLevel = Number(event.target.dataset.paragraphStyle)
    if (Number.isInteger(nextLevel)) setFocusLevel(nextLevel)
  }
  // 仅焦点真正离开常驻卡片与 portal 整个组合区时收起，不因两区域之间跳转取消交互。
  const handleBlur = event => {
    if (!containsPicker(event.relatedTarget)) handleClose()
  }
  // Escape 退出并恢复正文，Enter/Space 应用卡片或展开；方向导航按级别决定展开行和下一焦点。
  const handleKeyDown = event => {
    if (event.isComposing || editor.view.composing) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      handleClose(true)
      return
    }
    if (getBlocked()) return
    const cardLevel = event.target.dataset.paragraphStyle
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      if (cardLevel !== undefined) handleApply(Number(cardLevel))
      else handleToggle()
      return
    }
    const next = getNextParagraphStyleLevel(cardLevel === undefined ? focusLevel : Number(cardLevel), event.key, expanded)
    if (!next || !handleCapture()) return
    event.preventDefault()
    event.stopPropagation()
    keyboardFocusRef.current = true
    setPanelPosition(getPanelPosition())
    setExpanded(next.expanded)
    setFocusLevel(next.level)
  }

  // 标签失活立即结束样式交互，布局变化也重置浮层，避免隐藏卡片继续保留目标。
  useEffect(() => {
    if (!active) handleClose()
  }, [active, handleClose])
  useEffect(() => {
    handleClose()
  }, [layoutKey, handleClose])
  // 浮层开启后监听尺寸与任意祖先滚动重新定位，外部点击关闭；清理对称解除全局监听。
  useEffect(() => {
    if (!expanded) return
    const handlePosition = () => setPanelPosition(getPanelPosition())
    const handleOutsideMouseDown = event => {
      if (!containsPicker(event.target)) handleClose()
    }
    window.addEventListener("resize", handlePosition)
    window.addEventListener("scroll", handlePosition, true)
    document.addEventListener("mousedown", handleOutsideMouseDown, true)
    return () => {
      window.removeEventListener("resize", handlePosition)
      window.removeEventListener("scroll", handlePosition, true)
      document.removeEventListener("mousedown", handleOutsideMouseDown, true)
    }
  }, [expanded, handleClose])
  // 只在键盘导航标记存在时把焦点移至新卡片，并滚动到可见位置，鼠标展开不自动改变焦点。
  useEffect(() => {
    if (!keyboardFocusRef.current) return
    const button = buttonsRef.current[focusLevel]
    button?.focus()
    button?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [focusLevel, expanded])
  // 卸载解除正文事务跟踪，防止 portal 关闭后仍保存旧编辑器目标。
  useEffect(() => () => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    targetRef.current = null
  }, [editor])

  // 所有级别共享卡片语义与命令入口，用单一 focusLevel 控制当前可 Tab 进入的卡片。
  const renderCard = cardLevel => <StyleCard key={cardLevel} level={cardLevel} selected={selectedLevel === cardLevel}
    disabled={disabled} tabIndex={focusLevel === cardLevel ? 0 : -1} buttonRef={element => { buttonsRef.current[cardLevel] = element }}
    onMouseDown={handleMouseDown} onClick={() => handleApply(cardLevel)} />

  // 扩展行 portal 到 body 避免工具栏溢出容器裁切；两区域共享焦点、键盘与选中状态。
  return <div ref={pickerRef} className={styles.picker} role="group" aria-label="段落样式" data-paragraph-style-picker
    onFocusCapture={handleFocus} onBlurCapture={handleBlur} onKeyDown={handleKeyDown}>
    <div className={styles.primary}>
      {PRIMARY_LEVELS.map(renderCard)}
      <button type="button" className={styles.expand} aria-label="更多段落样式" aria-expanded={expanded}
        aria-controls={panelId} disabled={readOnly || (!expanded && level === null)}
        onMouseDown={handleMoreMouseDown} onClick={handleToggle}>{expanded ? <IconChevronUp aria-hidden="true" /> : <IconChevronDown aria-hidden="true" />}</button>
    </div>
    {expanded && panelPosition && createPortal(<div ref={panelRef} id={panelId}
      className={styles.panel} style={panelPosition} data-paragraph-style-expanded role="group" aria-label="更多段落样式卡片"
      onFocusCapture={handleFocus} onBlurCapture={handleBlur} onKeyDown={handleKeyDown}>
      <div className={styles.extra}>{EXTRA_LEVELS.map(renderCard)}</div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>, document.body)}
    {error && !expanded && <p className={styles.error} role="alert">{error}</p>}
  </div>
}

// 卡片用预览字形帮助识别样式，实际字号和段落转换由命令处理；aria-pressed 表达当前选中样式。
const StyleCard = ({ level, selected, disabled, tabIndex, buttonRef, onMouseDown, onClick }) => <button type="button"
  ref={buttonRef} className={`${styles.card} ${selected ? styles.selected : ""}`} data-paragraph-style={level}
  aria-label={level ? `标题 ${level}` : "正文"} aria-pressed={selected} tabIndex={tabIndex} disabled={disabled}
  onMouseDown={onMouseDown} onClick={onClick}>
  <span className={styles.preview} style={{ fontSize: [12, 16, 14, 13, 12, 11, 10][level], fontWeight: level ? 600 : 400 }}>{level ? `标题 ${level}` : "正文"}</span>
  <span className={styles.subtitle}>{level ? `H${level}` : "Text"}</span>
</button>
