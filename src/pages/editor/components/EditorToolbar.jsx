/**
 * 编辑器功能分组入口：管理标签切换、完整/极简模式、上下文表格工具和横向溢出。
 * 所有面板保持挂载，隐藏标签不会丢失弹窗草稿、导出任务或打印资源。
 */
import { useEffect, useRef, useState } from "react"
import clsx from "clsx"
import { Checkbox, message } from "antd"
import { useEditorState } from "@tiptap/react"
import { IconSearch, IconEye, IconPilcrow, IconMenu2, IconChevronDown, IconAlertTriangle, IconLayoutNavbarCollapse, IconLayoutNavbarExpand } from "@tabler/icons-react"
import { TextToolbar } from "./TextToolbar.jsx"
import { InsertToolbar } from "./InsertToolbar.jsx"
import { LayoutToolbar } from "./LayoutToolbar.jsx"
import { ThemeControls } from "./ThemeControls.jsx"
import { ReviewToolbar } from "./ReviewToolbar.jsx"
import { DocumentTools } from "./DocumentTools.jsx"
import { TableControls } from "./TableControls.jsx"
import { TableInsertAction } from "./TableInsertAction.jsx"
import { ExportActions } from "./ExportActions.jsx"
import { DocumentSaveStatus } from "./DocumentSaveStatus.jsx"
import { ToolbarOverflow } from "./ToolbarOverflow.jsx"
import { ToolbarMenu } from "./ToolbarMenu.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { createId } from "../tools/create-id.js"
import { readToolbarMode, saveToolbarMode, TOOLBAR_MODES } from "../tools/toolbar-preferences.js"
import { saveFormattingMarks } from "../tools/formatting-marks-preferences.js"
import styles from "../sass/toolbar.module.scss"

// 标签顺序同时决定按钮顺序与面板对应关系，键盘左右导航也使用这份列表。
const TABS = ["开始", "插入", "表格", "工具", "页面", "视图", "导出"]

