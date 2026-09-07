import { useRef } from "react"
import { useEditorState } from "@tiptap/react"
import { PictureOutlined, TableOutlined, MinusOutlined, FileAddOutlined, CodeOutlined } from "@ant-design/icons"
import { message } from "antd"
import { LinkAction } from "./LinkAction.jsx"
import { FormulaAction } from "./FormulaAction.jsx"
import { TableControls } from "./TableControls.jsx"
import { ImageSettings } from "./ImageSettings.jsx"
import { CodeBlockControls } from "./CodeBlockControls.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { getCodeBlockTarget, insertCodeBlock } from "../tools/code-block-commands.js"
import styles from "../sass/toolbar.module.scss"

export function InsertToolbar() {
  const fileInputRef = useRef(null)
  const { editor, insertImages, uploading } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const selection = useEditorState({ editor, selector: ({ editor: current }) => ({
    table: current.isActive("table"), image: current.isActive("image"), code: Boolean(getCodeBlockTarget(current.state.selection))
  }) })

  const handleImages = event => {
    const files = [...event.target.files]
    event.target.value = ""
    if (files.length) insertImages(files)
  }
  const handleCode = () => {
    if (insertCodeBlock(editor)) editor.commands.focus()
    else message.info("请在不含公式或图片的单个文字段落中插入代码块")
  }

  return (
    <>
      <div className={styles.insert}>
        <button type="button" disabled={readOnly || uploading} onClick={() => fileInputRef.current.click()}>
          <PictureOutlined /><span>{uploading ? "读取图片…" : "图片"}</span>
        </button>
        <button type="button" disabled={readOnly} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          <TableOutlined /><span>表格 3 × 3</span>
        </button>
        <button type="button" disabled={readOnly} onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          <MinusOutlined /><span>水平线</span>
        </button>
        <button type="button" disabled={readOnly} onClick={() => editor.chain().focus().insertContent({ type: "pageBreak" }).run()}>
          <FileAddOutlined /><span>分页符</span>
        </button>
        <LinkAction />
        <FormulaAction />
        <button type="button" disabled={readOnly || selection.code} title="将当前文字段落转换为代码块"
          onMouseDown={event => event.preventDefault()} onClick={handleCode}>
          <CodeOutlined /><span>代码块</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="选择图片"
          multiple
          hidden
          onChange={handleImages}
        />
      </div>
      {selection.table && <TableControls />}
      {selection.image && <ImageSettings />}
      {selection.code && <CodeBlockControls />}
      {!selection.table && !selection.image && !selection.code && <p className={styles.description}>图片支持粘贴与拖入，单张不超过 5 MiB。<br />选中图片、表格或代码块后，可在这里调整内容。</p>}
    </>
  )
}
