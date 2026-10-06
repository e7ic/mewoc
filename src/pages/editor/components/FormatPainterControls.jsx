/**
 * 格式刷控制入口：复制当前选区格式、应用一次或连续应用，并提供显式取消。
 * 格式来源与连续模式存放在编辑器插件，UI 只读取可用性和管理选项弹层。
 */
import { useEffect, useState } from "react"
import { Button, Popover } from "antd"
import { IconPaint, IconLock, IconX, IconCheck, IconChevronDown } from "@tabler/icons-react"
import { useEditorState } from "@tiptap/react"
import { ToolbarButton } from "./ToolbarButton.jsx"
import { FORMAT_PAINTER_KEY } from "../extensions/format-painter.js"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/ribbon-controls.module.scss"

export function FormatPainterControls({ active = true, resetKey = "" }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const [open, setOpen] = useState(false)
  // 来源和连续模式属于格式刷插件，控件只读取状态，Esc 和正文变化取消时同步回显。
  const { source, canCopy, canApply } = useEditorState({ editor, selector: ({ editor: current }) => ({
    source: FORMAT_PAINTER_KEY.getState(current.state),
    canCopy: current.can().copyFormat(), canApply: current.can().applyFormat()
  }) })
  // 每次命令读取实时会话状态，失活工具栏、只读、切换或组合输入期间都不能复制/应用格式。
  const getBlocked = () => {
    const current = store.getState()
    return !active || !canEditRibbon(editor, current.readOnly || current.switching)
  }
  // 再次选择同一种刷模式表示退出；切换一次/连续模式则重新复制当前正文格式。
  const handleCopy = locked => {
    if (getBlocked()) return
    if (source && source.locked === locked) editor.chain().focus().clearFormat().run()
    else editor.chain().focus().copyFormat(locked).run()
    setOpen(false)
  }
  // 插件决定能否应用到当前目标及应用后的模式生命周期；界面只关闭弹层并恢复正文焦点。
  const handleApply = () => {
    if (getBlocked()) return
    editor.chain().focus().applyFormat().run()
    setOpen(false)
  }
  // 清除插件保存的格式来源，统一取消一次或连续模式，防止后续编辑误套旧格式。
  const handleCancel = () => {
    if (getBlocked()) return
    editor.chain().focus().clearFormat().run()
    setOpen(false)
  }
  const handleOpenChange = value => setOpen(value && !getBlocked())
  // 标签失活或进入只读时关闭 portal，工具栏换布局也收起；插件来源仍由会话策略管理。
  useEffect(() => { if (!active || readOnly) setOpen(false) }, [active, readOnly])
  useEffect(() => { setOpen(false) }, [resetKey])

  // 主按钮用于一次格式刷，拆分菜单提供连续模式、应用与取消，并按插件能力分别禁用。
  return <div className={styles.split}>
    <ToolbarButton label="格式刷" active={!!source && !source.locked} disabled={readOnly || (!source && !canCopy)}
      onClick={() => handleCopy(false)}><IconPaint aria-hidden="true" /></ToolbarButton>
    <Popover title="格式刷" trigger="click" placement="bottomLeft" open={open} onOpenChange={handleOpenChange}
      content={<div className={styles.menu}>
        <Button type="text" size="small" icon={<IconLock aria-hidden="true" />} aria-label="连续格式刷" aria-pressed={!!source?.locked}
          disabled={readOnly || (!source && !canCopy)} onMouseDown={event => event.preventDefault()} onClick={() => handleCopy(true)}>连续格式刷</Button>
        <Button type="text" size="small" icon={<IconCheck aria-hidden="true" />} aria-label="应用格式" disabled={readOnly || !source || !canApply}
          onMouseDown={event => event.preventDefault()} onClick={handleApply}>应用格式</Button>
        <Button type="text" size="small" icon={<IconX aria-hidden="true" />} aria-label="取消格式刷" disabled={readOnly || !source}
          onMouseDown={event => event.preventDefault()} onClick={handleCancel}>取消格式刷</Button>
      </div>}>
      <button type="button" className={styles.arrow} aria-label="格式刷选项" title="格式刷选项" aria-expanded={open}
        disabled={readOnly} onMouseDown={event => event.preventDefault()}><IconChevronDown aria-hidden="true" /></button>
    </Popover>
  </div>
}
