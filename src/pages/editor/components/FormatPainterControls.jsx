import { Button, Tooltip } from "antd"
import { FormatPainterOutlined, LockOutlined, CloseOutlined } from "@ant-design/icons"
import { useEditorState } from "@tiptap/react"
import { FORMAT_PAINTER_KEY } from "../extensions/format-painter.js"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/toolbar.module.scss"

export function FormatPainterControls() {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const { source, canCopy, canApply } = useEditorState({ editor, selector: ({ editor: current }) => ({
    source: FORMAT_PAINTER_KEY.getState(current.state),
    canCopy: current.can().copyFormat(), canApply: current.can().applyFormat()
  }) })

  const handleCopy = locked => {
    if (source && source.locked === locked) editor.chain().focus().clearFormat().run()
    else editor.chain().focus().copyFormat(locked).run()
  }

  return (
    <div className={styles.group}>
      <div className={styles.row}>
        <Tooltip title="复制选区首个文字及其段落样式，再选择目标文字">
          <Button
            size="small" icon={<FormatPainterOutlined />} aria-label="格式刷" aria-pressed={!!source && !source.locked}
            type={source && !source.locked ? "primary" : "default"} disabled={readOnly || (!source && !canCopy)}
            onMouseDown={event => event.preventDefault()} onClick={() => handleCopy(false)}
          >格式刷</Button>
        </Tooltip>
        <Tooltip title="连续应用格式；按 Esc 退出">
          <Button
            size="small" icon={<LockOutlined />} aria-label="连续格式刷" aria-pressed={!!source?.locked}
            type={source?.locked ? "primary" : "default"} disabled={readOnly || (!source && !canCopy)}
            onMouseDown={event => event.preventDefault()} onClick={() => handleCopy(true)}
          />
        </Tooltip>
      </div>
      {source ? <div className={styles.row}>
        <Button size="small" disabled={readOnly || !canApply} onMouseDown={event => event.preventDefault()}
          onClick={() => editor.chain().focus().applyFormat().run()}>应用格式</Button>
        <Button size="small" icon={<CloseOutlined />} aria-label="取消格式刷" onMouseDown={event => event.preventDefault()}
          onClick={() => editor.chain().focus().clearFormat().run()} />
      </div> : <span className={styles.caption}>文字与段落样式</span>}
    </div>
  )
}
