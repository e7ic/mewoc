/**
 * 组织文档栏、工具栏、正文纸张和辅助侧栏，是编辑会话的主要可视工作区。
 * 保存失败保留正文并提供重试入口，侧栏显隐只更新视图状态。
 */
import { IconCircleX } from "@tabler/icons-react"
import { Alert } from "antd"
import { DocumentBar } from "./DocumentBar.jsx"
import { EditorToolbar } from "./EditorToolbar.jsx"
import { OutlinePanel } from "./OutlinePanel.jsx"
import { SearchPanel } from "./SearchPanel.jsx"
import { CommentPanel } from "./CommentPanel.jsx"
import { PaperCanvas } from "./PaperCanvas.jsx"
import { StatusBar } from "./StatusBar.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/workspace.module.scss"

export function EditorWorkspace({ onDocumentChange }) {
  const { editor, saveDocument } = useDocumentEditor()
  // 分别订阅保存错误与侧栏开关；编辑器准备完成后再让依赖命令和选区的工具组件工作。
  const saveError = useEditorStore(state => state.saveError)
  const outlineOpen = useEditorStore(state => state.outlineOpen)
  const searchOpen = useEditorStore(state => state.searchOpen)
  const commentsOpen = useEditorStore(state => state.commentsOpen)

  // useEditor 尚未就绪时不挂载工具栏，下面的组件依赖可用的选区和命令接口。
  if (!editor) return null
  // 大纲可与右侧面板并列；查找优先于批注显示，避免两个面板同时争用正文右侧空间。
  return (
    <section className={styles.container} aria-label="Mewoc 编辑空间">
      <DocumentBar onDocumentChange={onDocumentChange} />
      <EditorToolbar />
      {saveError && <Alert type="error" icon={<IconCircleX aria-hidden="true" />} message={saveError} action={<button type="button" onClick={saveDocument}>重试保存</button>} showIcon />}
      <div className={styles.content}>
        {outlineOpen && <OutlinePanel />}
        <PaperCanvas />
        {searchOpen && <SearchPanel />}
        {commentsOpen && !searchOpen && <CommentPanel />}
      </div>
      <StatusBar />
    </section>
  )
}
