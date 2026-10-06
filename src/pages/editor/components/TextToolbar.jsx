/**
 * 组合正文历史、文字格式、格式刷、段落设置和样式库，构成“开始”标签。
 * 所有正文命令在执行时再次检查实时状态，隐藏面板和只读/切换会话都不能继续写入。
 */
import { useEditorState } from "@tiptap/react"
import { IconArrowBackUp, IconArrowForwardUp, IconBold, IconItalic, IconUnderline, IconStrikethrough, IconClearFormatting, IconSuperscript, IconSubscript } from "@tabler/icons-react"
import { TextStyleControls } from "./TextStyleControls.jsx"
import { ParagraphControls } from "./ParagraphControls.jsx"
import { ParagraphStylePicker } from "./ParagraphStylePicker.jsx"
import { FormatPainterControls } from "./FormatPainterControls.jsx"
import { LinkAction } from "./LinkAction.jsx"
import { ToolbarButton } from "./ToolbarButton.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { clearTextFormatting } from "../tools/comment-clipboard.js"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import { supportsTextScriptSelection } from "../extensions/text-scripts.js"
import styles from "../sass/ribbon-controls.module.scss"

export function TextToolbar({ active = true, layoutKey = "" }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  // 格式刷可能留下显式字重，加粗回显优先解释它；撤销可用性直接向正文历史查询。
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    bold: current.getAttributes("textStyle").fontWeight ? Number(current.getAttributes("textStyle").fontWeight) >= 600 : current.isActive("bold"), italic: current.isActive("italic"),
    underline: current.isActive("underline"), strike: current.isActive("strike"),
    superscript: current.isActive("superscript"), subscript: current.isActive("subscript"),
    // 只订阅格式适用范围，实时只读条件在下方单独组合，恢复编辑不依赖额外选区事务。
    canSuperscript: supportsTextScriptSelection(current, "superscript"), canSubscript: supportsTextScriptSelection(current, "subscript"),
    undo: current.can().undo(), redo: current.can().redo()
  }) })

  // 统一执行格式与历史命令，恢复正文焦点后作用于保留下来的选区。
  const handleCommand = command => {
    const current = store.getState()
    if (!active || !canEditRibbon(editor, current.readOnly || current.switching)) return
    editor.chain().focus()[command]().run()
  }
  // 清除文字样式使用专用命令，保留批注等结构信息；完成后回到正文继续输入。
  const handleClearFormatting = () => {
    const current = store.getState()
    if (!active || !canEditRibbon(editor, current.readOnly || current.switching)) return
    clearTextFormatting(editor)
    editor.commands.focus()
  }

  // 历史与基础文字按钮直接执行命令，复杂颜色、段落和样式交互交给各自组件管理书签和草稿。
  return <>
    <div className={`${styles.group} ${styles.history}`} data-ribbon-group="history">
      <div className={styles.row} data-ribbon-row="primary">
        <ToolbarButton label="撤销" disabled={readOnly || !state.undo} onClick={() => handleCommand("undo")}><IconArrowBackUp aria-hidden="true" /></ToolbarButton>
        <ToolbarButton label="重做" disabled={readOnly || !state.redo} onClick={() => handleCommand("redo")}><IconArrowForwardUp aria-hidden="true" /></ToolbarButton>
      </div>
      <div className={styles.row} data-ribbon-row="secondary">
        <FormatPainterControls active={active} resetKey={layoutKey} />
        <ToolbarButton label="清除文字格式" disabled={readOnly} onClick={handleClearFormatting}><IconClearFormatting aria-hidden="true" /></ToolbarButton>
      </div>
    </div>
    <TextStyleControls active={active} resetKey={layoutKey}>
      <ToolbarButton label="加粗" active={state.bold} disabled={readOnly} onClick={() => handleCommand("toggleTextBold")}><IconBold aria-hidden="true" /></ToolbarButton>
      <ToolbarButton label="斜体" active={state.italic} disabled={readOnly} onClick={() => handleCommand("toggleItalic")}><IconItalic aria-hidden="true" /></ToolbarButton>
      <ToolbarButton label="下划线" active={state.underline} disabled={readOnly} onClick={() => handleCommand("toggleUnderline")}><IconUnderline aria-hidden="true" /></ToolbarButton>
      <ToolbarButton label="删除线" active={state.strike} disabled={readOnly} onClick={() => handleCommand("toggleStrike")}><IconStrikethrough aria-hidden="true" /></ToolbarButton>
      <ToolbarButton label="下标" active={state.subscript} disabled={readOnly || !state.canSubscript} onClick={() => handleCommand("toggleSubscript")}><IconSubscript aria-hidden="true" /></ToolbarButton>
      <ToolbarButton label="上标" active={state.superscript} disabled={readOnly || !state.canSuperscript} onClick={() => handleCommand("toggleSuperscript")}><IconSuperscript aria-hidden="true" /></ToolbarButton>
      <LinkAction />
    </TextStyleControls>
    <ParagraphControls active={active} resetKey={layoutKey} />
    <ParagraphStylePicker active={active} layoutKey={layoutKey} />
  </>
}
