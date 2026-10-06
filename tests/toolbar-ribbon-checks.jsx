/**
 * 工具栏浏览器综合验收覆盖功能分组、完整/极简、浮层草稿、导出快照与真实横向滚动。
 * 表格上下文命令、选区保留、目标映射及禁写守卫在真实 Workspace 上运行，专项模块复用同一场景装配器。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import { TextSelection } from "@tiptap/pm/state"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { removeVerificationDocuments } from "./browser-checks.js"
import { runToolbarModeChecks } from "./toolbar-mode-checks.js"
import { runTableInsertChecks } from "./table-insert-checks.js"
import { runBasicEditingChecks } from "./basic-editing-checks.js"
import { TOOLBAR_MODE_KEY, TOOLBAR_MODES } from "../src/pages/editor/tools/toolbar-preferences.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const delay = () => new Promise(resolve => setTimeout(resolve, 40))
// 轮询实际 store/DOM/异步转换条件，条件可返回 Promise，固定上限避免组件失效时验收无限等待。
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay() }
  throw new Error(message)
}
// 按钮文案去空白仅用于定位，visible 排除稳定挂载的隐藏面板与不可见 portal。
const normalized = text => text.replace(/\s/g, "")
const visible = element => !!element?.getClientRects().length && !element.closest("[hidden]") && getComputedStyle(element).visibility !== "hidden"
const byLabel = (host, label) => [...(host?.querySelectorAll(`[aria-label="${label}"]`) || [])].find(visible)
const buttons = (host, name, includeHidden = false) => [...(host?.querySelectorAll("button") || [])].filter(element => (includeHidden || visible(element)) && normalized(element.getAttribute("aria-label") || element.textContent) === normalized(name))
const button = (host, name) => buttons(host, name)[0]
const dialog = name => [...document.querySelectorAll('[role="dialog"]')].find(element => visible(element) && element.querySelector(".ant-modal-title")?.textContent === name)
// 优先可访问标签，缺显式标签时回退关联 label，兼容原生纸张/段落字段与 AntD 控件。
const field = (host, label) => {
  const named = byLabel(host, label)
  if (named) return named
  const element = [...(host?.querySelectorAll("label") || [])].find(item => normalized(item.textContent) === normalized(label))
  return element?.querySelector("input,textarea,select") || (element?.htmlFor ? document.getElementById(element.htmlFor) : null)
}
// 原生 setter/input 更新 React 受控值，让跨标签草稿断言覆盖真实输入事件而非直接调用回调。
const setInput = (element, value) => {
  assert(element, "工具栏验收输入控件不存在")
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, String(value))
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const cell = text => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [120], paddingX: 3 }, content: [paragraph(text)] })
// 固定文字、2×2 表格和尾段支持同一会话中格式、单元格结构、插入位置及独立撤销检查。
const fixture = () => ({ type: "doc", content: [
  paragraph("工具栏验收正文保留选区与内容。"),
  { type: "table", content: [
    { type: "tableRow", content: [cell("第一格"), cell("第二格")] },
    { type: "tableRow", content: [cell("第三格"), cell("第四格")] }
  ] },
  paragraph("末尾仍可继续编辑。")
] })
// 节点查询从当前正文重新遍历，结构操作改变表格后不沿用初始化单元格坐标。
const firstCell = editor => {
  let found
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.type.name === "tableCell") found = { node, pos }
  })
  assert(found, "工具栏验收缺少表格")
  return found
}
// 表格节点与 TableMap 一并重读，逻辑行列位置用于合成选区与结构断言。
const table = editor => {
  let found
  editor.state.doc.descendants((node, pos) => { if (!found && node.type.name === "table") found = { node, pos, map: TableMap.get(node) } })
  assert(found, "工具栏验收缺少表格")
  return found
}
// 逻辑行列经 TableMap 映射为正文绝对起点，避免把行内数组索引当成 ProseMirror 坐标。
const cellPosition = (editor, row = 0, column = 0) => {
  const current = table(editor)
  return current.pos + 1 + current.map.map[row * current.map.width + column]
}
const cellNode = (editor, row = 0, column = 0) => editor.state.doc.nodeAt(cellPosition(editor, row, column))
// 合成光标置于单元格段落内并聚焦正文，触发表格上下文；它并不模拟鼠标拖选。
const selectCell = (editor, row = 0, column = 0) => {
  editor.view.focus()
  editor.commands.setTextSelection(cellPosition(editor, row, column) + 2)
}
const group = label => [...document.querySelectorAll(`[role="group"][aria-label="${label}"]`)].find(visible)
// 通过浏览器 DOM Selection 和 selectionchange 读取原生光标，再合成 pointerup 走真实组件监听。
const pointerCaret = async (editor, element, offset = 0) => {
  editor.view.focus()
  const text = element.firstChild
  assert(text?.nodeType === Node.TEXT_NODE, "单元格光标目标没有文字节点")
  const range = document.createRange()
  range.setStart(text, Math.min(offset, text.textContent.length))
  range.collapse(true)
  const selection = document.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event("selectionchange"))
  const position = editor.view.posAtDOM(text, range.startOffset)
  await waitFor(() => editor.state.selection.from === position && editor.state.selection.empty, "浏览器光标没有同步到编辑器")
  element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 41, pointerType: "mouse", button: 0, buttons: 0 }))
}
// 探针渲染完整工作区并暴露已初始化的 Context，命令和 UI 共享真实 editor/store。
function Probe({ onContext }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onContext(context) }, [context, onContext])
  return <EditorWorkspace onDocumentChange={() => {}} />
}

/**
 * 用真实 Workspace 验证功能入口迁移、草稿和导出生命周期，而非重复组件的分支实现。
 * 选区与跨标签切换是合成操作；弹窗输入、IndexedDB 与溢出滚动使用真实浏览器状态。
 * 不触发下载或系统打印，只生成并取消导出确认；卸载后按本轮精确 ID 清理文档。
 */
