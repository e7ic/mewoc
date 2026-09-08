import { useRef } from "react"
import { useEditorState } from "@tiptap/react"
import { PictureOutlined, TableOutlined, MinusOutlined, FileAddOutlined, CodeOutlined } from "@ant-design/icons"
import { message } from "antd"
import { LinkAction } from "./LinkAction.jsx"
import { FormulaAction } from "./FormulaAction.jsx"
import { TableControls } from "./TableControls.jsx"
import { ImageSettings } from "./ImageSettings.jsx"
import { CodeBlockControls } from "./CodeBlockControls.jsx"
import { AttachmentAction } from "./AttachmentAction.jsx"
import { AttachmentSettings } from "./AttachmentSettings.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { getCodeBlockTarget, insertCodeBlock } from "../tools/code-block-commands.js"
import styles from "../sass/toolbar.module.scss"

export function InsertToolbar() {
  const fileInputRef = useRef(null)
  const { editor, insertImages, uploading, imageUploading } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const selection = useEditorState({ editor, selector: ({ editor: current }) => ({
    table: current.isActive("table"), image: current.isActive("image"), code: Boolean(getCodeBlockTarget(current.state.selection)),
    attachment: current.isActive("attachment")
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
          <PictureOutlined /><span>{imageUploading ? "读取图片…" : "图片"}</span>
        </button>
        <AttachmentAction />
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
      {selection.attachment && <AttachmentSettings />}
      {!selection.table && !selection.image && !selection.code && !selection.attachment && <p className={styles.description}>图片或附件单个不超过 5 MiB，合计不超过 20 MiB。<br />图片支持粘贴与拖入；附件通过「附件」选择。</p>}
    </>
  )
}
