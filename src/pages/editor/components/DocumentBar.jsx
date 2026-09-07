import { Input } from "antd"
import { FileTextOutlined, CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined, LoadingOutlined, LockOutlined } from "@ant-design/icons"
import clsx from "clsx"
import { FileActions } from "./FileActions.jsx"
import { ExportActions } from "./ExportActions.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/document-bar.module.scss"

const SAVE_LABELS = { dirty: "有待保存的修改", saving: "正在保存…", saved: "已保存到此浏览器", error: "保存失败" }
const SAVE_ICONS = { dirty: ClockCircleOutlined, saving: LoadingOutlined, saved: CheckCircleOutlined, error: CloseCircleOutlined }

export function DocumentBar({ onDocumentChange }) {
  const { store } = useDocumentEditor()
  const title = useEditorStore(state => state.title)
  const saveStatus = useEditorStore(state => state.saveStatus)
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const StatusIcon = SAVE_ICONS[saveStatus]

  return (
    <header className={styles.container}>
      <div className={styles.brand} aria-label="Mewoc">
        <span className={styles.logo}><FileTextOutlined /></span>
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
        <span
          className={clsx(styles.status, saveStatus === "saved" && styles.saved, saveStatus === "error" && styles.error)}
          role="status"
        >
          <StatusIcon />
          {SAVE_LABELS[saveStatus]}
        </span>
      </div>
      <FileActions onDocumentChange={onDocumentChange} />
      <div className={styles.actions}>
        <span className={styles.local}><LockOutlined /> 本地文档</span>
        <ExportActions />
      </div>
    </header>
  )
}
