import clsx from "clsx"
import { Checkbox } from "antd"
import { SearchOutlined, ReadOutlined } from "@ant-design/icons"
import { TextToolbar } from "./TextToolbar.jsx"
import { InsertToolbar } from "./InsertToolbar.jsx"
import { LayoutToolbar } from "./LayoutToolbar.jsx"
import { ThemeControls } from "./ThemeControls.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/toolbar.module.scss"

const TABS = ["开始", "插入", "布局", "视图"]

// 页签、面板和只读开关只更新视图状态；Provider 将只读/切换状态同步到编辑器可编辑性。
export function EditorToolbar() {
  const { store } = useDocumentEditor()
  const activeTab = useEditorStore(state => state.activeTab)
  const readOnly = useEditorStore(state => state.readOnly)
  const switching = useEditorStore(state => state.switching)

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="编辑工具">
          {TABS.map(tab => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={tab === activeTab}
              className={clsx(styles.tab, tab === activeTab && styles.active)}
              onClick={() => store.getState().updateView({ activeTab: tab })}
            >{tab}</button>
          ))}
        </div>
        <div className={styles.actions}>
          <button type="button" onClick={() => store.getState().updateView({ searchOpen: true })}><SearchOutlined />查找 <kbd>⌘ / Ctrl F</kbd></button>
          <button
            type="button"
            aria-pressed={readOnly}
            disabled={switching}
            onClick={() => store.getState().updateView({ readOnly: !readOnly })}
          ><ReadOutlined />{readOnly ? "返回编辑" : "只读预览"}</button>
        </div>
      </div>
      <div className={styles.content} role="tabpanel" aria-label={`${activeTab}工具`}>
        {activeTab === "开始" && <TextToolbar />}
        {activeTab === "插入" && <InsertToolbar />}
        {activeTab === "布局" && <LayoutToolbar />}
        {activeTab === "视图" && <ViewToolbar />}
      </div>
    </div>
  )
}

const ViewToolbar = () => {
  const { store } = useDocumentEditor()
  const outlineOpen = useEditorStore(state => state.outlineOpen)
  const searchOpen = useEditorStore(state => state.searchOpen)
  return (
    <div className={styles.view}>
      <ThemeControls />
      <Checkbox checked={outlineOpen} onChange={event => store.getState().updateView({ outlineOpen: event.target.checked })}>文档大纲</Checkbox>
      <Checkbox checked={searchOpen} onChange={event => store.getState().updateView({ searchOpen: event.target.checked })}>查找替换</Checkbox>
      <button type="button" onClick={() => store.getState().updateView({ fitWidth: true })}>适应宽度</button>
      <button type="button" onClick={() => store.getState().updateView({ zoom: 1, fitWidth: false })}>实际大小</button>
      <span>纸张连续显示，打印时按纸张设置分页</span>
    </div>
  )
}
