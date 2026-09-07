import { useEditorState } from "@tiptap/react"
import { Modal } from "antd"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/toolbar.module.scss"

export function TableControls() {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    merge: current.can().mergeCells(), split: current.can().splitCell()
  }) })

  const removeTable = () => Modal.confirm({
    title: "删除整张表格？",
    content: "表格及其中内容将被删除，之后可以通过撤销恢复。",
    okText: "删除表格",
    okButtonProps: { danger: true },
    onOk: () => { if (editor.isEditable) editor.chain().focus().deleteTable().run() }
  })

  return (
    <fieldset className={styles.table} disabled={readOnly}>
      <legend>表格操作</legend>
      <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()}>下方插入行</button>
      <button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()}>右侧插入列</button>
      <button type="button" onClick={() => editor.chain().focus().deleteRow().run()}>删除行</button>
      <button type="button" onClick={() => editor.chain().focus().deleteColumn().run()}>删除列</button>
      <button type="button" disabled={!state.merge} onClick={() => editor.chain().focus().mergeCells().run()}>合并单元格</button>
      <button type="button" disabled={!state.split} onClick={() => editor.chain().focus().splitCell().run()}>拆分单元格</button>
      <button type="button" onClick={() => editor.chain().focus().toggleHeaderRow().run()}>切换表头</button>
      <button type="button" className={styles.remove} onClick={removeTable}>删除表格</button>
    </fieldset>
  )
}
