import { useEffect, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Checkbox, Input } from "antd"
import { ArrowDownOutlined, ArrowUpOutlined, CloseOutlined } from "@ant-design/icons"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/panels.module.scss"

// 本地 state 只控制输入框，匹配集合和当前索引由 FindAndReplace 维护，正文变化后由插件更新。
export function SearchPanel() {
  const [searchTerm, setSearchTerm] = useState("")
  const [replaceTerm, setReplaceTerm] = useState("")
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly)
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    count: current.storage.findAndReplace.results.length,
    index: current.storage.findAndReplace.currentIndex
  }) })

  const handleSearch = event => {
    setSearchTerm(event.target.value)
    editor.commands.setSearchTerm(event.target.value)
  }
  const handleReplacement = event => {
    setReplaceTerm(event.target.value)
    editor.commands.setReplaceTerm(event.target.value)
  }

  useEffect(() => () => {
    if (editor.isDestroyed) return
    // clearSearch 只清查找词；新面板的空输入不能沿用插件残留的替换词和选项。
    editor.chain().clearSearch().setReplaceTerm("").setCaseSensitive(false).run()
  }, [editor])

  return (
    <aside className={styles.search} aria-label="查找替换">
      <div className={styles.header}>
        <strong>查找与替换</strong>
        <button type="button" aria-label="关闭查找" onClick={() => store.getState().updateView({ searchOpen: false })}><CloseOutlined /></button>
      </div>
      <Input aria-label="查找内容" placeholder="查找文档内容" value={searchTerm} autoFocus onChange={handleSearch} />
      <Checkbox onChange={event => editor.commands.setCaseSensitive(event.target.checked)}>区分大小写</Checkbox>
      <div className={styles.navigation}>
        <span role="status">{state.count ? `${state.index === null ? 0 : state.index + 1} / ${state.count} 处匹配` : "没有匹配结果"}</span>
        <Button aria-label="上一处匹配" icon={<ArrowUpOutlined />} disabled={!state.count} onClick={() => editor.commands.goToPreviousResult()} />
        <Button aria-label="下一处匹配" icon={<ArrowDownOutlined />} disabled={!state.count} onClick={() => editor.commands.goToNextResult()} />
      </div>
      <Input aria-label="替换内容" placeholder="替换为" value={replaceTerm} disabled={readOnly} onChange={handleReplacement} />
      <div className={styles.navigation}>
        <Button disabled={readOnly || !state.count} onClick={() => editor.commands.replace()}>替换</Button>
        <Button disabled={readOnly || !state.count} onClick={() => editor.commands.replaceAll()}>全部替换</Button>
      </div>
      <p className={styles.caption}>按段落查找普通文本。替换操作可以撤销。</p>
    </aside>
  )
}