export function EditorToolbar() {
  const { editor, store } = useDocumentEditor()
  // 兼容旧视图分组名，显示时映射到现有标签，避免保留的偏好使面板无法匹配。
  const storedTab = useEditorStore(state => state.activeTab)
  const activeTab = ({ 布局: "页面", 审阅: "工具" })[storedTab] || storedTab
  // mode 是当前工具栏偏好；菜单开关、触发按钮 ref 和稳定 ID 只服务本次界面实例。
  // tabsRef 保存标签按钮，供键盘导航直接移动焦点，而不触碰正文选区。
  const [mode, setMode] = useState(readToolbarMode)
  const compact = mode === "compact"
  const [groupOpen, setGroupOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const groupRef = useRef(null)
  const modeRef = useRef(null)
  const [id] = useState(() => `mewoc-toolbar-${createId()}`)
  const tabsRef = useRef([])
  // 分组或模式变化后收起极简分组菜单，防止过期菜单覆盖新的工具面板。
  useEffect(() => { setGroupOpen(false) }, [activeTab, compact])
  // 模式切换立即生效，收起菜单并把焦点还给入口；偏好保存失败仅提示，不撤回当前选择。
  const handleMode = ({ key }) => {
    setMode(key)
    setModeOpen(false)
    modeRef.current?.focus({ preventScroll: true })
    if (!saveToolbarMode(key)) message.warning({ content: "工具栏已切换，但未能保存偏好，下次打开将使用完整模式", icon: <IconAlertTriangle aria-hidden="true" /> })
  }
  // 极简菜单选择写入共享视图状态，让标签与面板使用同一个 activeTab。
  const handleGroup = ({ key }) => {
    store.getState().updateView({ activeTab: key })
    setGroupOpen(false)
    groupRef.current?.focus({ preventScroll: true })
  }
  // 订阅选区与正文指针事件，使进入表格时出现适用工具；卸载解除事件避免重复响应。
  useEffect(() => {
    const editorDom = editor.view.dom
    let inTable = editor.isActive("table")
    const handleContext = () => {
      const next = editor.isActive("table")
      // 只在进出表格时切换上下文；用户留在单元格里手动选“开始”后，仍能继续设置文字。
      if (next !== inTable && editor.view.hasFocus()) {
        if (next) store.getState().updateView({ activeTab: "表格" })
        else if (store.getState().activeTab === "表格") store.getState().updateView({ activeTab: "开始" })
      }
      inTable = next
    }
    // 直接点击单元格可显式召回表格工具，即使用户此前在表格内手动切换了其他标签。
    const handlePointer = event => {
      if (event.target.closest("td, th") && editorDom.contains(event.target)) store.getState().updateView({ activeTab: "表格" })
    }
    editor.on("selectionUpdate", handleContext)
    editorDom.addEventListener("pointerup", handlePointer)
    return () => {
      editor.off("selectionUpdate", handleContext)
      editorDom.removeEventListener("pointerup", handlePointer)
    }
  }, [editor, store])
  // 实现 tablist 的左右循环与首尾跳转：同步激活标签及按钮焦点，保持键盘可访问性。
  const handleTabKey = (event, index) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length
    store.getState().updateView({ activeTab: TABS[next] })
    tabsRef.current[next]?.focus()
  }
  // 面板按 TABS 顺序固定映射；active/layoutKey 通知子工具收起不可见或换布局后的下拉层。
  const panels = [<TextToolbar key="text" active={activeTab === "开始"} layoutKey={mode} />, <InsertToolbar key="insert" active={activeTab === "插入"} layoutKey={mode} compact={compact} />,
    <TableToolbar key="table" visible={activeTab === "表格"} layoutKey={compact} />, <ToolsToolbar key="tools" />, <LayoutToolbar key="page" />,
    <ViewToolbar key="view" active={activeTab === "视图"} />, <ExportActions key="export" variant="ribbon" />]

  // 按钮按下时保留正文焦点，点击后切换视图；稳定 tab/panel ID 提供标签与面板的关联。
  return (
    <div className={styles.container} data-toolbar-mode={compact ? "compact" : "ribbon"}>
      <div className={styles.header}>
        <ToolbarMenu open={groupOpen && compact} onOpenChange={setGroupOpen} triggerRef={groupRef} label="工具分组"
          items={TABS.map(tab => ({ key: tab, label: tab }))} selectedKey={activeTab} onSelect={handleGroup}>
          <button ref={groupRef} type="button" className={styles.categoryPicker} aria-label="切换工具分组" aria-haspopup="menu" aria-expanded={groupOpen && compact}
            onKeyDown={event => { if (event.key === "Escape") setGroupOpen(false) }}
            onMouseDown={event => { if (event.button === 0) event.preventDefault() }}>
            <IconMenu2 aria-hidden="true" /><span>{activeTab}</span><IconChevronDown aria-hidden="true" />
          </button>
        </ToolbarMenu>
        <div className={styles.tabs} role="tablist" aria-label="编辑工具">
          {TABS.map((tab, index) => (
            <button key={tab} ref={element => { tabsRef.current[index] = element }} type="button" role="tab"
              id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={tab === activeTab}
              tabIndex={tab === activeTab ? 0 : -1} className={clsx(styles.tab, tab === activeTab && styles.active)}
              onMouseDown={event => { if (event.button === 0) event.preventDefault() }}
              onKeyDown={event => handleTabKey(event, index)}
              onClick={() => store.getState().updateView({ activeTab: tab })}>{tab}</button>
          ))}
        </div>
        <div className={styles.actions}>
          <DocumentSaveStatus />
          <ToolbarMenu open={modeOpen} onOpenChange={setModeOpen} triggerRef={modeRef} label="工具栏模式"
            items={TOOLBAR_MODES.map(item => ({ ...item, icon: item.key === "compact" ? <IconLayoutNavbarCollapse aria-hidden="true" /> : <IconLayoutNavbarExpand aria-hidden="true" /> }))}
            selectedKey={mode} onSelect={handleMode}>
            <button ref={modeRef} type="button" aria-label="切换工具栏" aria-haspopup="menu" aria-expanded={modeOpen}
              title={`当前为${compact ? "极简模式" : "完整模式"}，点击切换`}
              onKeyDown={event => { if (event.key === "Escape") setModeOpen(false) }}
              onMouseDown={event => { if (event.button === 0) event.preventDefault() }}>
              {compact ? <IconLayoutNavbarCollapse aria-hidden="true" /> : <IconLayoutNavbarExpand aria-hidden="true" />}
              <span>{compact ? "极简模式" : "完整模式"}</span><IconChevronDown aria-hidden="true" />
            </button>
          </ToolbarMenu>
        </div>
      </div>
      {/* 稳定挂载弹窗和导出所有者：切标签只隐藏入口，不销毁草稿、异步导出或打印资源。 */}
      {TABS.map((tab, index) => <div key={tab} className={styles.panel} id={`${id}-panel-${index}`} role="tabpanel"
        aria-label={`${tab}工具`} hidden={activeTab !== tab}>
        <ToolbarOverflow className={styles.content} activeKey={`${activeTab}-${compact}`}>{panels[index]}</ToolbarOverflow>
      </div>)}
    </div>
  )
}