export async function runToolbarRibbonChecks(report = () => {}) {
  // 记录验收前的工具栏偏好，结束恢复它；各 fixture 清单按精确 ID 清理，不覆盖用户已有文档。
  const previousMode = localStorage.getItem(TOOLBAR_MODE_KEY)
  const host = document.createElement("div")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:900px;margin:24px 0"
  document.body.append(host)
  const records = []
  let current
  // 查询器每次读取最新可见节点，切模式或标签后不会保留已经隐藏的 DOM 操作目标。
  const toolbar = () => host.querySelector("[data-toolbar-mode]")
  const tabs = () => [...host.querySelectorAll('[role="tablist"][aria-label="编辑工具"] [role="tab"]')]
  const activePanel = () => [...host.querySelectorAll('[role="tabpanel"]')].find(visible)
  const toggle = () => [...host.querySelectorAll("button[aria-label]")].find(element => visible(element) && /切换工具栏|展开工具栏|收起工具栏/.test(element.getAttribute("aria-label")))
  const menuItem = name => [...document.querySelectorAll('[role="menuitemradio"]')].find(element => visible(element) && element.textContent === name)
  // 通过实际模式菜单选择并等 dataset 与 portal 收起，覆盖偏好持久化和入口焦点恢复。
  const switchMode = async mode => {
    toggle().click()
    const label = TOOLBAR_MODES.find(item => item.key === mode).label
    const item = await waitFor(() => menuItem(label), "工具栏模式菜单未打开")
    item.click()
    await waitFor(() => toolbar().dataset.toolbarMode === mode, "工具栏模式未切换")
    await waitFor(() => !menuItem(label), "工具栏模式菜单未收起")
  }
  // 固定文字选区提供可重复的格式/替换目标，随后工具按钮必须保留该范围。
  const selectText = editor => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 8)))
    editor.view.focus()
  }
  // 极简使用分组菜单，完整模式使用标签按钮；两条路径都等待活动面板，而不直接改 activeTab。
  const switchTab = async name => {
    if (toolbar().dataset.toolbarMode === "compact") {
      byLabel(host, "切换工具分组").click()
      const item = await waitFor(() => menuItem(name), `极简模式缺少${name}分组`)
      item.click()
      await waitFor(() => activePanel()?.getAttribute("aria-label") === `${name}工具`, `极简模式${name}工具未显示`)
      await waitFor(() => !menuItem(name), "极简模式分组菜单未收起")
      return activePanel()
    }
    const trigger = tabs().find(element => element.textContent === name)
    assert(trigger && visible(trigger), `缺少可见的${name}标签`)
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
    trigger.click()
    await waitFor(() => trigger.getAttribute("aria-selected") === "true" && activePanel(), `${name}工具未显示`)
    return activePanel()
  }
  // 每项重建已保存 fixture 与 Provider，默认清模式偏好；专门恢复用例可保留偏好验证跨文档挂载。
  const mount = async ({ keepMode = false } = {}) => {
    if (!keepMode) localStorage.removeItem(TOOLBAR_MODE_KEY)
    current = null
    const document = { ...createDocument(), title: `工具栏验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, content: fixture() }
    const assets = new Map()
    const saved = await saveLocalDocument(document, assets, 0)
    records.push({ document, assets })
    ReactDOM.render(<EditorProvider record={{ document, assets, storageVersion: saved.storageVersion }}><Probe onContext={value => { current = value }} /></EditorProvider>, host)
    await waitFor(() => current?.editor && toolbar() && tabs().length, "工具栏真实会话未就绪")
    current.store.getState().updateView({ activeTab: "开始", outlineOpen: false, fitWidth: false, zoom: 1 })
    await waitFor(() => button(activePanel(), "段落设置"), "工具栏未就绪")
    return current
  }
  // 每个场景独立挂载/卸载并报告，旧异步导出、草稿和正文历史不能污染后续规则。
  const check = async (name, run) => {
    try { await mount(); await run(current); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
    finally { ReactDOM.unmountComponentAtNode(host); await delay() }
  }
  try {
    await check("工具栏：七个标签保留格式、插入、表格、批注、页面、视图与全部导出入口", async ({ editor }) => {
      const names = ["开始", "插入", "表格", "工具", "页面", "视图", "导出"]
      assert(JSON.stringify(tabs().map(element => element.textContent)) === JSON.stringify(names), "工具栏标签名称或顺序与参考不符")
      assert(visible(toolbar().querySelector('[role="status"][data-save-status]')), "保存状态未保留在工具栏标题行")
      selectText(editor)
      const selection = editor.state.selection.toJSON()
      const content = JSON.stringify(editor.getJSON())
      const entrances = {
        开始: ["段落设置"], 插入: ["图片", "附件", "表格", "水平线", "分页符", "代码块", "日期时间", "特殊字符", "表情"],
        工具: ["添加批注", "查找替换", "全选", "字数统计"], 页面: ["纸张设置"], 视图: ["只读预览", "适应宽度", "实际大小"],
        导出: ["Word 文档（.docx）", "Mewoc 文档（.json）", "HTML 文档（.html）", "Markdown（.md）", "纯文本（.txt）", "打印 / PDF"]
      }
      for (const name of names) {
        const panel = await switchTab(name)
        for (const entrance of entrances[name] || []) assert(button(panel, entrance), `${name}缺少可见的${entrance}入口`)
        if (name === "表格") assert(button(panel, "插入表格"), "表格标签没有建表入口")
        assert(JSON.stringify(editor.state.selection.toJSON()) === JSON.stringify(selection), `切到${name}丢失正文选区`)
      }
      assert(JSON.stringify(editor.getJSON()) === content, "仅切标签写入了正文")
      tabs()[0].focus()
      tabs()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
      await waitFor(() => document.activeElement === tabs()[6] && tabs()[6].getAttribute("aria-selected") === "true", "键盘 End 无法到达导出标签")
      tabs()[6].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
      await waitFor(() => document.activeElement === tabs()[0] && tabs()[0].getAttribute("aria-selected") === "true", "键盘 Home 无法回到开始标签")
      await switchTab("工具")
      button(activePanel(), "查找替换").click()
      await waitFor(() => byLabel(host, "查找内容"), "工具入口未打开查找替换面板")
      byLabel(host, "关闭查找").click()
      await switchTab("视图")
      button(activePanel(), "只读预览").click()
      await waitFor(() => !editor.isEditable && button(activePanel(), "返回编辑"), "视图入口未进入只读")
      button(activePanel(), "返回编辑").click()
      await waitFor(() => editor.isEditable, "视图入口无法恢复编辑")
    })
    await check("工具栏：完整与极简模式往返保留正文和选区，继续可用段落设置", async ({ editor, store }) => {
      selectText(editor)
      const content = JSON.stringify(editor.getJSON())
      const selection = editor.state.selection.toJSON()
      const revision = store.getState().revision
      const expandedHeight = toolbar().getBoundingClientRect().height
      assert(toggle(), "工具栏缺少可访问的展开/收起入口")
      await switchMode("compact")
      await waitFor(() => toolbar().dataset.toolbarMode === "compact", "未进入精简工具栏")
      assert(toolbar().getBoundingClientRect().height < expandedHeight, "精简模式没有节省工具栏高度")
      await switchMode("ribbon")
      await waitFor(() => toolbar().dataset.toolbarMode === "ribbon" && button(activePanel(), "段落设置"), "展开后原格式入口未恢复")
      assert(JSON.stringify(editor.getJSON()) === content && JSON.stringify(editor.state.selection.toJSON()) === JSON.stringify(selection) && store.getState().revision === revision, "工具栏显示模式修改了正文、选区或 revision")
    })
    await runToolbarModeChecks({ check, host, toolbar, tabs, activePanel, toggle, selectText, switchMode, switchTab, mount, assert, waitFor, button, byLabel, dialog, visible })
    await runTableInsertChecks({ check, toolbar, activePanel, selectText, selectCell, switchMode, switchTab, assert, waitFor, button, byLabel, setInput, visible })
    await runBasicEditingChecks({ check, toolbar, activePanel, selectText, switchMode, switchTab, assert, waitFor, button, byLabel, setInput, visible })
    await check("工具栏：表格设置跨标签保留草稿与原单元格目标，应用仍可单次撤销", async ({ editor, store }) => {
      await switchTab("表格")
      const target = firstCell(editor)
      editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, target.pos)))
      const trigger = await waitFor(() => button(activePanel(), "表格设置") && !button(activePanel(), "表格设置").disabled && button(activePanel(), "表格设置"), "表格选区未激活设置入口")
      trigger.click()
      const opened = await waitFor(() => dialog("表格设置"), "表格设置弹窗未打开")
      setInput(field(opened, "水平内边距"), 27)
      await delay()
      store.getState().updateView({ activeTab: "开始" })
      await waitFor(() => tabs().find(element => element.textContent === "开始")?.getAttribute("aria-selected") === "true", "程序切标签未生效")
      assert(dialog("表格设置") === opened && field(opened, "水平内边距").value === "27", "切标签卸载了表格草稿")
      assert(firstCell(editor).node.attrs.paddingX === 3, "未提交草稿提前修改了表格")
      button(opened, "应用设置").click()
      await waitFor(() => !dialog("表格设置"), "跨标签后表格设置无法应用")
      assert(firstCell(editor).node.attrs.paddingX === 27, "跨标签应用未写入原单元格")
      editor.commands.undo()
      assert(firstCell(editor).node.attrs.paddingX === 3, "表格草稿应用无法单次撤销")
    })
    await check("工具栏：纸张草稿跨标签与收起保留，确认后才更新页面设置", async ({ store }) => {
      await switchTab("页面")
      button(activePanel(), "纸张设置").click()
      const opened = await waitFor(() => dialog("纸张设置"), "纸张设置弹窗未打开")
      const original = JSON.stringify(store.getState().page)
      setInput(field(opened, "左边距（mm）"), 31)
      opened.querySelector('input[type="radio"][value="landscape"]').click()
      await delay()
      store.getState().updateView({ activeTab: "插入" })
      await delay()
      await switchMode("compact")
      await waitFor(() => toolbar().dataset.toolbarMode === "compact", "弹窗期间未收起工具栏")
      assert(dialog("纸张设置") === opened && field(opened, "左边距（mm）").value === "31", "切标签或收起丢失纸张草稿")
      assert(JSON.stringify(store.getState().page) === original, "未提交纸张草稿改变了文档")
      button(opened, "应用").click()
      await waitFor(() => !dialog("纸张设置") && store.getState().page.marginsMm.left === 31, "隐藏面板的纸张草稿无法确认")
      assert(store.getState().page.orientation === "landscape", "横向草稿没有应用")
    })
    // 导出所有者必须跨标签/模式稳定存在；等待异步生成后比较确认快照，取消而不触发真实下载或打印。
    await check("工具栏：单一导出会话跨标签与收起继续生成，Word 和 Markdown 确认保持快照", async ({ editor, store }) => {
      await switchTab("导出")
      const owner = button(activePanel(), "Word 文档（.docx）")
      const title = store.getState().title
      owner.click()
      store.getState().updateView({ activeTab: "开始" })
      const opened = await waitFor(() => dialog("导出 Word 文档"), "切标签中止了 Word 转换或丢失确认结果")
      assert(owner.isConnected && buttons(host, "Word 文档（.docx）", true).length === 1 && buttons(host, "Word 文档（.docx）", true)[0] === owner, "导出所有者被卸载或重复挂载")
      assert(opened.textContent.includes(title) && button(opened, "下载 .docx"), "Word 确认缺少本次快照或下载入口")
      await switchMode("compact")
      await waitFor(() => toolbar().dataset.toolbarMode === "compact", "导出确认期间未收起")
      assert(dialog("导出 Word 文档") === opened, "收起丢失已生成的 Word 结果")
      button(opened, "取消").click()
      await waitFor(() => !dialog("导出 Word 文档"), "Word 确认无法取消")
      await switchMode("ribbon")
      await waitFor(() => toolbar().dataset.toolbarMode === "ribbon", "导出后未恢复展开")
      await switchTab("导出")
      assert(button(activePanel(), "Word 文档（.docx）") === owner, "返回导出标签创建了新会话")
      button(activePanel(), "Markdown（.md）").click()
      const preview = await waitFor(() => dialog("导出 Markdown"), "Markdown 转换确认未打开")
      const source = preview.querySelector('[aria-label="导出 Markdown 源码"]').value
      editor.commands.insertContentAt(1, "生成后正文追加")
      store.getState().updateView({ activeTab: "视图" })
      await delay()
      assert(dialog("导出 Markdown") === preview && preview.querySelector('[aria-label="导出 Markdown 源码"]').value === source && !source.includes("生成后正文追加"), "切标签重建了 Markdown 结果或改变已生成快照")
      button(preview, "取消").click()
      await waitFor(() => !dialog("导出 Markdown"), "Markdown 确认无法取消")
    })
    await check("工具栏：程序切标签关闭更多样式浮层，返回后可重新展开", async ({ editor, store }) => {
      selectText(editor)
      const more = byLabel(host, "更多段落样式")
      more.click()
      await waitFor(() => more.getAttribute("aria-expanded") === "true" && [...document.querySelectorAll('[aria-label="更多段落样式卡片"]')].some(visible), "更多样式未展开")
      const content = JSON.stringify(editor.getJSON())
      store.getState().updateView({ activeTab: "插入" })
      await waitFor(() => more.getAttribute("aria-expanded") === "false" && ![...document.querySelectorAll('[aria-label="更多段落样式卡片"]')].some(visible), "程序切标签后样式 portal 仍悬浮")
      await switchTab("开始")
      assert(byLabel(host, "更多段落样式") === more, "切标签重建了开始工具栏")
      more.click()
      await waitFor(() => more.getAttribute("aria-expanded") === "true", "返回标签后无法再次展开样式")
      more.click()
      await waitFor(() => more.getAttribute("aria-expanded") === "false", "再次展开后无法收起样式")
      assert(JSON.stringify(editor.getJSON()) === content, "关闭临时样式浮层修改了正文")
    })
    // 把宿主宽度缩窄而不是只改 window，验证 ResizeObserver 对实际可用容器和内容宽度的响应。
    await check("工具栏：宽视口中的窄容器可实际横向滚动并到达末尾工具", async () => {
      // 不缩整个浏览器：独立收窄真实工具栏，防止 viewport 媒体查询掩盖容器溢出。
      toolbar().style.width = "620px"
      toolbar().style.maxWidth = "620px"
      window.dispatchEvent(new Event("resize"))
      const scroller = await waitFor(() => [toolbar(), ...toolbar().querySelectorAll("*")].find(element => {
        const overflow = getComputedStyle(element).overflowX
        return visible(element) && ["auto", "scroll"].includes(overflow) && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2
      }), "窄工具栏没有可滚动的真实溢出容器")
      assert(toolbar().getBoundingClientRect().width <= 621, "fixture 未真正收窄工具栏")
      const next = await waitFor(() => byLabel(host, "向右查看更多工具"), "溢出后缺少向右查看入口")
      next.click()
      await waitFor(() => scroller.scrollLeft > 0 && byLabel(host, "向左查看更多工具"), "向右查看更多工具没有产生实际滚动")
      scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth
      await waitFor(() => scroller.scrollLeft > 0 && Math.abs(scroller.scrollLeft - (scroller.scrollWidth - scroller.clientWidth)) <= 2 && byLabel(host, "向右查看更多工具")?.disabled, "横向溢出无法到达末尾或末端箭头仍可用")
      // 一次左移可能只到上一屏；等待每次平滑滚动真正停下，再继续点可见入口。
      for (let step = 0; step < 8 && scroller.scrollLeft > 1; step++) {
        const previous = scroller.scrollLeft
        let last = previous
        let stable = 0
        const back = await waitFor(() => scroller.scrollLeft <= 1 ? true : byLabel(host, "向左查看更多工具"), "缺少返回左侧工具的入口")
        if (scroller.scrollLeft <= 1) break
        back.click()
        await waitFor(() => {
          const position = scroller.scrollLeft
          stable = position < previous - 1 && Math.abs(position - last) <= 0.5 ? stable + 1 : 0
          last = position
          return position <= 1 || stable >= 2
        }, "向左查看更多工具没有完成实际滚动")
      }
      await waitFor(() => scroller.scrollLeft <= 1 && !byLabel(host, "向左查看更多工具"), "滚回起点后左箭头未收起")
      assert(button(activePanel(), "段落设置"), "滚回后格式设置入口不可用")
    })
    // 原生 DOM Selection 同步到 editor 后合成 pointerup，验证进入表格激活与格内手动标签优先规则。
    await check("表格工具：点击单元格自动激活，手动开始不被格内光标变化抢回", async ({ editor, store }) => {
      const body = JSON.stringify(editor.getJSON())
      const first = editor.view.nodeDOM(cellPosition(editor)).querySelector("p")
      await pointerCaret(editor, first, 1)
      await waitFor(() => store.getState().activeTab === "表格" && button(activePanel(), "表格设置"), "点击单元格没有进入表格工具")
      await switchTab("开始")
      // 模拟在原单元格中继续移动光标：没有新 pointerup，不应覆盖用户的文字工具选择。
      editor.view.focus()
      editor.commands.setTextSelection(cellPosition(editor) + 3)
      await delay()
      assert(store.getState().activeTab === "开始" && button(activePanel(), "段落设置"), "格内选区更新抢回了表格工具")
      await pointerCaret(editor, editor.view.nodeDOM(cellPosition(editor, 1, 1)).querySelector("p"), 1)
      await waitFor(() => store.getState().activeTab === "表格", "重新点击另一单元格没有恢复表格工具")
      await pointerCaret(editor, editor.view.dom.querySelector(":scope > p"), 2)
      await waitFor(() => store.getState().activeTab === "开始", "离开表格没有恢复开始工具")
      assert(JSON.stringify(editor.getJSON()) === body, "上下文激活修改了正文")
    })
    await check("表格工具：十二种对齐可达，改变光标与前方插入后仍作用原目标且一次撤销", async ({ editor }) => {
      selectCell(editor)
      await switchTab("表格")
      button(activePanel(), "对齐方式").click()
      const palette = await waitFor(() => group("单元格对齐方式"), "单元格对齐菜单未打开")
      for (const vertical of ["顶部", "居中", "底部"]) {
        for (const horizontal of ["左对齐", "居中对齐", "右对齐", "两端对齐"]) assert(button(palette, `${vertical}${horizontal}`), `对齐菜单缺少${vertical}${horizontal}`)
      }
      // 模拟选区外内容更新；默认更新光标会主动离开表格并关闭菜单，不属于书签映射场景。
      editor.commands.insertContentAt(1, "前方插入", { updateSelection: false })
      selectCell(editor, 1, 1)
      const before = JSON.stringify(editor.getJSON())
      const other = JSON.stringify(cellNode(editor, 1, 1).toJSON())
      button(palette, "底部两端对齐").click()
      await waitFor(() => !group("单元格对齐方式"), "应用后对齐菜单未关闭")
      assert(cellNode(editor).attrs.verticalAlign === "bottom" && cellNode(editor).firstChild.attrs.textAlign === "justify", "对齐未应用于映射后的原单元格")
      assert(JSON.stringify(cellNode(editor, 1, 1).toJSON()) === other, "快捷对齐误改后来选择的单元格")
      editor.commands.undo()
      assert(JSON.stringify(editor.getJSON()) === before, "垂直和水平对齐无法一次撤销或吞掉前方输入")
    })
    await check("表格工具：自定义底色保留打开时单元格，回显与单次撤销正确", async ({ editor }) => {
      selectCell(editor)
      await switchTab("表格")
      button(activePanel(), "背景颜色").click()
      const palette = await waitFor(() => group("单元格背景颜色"), "单元格底色菜单未打开")
      assert(button(palette, "背景颜色 #fff3cd") && button(palette, "无背景"), "底色菜单缺少预设或清除入口")
      selectCell(editor, 1, 1)
      const before = JSON.stringify(editor.getJSON())
      setInput(field(palette, "自定义背景颜色"), "#123456")
      await delay()
      button(palette, "应用颜色").click()
      await waitFor(() => !group("单元格背景颜色"), "应用后底色菜单未关闭")
      assert(cellNode(editor).attrs.backgroundColor === "#123456" && cellNode(editor, 1, 1).attrs.backgroundColor === null, "底色没有保留打开菜单时的原目标")
      selectCell(editor)
      button(activePanel(), "背景颜色").click()
      const reopened = await waitFor(() => group("单元格背景颜色"), "已设底色无法再次打开")
      assert(field(reopened, "自定义背景颜色").value === "#123456", "自定义底色未正确回显")
      button(activePanel(), "背景颜色").click()
      await waitFor(() => !group("单元格背景颜色"), "底色菜单无法取消")
      editor.commands.undo()
      assert(JSON.stringify(editor.getJSON()) === before, "自定义底色不能一次撤销")
    })
    // 结构操作应建立独立撤销；只读/切换和组合输入期间连合成 click 也不能写内容或移动命令目标。
    await check("表格工具：四向插入、三种表头和单元格导航实际生效，禁写状态拦截命令", async ({ editor, store }) => {
      const click = async name => {
        const control = await waitFor(() => button(activePanel(), name), `缺少${name}入口`)
        assert(!control.matches(":disabled"), `${name}意外不可用`)
        control.click()
        await delay()
      }
      selectCell(editor)
      await switchTab("表格")
      for (const [name, rows, columns, row, column] of [
        ["上方插入行", 3, 2, 1, 0], ["下方插入行", 3, 2, 0, 0],
        ["左侧插入列", 2, 3, 0, 1], ["右侧插入列", 2, 3, 0, 0]
      ]) {
        selectCell(editor)
        const before = JSON.stringify(editor.getJSON())
        await click(name)
        assert(table(editor).map.height === rows && table(editor).map.width === columns && cellNode(editor, row, column).textContent === "第一格", `${name}方向或原内容位置不正确`)
        editor.commands.undo()
        assert(JSON.stringify(editor.getJSON()) === before, `${name}无法一次撤销`)
      }
      for (const [name, expected] of [["表头行", [true, true, false, false]], ["表头列", [true, false, true, false]], ["表头单元格", [true, false, false, false]]]) {
        selectCell(editor)
        const before = JSON.stringify(editor.getJSON())
        await click(name)
        assert(expected.every((header, index) => (cellNode(editor, Math.floor(index / 2), index % 2).type.name === "tableHeader") === header), `${name}作用范围不正确`)
        editor.commands.undo()
        assert(JSON.stringify(editor.getJSON()) === before, `${name}无法一次撤销`)
      }
      selectCell(editor)
      await waitFor(() => button(activePanel(), "上一单元格")?.matches(":disabled"), "首格上一入口没有禁用")
      const body = JSON.stringify(editor.getJSON())
      await click("下一单元格")
      assert(editor.state.selection.from > cellPosition(editor, 0, 1) && editor.state.selection.from < cellPosition(editor, 1, 0), "下一单元格未实际移动光标")
      await click("上一单元格")
      assert(editor.state.selection.from > cellPosition(editor) && editor.state.selection.from < cellPosition(editor, 0, 1), "上一单元格未实际移动光标")
      selectCell(editor, 1, 1)
      await waitFor(() => button(activePanel(), "下一单元格")?.matches(":disabled"), "末格下一入口没有禁用")
      assert(JSON.stringify(editor.getJSON()) === body, "导航单元格修改了表格或自动追加行")
      const guarded = ["上方插入行", "下方插入行", "左侧插入列", "右侧插入列", "删除行", "删除列", "表头行", "表头列", "表头单元格", "上一单元格", "下一单元格"]
      const selection = JSON.stringify(editor.state.selection.toJSON())
      for (const state of [{ readOnly: true }, { readOnly: false, switching: true }]) {
        store.getState().updateView(state)
        await waitFor(() => !editor.isEditable, "禁写状态没有同步到编辑器")
        for (const name of guarded) {
          const control = button(activePanel(), name)
          assert(control?.matches(":disabled"), `禁写状态仍可点击${name}`)
          control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
        }
        assert(JSON.stringify(editor.getJSON()) === body && JSON.stringify(editor.state.selection.toJSON()) === selection, "合成点击绕过禁写状态改变了表格或光标")
      }
      store.getState().updateView({ readOnly: false, switching: false })
      await waitFor(() => editor.isEditable, "结构操作后无法恢复编辑")
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "n" }))
      assert(editor.view.composing, "合成组合输入未进入保护状态")
      button(activePanel(), "下方插入行").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      button(activePanel(), "上一单元格").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }))
      await waitFor(() => !editor.view.composing, "合成组合输入没有结束")
      assert(JSON.stringify(editor.getJSON()) === body && JSON.stringify(editor.state.selection.toJSON()) === selection, "组合输入期间表格命令改写了正文或光标")
    })
  // 先卸载任务所有者、删除本轮文档，再恢复原 localStorage 模式偏好，避免验收改变用户后续工具栏布局。
  } finally {
    ReactDOM.unmountComponentAtNode(host)
    host.remove()
    await removeVerificationDocuments(records)
    if (previousMode === null) localStorage.removeItem(TOOLBAR_MODE_KEY)
    else localStorage.setItem(TOOLBAR_MODE_KEY, previousMode)
  }
}
