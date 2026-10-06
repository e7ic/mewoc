/**
 * 当前附件节点的删除入口，统一调用附件命令并支持正文撤销。
 * 附件下载由正文节点视图提供，这里只管理所选节点，不直接删仓库 Blob。
 */
import { Button } from "antd"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { removeAttachment } from "../tools/attachment-commands.js"
import styles from "../sass/toolbar.module.scss"

export function AttachmentSettings() {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)

  // 命令层负责校验节点选区和撤销边界，界面只在删除成功后将焦点还给正文。
  const handleRemove = () => {
    if (removeAttachment(editor)) editor.commands.focus()
  }

  // 按下按钮保留 NodeSelection，避免删除命令失去目标；只读或切换时关闭写操作。
  return (
    <div className={styles.view}>
      <Button disabled={readOnly} onMouseDown={event => event.preventDefault()} onClick={handleRemove}>删除附件</Button>
      <span>点击正文中的「下载」获取原文件；删除可撤销</span>
    </div>
  )
}
