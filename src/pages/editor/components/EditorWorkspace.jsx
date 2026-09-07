import { Alert } from "antd"
import { DocumentBar } from "./DocumentBar.jsx"
import { EditorToolbar } from "./EditorToolbar.jsx"
import { OutlinePanel } from "./OutlinePanel.jsx"
import { SearchPanel } from "./SearchPanel.jsx"
import { PaperCanvas } from "./PaperCanvas.jsx"
import { StatusBar } from "./StatusBar.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/workspace.module.scss"

export function EditorWorkspace({ onDocumentChange }) {
  const { editor, saveDocument } = useDocumentEditor()
  const saveError = useEditorStore(state => state.saveError)
  const outlineOpen = useEditorStore(state => state.outlineOpen)
  const searchOpen = useEditorStore(state => state.searchOpen)

  if (!editor) return null
  return (
    <section className={styles.container} aria-label="Mewoc 编辑空间">
      <DocumentBar onDocumentChange={onDocumentChange} />
      <EditorToolbar />
      {saveError && <Alert type="error" message={saveError} action={<button type="button" onClick={saveDocument}>重试保存</button>} showIcon />}
      <div className={styles.content}>
        {outlineOpen && <OutlinePanel />}
        <PaperCanvas />
        {searchOpen && <SearchPanel />}
      </div>
      <StatusBar />
    </section>
  )
}
