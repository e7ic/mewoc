/**
 * 快速段落缩进弹层，以打开时捕获的多段落范围为目标，支持首行和左侧缩进。
 * 弹层持续跟踪正文事务并回显混合值，不会因为焦点移动而重定向到后来选中的段落。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Popover, Select } from "antd"
import { IconIndentIncrease, IconChevronDown } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { getIndentParagraphs } from "../extensions/paragraph-indent.js"
import { FIRST_LINE_INDENTS, LEFT_INDENTS } from "../constants/editor-constants.js"
import { mapParagraphTarget, readParagraphSettings } from "../tools/paragraph-settings.js"
import { applyRibbonParagraphIndent, canEditRibbon, captureRibbonIndentTarget } from "../tools/ribbon-commands.js"
import styles from "../sass/ribbon-controls.module.scss"

export function ParagraphIndentControls({ active = true, resetKey = "" }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const supported = useEditorState({ editor, selector: ({ editor: current }) => !!getIndentParagraphs(current.state).length })
  // openField 控制内部两个下拉互斥；values 仅是目标范围回显，targetRef/stopTrackingRef 拥有映射目标与订阅。
  const [open, setOpen] = useState(false)
  const [openField, setOpenField] = useState("")
  const [values, setValues] = useState({ firstLine: 0, left: 0 })
  const [error, setError] = useState("")
  const targetRef = useRef(null)
  const stopTrackingRef = useRef(null)

  // 事件中实时查只读、切换和工具栏活动状态，防止列表开启后会话状态变化仍能写入。
  const getBlocked = () => {
    const current = store.getState()
    return !active || !canEditRibbon(editor, current.readOnly || current.switching)
  }
  // 释放事务监听再清空目标，重复打开或关闭不会积累对旧段落范围的订阅。
  const handleClearTarget = useCallback(() => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    targetRef.current = null
  }, [])
  // 外层关闭统一清理映射目标、内部下拉与错误，保证下一次选择重新从正文捕获。
  const handleClose = useCallback(() => {
    handleClearTarget()
    setOpen(false)
    setOpenField("")
    setError("")
  }, [handleClearTarget])
  // 先确认目标仍有效，再逐属性汇总各段落；不同首行/左缩进独立显示混合态。
  const handleRead = target => {
    if (!readParagraphSettings(editor, target)) return false
    const nodes = target.positions.map(pos => editor.state.doc.nodeAt(pos))
    const firstLines = new Set(nodes.map(node => node.attrs.firstLineIndent ?? 0))
    const lefts = new Set(nodes.map(node => node.attrs.leftIndent ?? 0))
    setValues({
      firstLine: firstLines.size > 1 ? "mixed" : [...firstLines][0],
      left: lefts.size > 1 ? "mixed" : [...lefts][0]
    })
    return true
  }
  // 打开时捕获并读取段落范围，然后订阅完整事务链；失去范围时保留错误并停止有效写操作。
  const handleOpenChange = value => {
    if (!value) { handleClose(); return }
    if (getBlocked()) return
    const target = captureRibbonIndentTarget(editor)
    if (!target || !handleRead(target)) return
    handleClearTarget()
    targetRef.current = target
    // 弹层获得焦点后仍映射原段落，根事务和插件追加事务都必须按顺序跟踪。
    const handleTransaction = ({ transaction, appendedTransactions = [] }) => {
      if (targetRef.current !== target) return
      for (const current of [transaction, ...appendedTransactions]) mapParagraphTarget(target, current)
      if (!handleRead(target)) setError("原段落已被删除或替换，请关闭后重新选择。")
    }
    editor.on("transaction", handleTransaction)
    stopTrackingRef.current = () => editor.off("transaction", handleTransaction)
    setError("")
    setOpen(true)
  }
  // 仅提交当前修改字段，避免首行设置覆盖左缩进或相反；成功重读回显并恢复正文焦点。
  const handleIndent = (field, value) => {
    if (getBlocked()) return
    if (!applyRibbonParagraphIndent(editor, targetRef.current, { [field]: value })) {
      setError("原段落已变化，请关闭后重新选择。")
      return
    }
    handleRead(targetRef.current)
    setOpenField("")
    editor.commands.focus()
  }
  // 目标已经失效时禁止开启内部下拉，避免在无效范围上继续挑选缩进值。
  const handleSelectOpen = (field, value) => setOpenField(value && !getBlocked() && targetRef.current?.valid ? field : "")

  // 面板失活、只读、换布局会终止本轮快捷交互；卸载解除事务监听。
  useEffect(() => {
    if (!active || readOnly) handleClose()
  }, [active, readOnly, handleClose])
  useEffect(() => { handleClose() }, [resetKey, handleClose])
  useEffect(() => () => { stopTrackingRef.current?.() }, [editor])

  // 混合值以禁选占位呈现，用户明确选择才应用；只读或映射目标失效时关闭写入口。
  return <Popover title="段落缩进" trigger="click" placement="bottomLeft" open={open} onOpenChange={handleOpenChange}
    content={<div className={styles.indentPanel}>
      <label className={styles.indentField}>首行缩进
        <Select suffixIcon={<IconChevronDown aria-hidden="true" />} aria-label="首行缩进" size="small" value={values.firstLine} disabled={readOnly || targetRef.current?.valid === false}
          open={openField === "firstLine"} onOpenChange={value => handleSelectOpen("firstLine", value)}
          options={[...(values.firstLine === "mixed" ? [{ value: "mixed", label: "首行：混合", disabled: true }] : []),
            ...FIRST_LINE_INDENTS.map(value => ({ value, label: `首行：${value} 字符` }))]}
          onChange={value => handleIndent("firstLineIndent", value)} />
      </label>
      <label className={styles.indentField}>左侧缩进
        <Select suffixIcon={<IconChevronDown aria-hidden="true" />} aria-label="左侧缩进" size="small" value={values.left} disabled={readOnly || targetRef.current?.valid === false}
          open={openField === "left"} onOpenChange={value => handleSelectOpen("left", value)}
          options={[...(values.left === "mixed" ? [{ value: "mixed", label: "左侧：混合", disabled: true }] : []),
            ...LEFT_INDENTS.map(value => ({ value, label: `左侧：${value} 字符` }))]}
          onChange={value => handleIndent("leftIndent", value)} />
      </label>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>}>
    <Button type="text" size="small" className={styles.color} aria-label="段落缩进" title="段落缩进" aria-expanded={open}
      disabled={readOnly || !supported} onMouseDown={event => event.preventDefault()}><IconIndentIncrease aria-hidden="true" /></Button>
  </Popover>
}
