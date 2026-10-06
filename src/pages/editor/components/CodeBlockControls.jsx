/**
 * 代码块语言和退出操作的上下文工具，语言选项按当前节点属性回显。
 * 下拉打开后使用映射选区书签提交，正文变化使目标失效时显示错误而不修改其他代码块。
 */
import { IconChevronDown } from "@tabler/icons-react"
import { useEffect, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Select } from "antd"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { useSelectionBookmark } from "../hooks/use-selection-bookmark.js"
import { CODE_LANGUAGES, getCodeLanguage } from "../constants/code-languages.js"
import { CodeHighlightKey } from "../extensions/code-highlight.js"
import { getCodeBlockTarget, setCodeBlockLanguage, exitCodeBlock } from "../tools/code-block-commands.js"
import styles from "../sass/code-block.module.scss"

export function CodeBlockControls({ active = true, layoutKey = "" }) {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  // 下拉开关和操作错误属于临时 UI 状态；书签在菜单抢占焦点后仍指向原代码块。
  const [open, setOpen] = useState(false)
  const [error, setError] = useState("")
  const { captureSelection, getSelection, clearSelection } = useSelectionBookmark(editor, open)
  // 按当前目标位置读取高亮插件诊断，让未支持语言或渲染问题显示在对应代码块工具旁。
  const selection = useEditorState({ editor, selector: ({ editor: current }) => {
    const target = getCodeBlockTarget(current.state.selection)
    return { language: target?.node.attrs.language, message: target ? CodeHighlightKey.getState(current.state)?.messages[target.pos] : "" }
  } })
  const language = getCodeLanguage(selection.language)
  // 未支持语言显示独立禁选项，避免控件回显时顺手把文档里的原语言覆盖成 plaintext。
  const unsupported = selection.language && language === "plaintext" && !["plaintext", "text", "txt"].includes(selection.language.toLowerCase())
  const options = unsupported ? [{ value: selection.language, label: "未支持（纯文本显示）", disabled: true }, ...CODE_LANGUAGES] : CODE_LANGUAGES

  // 下拉菜单取得焦点前捕获代码块选区，选择语言时使用随正文事务映射后的书签。
  const handleOpen = value => {
    if (value) captureSelection()
    setOpen(value)
  }
  // 命令成功才释放书签并回到正文；失败保留错误和目标信息，让用户重新选择后处理。
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
  // 退出命令负责在代码块外创建/定位正文段落，成功后才转移焦点。
  const handleExit = () => {
    if (exitCodeBlock(editor)) editor.commands.focus()
  }

  // 面板失活或进入只读时收起语言菜单并释放目标，避免不可见控件保留可写书签。
  useEffect(() => {
    if (readOnly || !active) {
      setOpen(false)
      clearSelection()
    }
  }, [readOnly, active, clearSelection])
  // 布局切换同样终止旧菜单交互，防止菜单锚点随工具栏重排后错位。
  useEffect(() => { setOpen(false); clearSelection() }, [layoutKey, clearSelection])

  // 语言选择与退出操作共享只读限制；诊断提示优先显示操作错误，再显示高亮或兼容说明。
  return <div className={styles.container}>
    <Select suffixIcon={<IconChevronDown aria-hidden="true" />} className={styles.language} aria-label="代码语言" value={unsupported ? selection.language : language} options={options} disabled={readOnly}
      open={open && active && !readOnly} onOpenChange={handleOpen} onChange={handleLanguage} />
    <Button disabled={readOnly} onMouseDown={event => event.preventDefault()} onClick={handleExit}>退出代码块</Button>
    <p>Tab 缩进 · Shift+Tab 减少缩进 · ⌘ / Ctrl+Enter 继续正文</p>
    {(error || selection.message || unsupported) && <p className={styles.notice} role="status">
      {error || selection.message || "此语言暂未支持高亮，已保留原语言和源码"}
    </p>}
  </div>
}
