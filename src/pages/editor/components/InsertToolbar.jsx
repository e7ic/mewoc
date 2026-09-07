import { useRef } from "react"
import { useEditorState } from "@tiptap/react"
import { PictureOutlined, TableOutlined, MinusOutlined, FileAddOutlined } from "@ant-design/icons"
import { LinkAction } from "./LinkAction.jsx"
import { FormulaAction } from "./FormulaAction.jsx"
import { TableControls } from "./TableControls.jsx"
import { ImageSettings } from "./ImageSettings.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/toolbar.module.scss"

export function InsertToolbar() {
  const fileInputRef = useRef(null)
  const { editor, insertImages, uploading } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const selection = useEditorState({ editor, selector: ({ editor: current }) => ({
    table: current.isActive("table"), image: current.isActive("image")
  }) })

  const handleImages = event => {
    const files = [...event.target.files]
    event.target.value = ""
    if (files.length) insertImages(files)
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
      {!selection.table && !selection.image && <p className={styles.description}>图片支持粘贴与拖入，单张不超过 5 MiB。<br />选中图片或表格后，可在这里调整内容。</p>}
    </>
  )
}