// 表格标签始终提供插入入口，现有表格操作仅在正文选区处于表格且面板可见时激活。
const TableToolbar = ({ visible, layoutKey }) => {
  const { editor } = useDocumentEditor()
  const active = useEditorState({ editor, selector: ({ editor: current }) => current.isActive("table") })
  return <>
    <div className={styles.insert}><TableInsertAction active={visible} layoutKey={layoutKey} label="插入表格" /></div>
    <TableControls active={active && visible} layoutKey={layoutKey} />
    {!active && <p className={styles.description}>将光标放入表格，即可设置行列、单元格与表格样式。</p>}
  </>
}

// 组合查找、全文统计与批注入口；开启查找时关闭批注面板，统一右侧栏状态。
const ToolsToolbar = () => {
  const { store } = useDocumentEditor()
  return <>
    <div className={styles.insert}><button type="button" onClick={() => store.getState().updateView({ searchOpen: true, commentsOpen: false })}>
      <IconSearch aria-hidden="true" /><span>查找替换</span>
    </button></div>
    <DocumentTools />
    <ReviewToolbar />
  </>
}

// 视图设置控制主题、侧栏、缩放和只读预览；视图变化不计入正文撤销历史。
const ViewToolbar = ({ active }) => {
  const { store } = useDocumentEditor()
  const outlineOpen = useEditorStore(state => state.outlineOpen)
  const searchOpen = useEditorStore(state => state.searchOpen)
  const readOnly = useEditorStore(state => state.readOnly)
  const switching = useEditorStore(state => state.switching)
  const formattingMarks = useEditorStore(state => state.formattingMarks)
  const handleFormattingMarks = () => {
    if (store.getState().switching) return
    const visible = !store.getState().formattingMarks
    store.getState().updateView({ formattingMarks: visible })
    if (!saveFormattingMarks(visible)) message.warning({ content: "格式标记已切换，但未能保存偏好，下次打开将默认隐藏", icon: <IconAlertTriangle aria-hidden="true" /> })
  }
  return (
    <div className={styles.view}>
      <ThemeControls active={active} />
      <Checkbox checked={outlineOpen} onChange={event => store.getState().updateView({ outlineOpen: event.target.checked })}>文档大纲</Checkbox>
      <Checkbox checked={searchOpen} onChange={event => store.getState().updateView({ searchOpen: event.target.checked, ...(event.target.checked && { commentsOpen: false }) })}>查找替换</Checkbox>
      <button type="button" className={styles.viewAction} aria-label="格式标记" aria-pressed={formattingMarks} disabled={switching}
        title="在编辑模式显示段落、换行和空白标记" onMouseDown={event => event.preventDefault()} onClick={handleFormattingMarks}>
        <IconPilcrow aria-hidden="true" /><span>格式标记</span>
      </button>
      <button type="button" onClick={() => store.getState().updateView({ fitWidth: true })}>适应宽度</button>
      <button type="button" onClick={() => store.getState().updateView({ zoom: 1, fitWidth: false })}>实际大小</button>
      <button type="button" className={styles.viewAction} aria-pressed={readOnly} disabled={switching}
        onClick={() => store.getState().updateView({ readOnly: !readOnly })}>
        <IconEye aria-hidden="true" /><span>{readOnly ? "返回编辑" : "只读预览"}</span>
      </button>
    </div>
  )
}
