import { Button } from "antd"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { removeAttachment } from "../tools/attachment-commands.js"
import styles from "../sass/toolbar.module.scss"

export function AttachmentSettings() {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)

  const handleRemove = () => {
    if (removeAttachment(editor)) editor.commands.focus()
  }

  return (
    <div className={styles.view}>
      <Button disabled={readOnly} onMouseDown={event => event.preventDefault()} onClick={handleRemove}>删除附件</Button>
      <span>点击正文中的「下载」获取原文件；删除可撤销</span>
    </div>
  )
}
