/**
 * 文档顶栏把标题编辑与文件操作放在会话入口处，并明确显示本地存储属性。
 * 标题通过 store 更新，以便与正文共用修订和自动保存流程。
 */
import { Input } from "antd"
import { IconLock } from "@tabler/icons-react"
import { FileActions } from "./FileActions.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/document-bar.module.scss"

export function DocumentBar({ onDocumentChange }) {
  const { store } = useDocumentEditor()
  const title = useEditorStore(state => state.title)
  const readOnly = useEditorStore(state => state.readOnly || state.switching)

  // 标题受只读和切换状态保护；输入长度限制与仓库文档标题约束保持一致。
  return (
    <header className={styles.container}>
      <div className={styles.brand} aria-label="Mewoc">
        <span className={styles.logo} aria-hidden="true" />
        <strong>mewoc<span>.</span></strong>
      </div>
      <div className={styles.document}>
        <Input
          aria-label="文档标题"
          className={styles.title}
          variant="borderless"
          value={title}
          maxLength={100}
          disabled={readOnly}
          onChange={event => store.getState().updateTitle(event.target.value)}
        />
      </div>
      <FileActions onDocumentChange={onDocumentChange} />
      <div className={styles.actions}>
        <span className={styles.local}><IconLock aria-hidden="true" /> 本地文档</span>
      </div>
    </header>
  )
}
