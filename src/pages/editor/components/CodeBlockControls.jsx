import { useEffect, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Select } from "antd"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { useSelectionBookmark } from "../hooks/use-selection-bookmark.js"
import { CODE_LANGUAGES, getCodeLanguage } from "../constants/code-languages.js"
import { CodeHighlightKey } from "../extensions/code-highlight.js"
import { getCodeBlockTarget, setCodeBlockLanguage, exitCodeBlock } from "../tools/code-block-commands.js"
import styles from "../sass/code-block.module.scss"

export function CodeBlockControls() {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState("")
  const { captureSelection, getSelection, clearSelection } = useSelectionBookmark(editor, open)
  const selection = useEditorState({ editor, selector: ({ editor: current }) => {
    const target = getCodeBlockTarget(current.state.selection)
    return { language: target?.node.attrs.language, message: target ? CodeHighlightKey.getState(current.state)?.messages[target.pos] : "" }
  } })
  const language = getCodeLanguage(selection.language)
  const unsupported = selection.language && language === "plaintext" && !["plaintext", "text", "txt"].includes(selection.language.toLowerCase())
  const options = unsupported ? [{ value: selection.language, label: "未支持（纯文本显示）", disabled: true }, ...CODE_LANGUAGES] : CODE_LANGUAGES

  const handleOpen = value => {
    if (value) captureSelection()
    setOpen(value)
  }
  const handleLanguage = value => {
    if (setCodeBlockLanguage(editor, value, getSelection())) {
      setError("")
      clearSelection()
      setOpen(false)
      editor.commands.focus()
    } else {
      setError("原代码块已变化或当前不可编辑，请重新选择")
    }
  }
  const handleExit = () => {
    if (exitCodeBlock(editor)) editor.commands.focus()
  }

  useEffect(() => {
    if (readOnly) {
      setOpen(false)
      clearSelection()
    }
  }, [readOnly, clearSelection])

  return <div className={styles.container}>
    <Select className={styles.language} aria-label="代码语言" value={unsupported ? selection.language : language} options={options} disabled={readOnly}
      open={open && !readOnly} onOpenChange={handleOpen} onChange={handleLanguage} />
    <Button disabled={readOnly} onMouseDown={event => event.preventDefault()} onClick={handleExit}>退出代码块</Button>
    <p>Tab 缩进 · Shift+Tab 减少缩进 · ⌘ / Ctrl+Enter 继续正文</p>
    {(error || selection.message || unsupported) && <p className={styles.notice} role="status">
      {error || selection.message || "此语言暂未支持高亮，已保留原语言和源码"}
    </p>}
  </div>
}
