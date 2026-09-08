import { useEditorState } from "@tiptap/react"
import { UndoOutlined, RedoOutlined, BoldOutlined, ItalicOutlined, UnderlineOutlined, StrikethroughOutlined, ClearOutlined } from "@ant-design/icons"
import { TextStyleControls } from "./TextStyleControls.jsx"
import { ParagraphControls } from "./ParagraphControls.jsx"
import { FormatPainterControls } from "./FormatPainterControls.jsx"
import { ParagraphIndentControls } from "./ParagraphIndentControls.jsx"
import { LinkAction } from "./LinkAction.jsx"
import { ToolbarButton } from "./ToolbarButton.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/toolbar.module.scss"

export function TextToolbar() {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  // 格式刷可能留下显式字重，加粗回显优先解释它；撤销可用性直接向正文历史查询。
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    bold: current.getAttributes("textStyle").fontWeight ? Number(current.getAttributes("textStyle").fontWeight) >= 600 : current.isActive("bold"), italic: current.isActive("italic"),
    underline: current.isActive("underline"), strike: current.isActive("strike"),
    undo: current.can().undo(), redo: current.can().redo()
  }) })

  return (
    <>
      <div className={styles.group}>
        <div className={styles.row}>
          <ToolbarButton
            label="撤销"
            disabled={readOnly || !state.undo}
            onClick={() => editor.chain().focus().undo().run()}
          ><UndoOutlined /></ToolbarButton>
          <ToolbarButton
            label="重做"
            disabled={readOnly || !state.redo}
            onClick={() => editor.chain().focus().redo().run()}
          ><RedoOutlined /></ToolbarButton>
        </div>
        <span className={styles.caption}>历史</span>
      </div>
      <div className={styles.group}>
        <TextStyleControls />
        <div className={styles.row}>
          <ToolbarButton
            label="加粗"
            active={state.bold}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleTextBold().run()}
          ><BoldOutlined /></ToolbarButton>
          <ToolbarButton
            label="斜体"
            active={state.italic}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          ><ItalicOutlined /></ToolbarButton>
          <ToolbarButton
            label="下划线"
            active={state.underline}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          ><UnderlineOutlined /></ToolbarButton>
          <ToolbarButton
            label="删除线"
            active={state.strike}
            disabled={readOnly}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          ><StrikethroughOutlined /></ToolbarButton>
          <ToolbarButton
            label="清除文字格式"
            disabled={readOnly}
            onClick={() => editor.chain().focus().unsetAllMarks().run()}
          ><ClearOutlined /></ToolbarButton>
          <LinkAction />
        </div>
      </div>
      <FormatPainterControls />
      <ParagraphControls />
      <ParagraphIndentControls />
      <div className={styles.hint}><span>Aa</span><p>每一个想法<br />都值得认真书写</p></div>
    </>
  )
}
