/**
 * 提供普通文本查找、结果导航与可撤销替换，匹配计算由编辑器查找插件维护。
 * 只读模式保留查找和导航能力，正文替换入口则禁用。
 */
import { useEffect, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Checkbox, Input } from "antd"
import { IconArrowDown, IconArrowUp, IconX } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/panels.module.scss"

// 本地 state 只控制输入框，匹配集合和当前索引由 FindAndReplace 维护，正文变化后由插件更新。
export function SearchPanel() {
  const [searchTerm, setSearchTerm] = useState("")
  const [replaceTerm, setReplaceTerm] = useState("")
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly)
  // 直接订阅插件匹配数量与当前索引，使正文变化后的结果和导航状态同步显示。
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    count: current.storage.findAndReplace.results.length,
    index: current.storage.findAndReplace.currentIndex
  }) })

  // 同时更新输入框与插件查找词，界面不自行复制匹配集合，避免两套结果不同步。
  const handleSearch = event => {
    setSearchTerm(event.target.value)
    editor.commands.setSearchTerm(event.target.value)
  }
  // 替换词也是插件命令的输入，实际替换由插件根据当前匹配和可编辑状态执行。
  const handleReplacement = event => {
    setReplaceTerm(event.target.value)
    editor.commands.setReplaceTerm(event.target.value)
  }

  // 关闭/卸载清理本次查找状态，防止下次打开空面板却仍高亮旧词；销毁后的编辑器不再调用命令。
  useEffect(() => () => {
    if (editor.isDestroyed) return
    // clearSearch 只清查找词；新面板的空输入不能沿用插件残留的替换词和选项。
    editor.chain().clearSearch().setReplaceTerm("").setCaseSensitive(false).run()
  }, [editor])

  // 匹配数为零时关闭导航/替换按钮，当前索引缺失显示零；替换与全部替换共享只读限制。
  return (
    <aside className={styles.search} aria-label="查找替换">
      <div className={styles.header}>
        <strong>查找与替换</strong>
        <button type="button" aria-label="关闭查找" onClick={() => store.getState().updateView({ searchOpen: false })}><IconX aria-hidden="true" /></button>
      </div>
      <Input aria-label="查找内容" placeholder="查找文档内容" value={searchTerm} autoFocus onChange={handleSearch} />
      <Checkbox onChange={event => editor.commands.setCaseSensitive(event.target.checked)}>区分大小写</Checkbox>
      <div className={styles.navigation}>
        <span role="status">{state.count ? `${state.index === null ? 0 : state.index + 1} / ${state.count} 处匹配` : "没有匹配结果"}</span>
        <Button aria-label="上一处匹配" icon={<IconArrowUp aria-hidden="true" />} disabled={!state.count} onClick={() => editor.commands.goToPreviousResult()} />
        <Button aria-label="下一处匹配" icon={<IconArrowDown aria-hidden="true" />} disabled={!state.count} onClick={() => editor.commands.goToNextResult()} />
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
