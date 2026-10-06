/**
 * 图表精细设置浏览器验收使用真实图片/表格、弹窗草稿和仓库，覆盖比例、逻辑列宽及混合最小补丁。
 * 目标书签、失败保留、只读切换和跨格式保存分别核对，独立 HTML 还验证真实布局而不是只检查 JSON。
 */
import { useEffect, useState } from "react"
import ReactDOM from "react-dom"
import { Editor } from "@tiptap/core"
import { closeHistory } from "@tiptap/pm/history"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { createDocumentAssetUrl } from "../src/pages/editor/tools/attachment-assets.js"
import { getDocumentAssets, getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentVersion, getDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"
import { createDocumentTemplate, deleteDocumentTemplate, getDocumentTemplate, instantiateDocumentTemplate } from "../src/pages/editor/tools/document-template-repository.js"
import { addDocumentComment, getCommentEntries, getCommentThreads } from "../src/pages/editor/tools/document-comments.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const delay = () => new Promise(resolve => setTimeout(resolve, 40))
// 有界轮询 UI、图片加载及存储条件；短间隔让真实 React 与编辑器事务有机会完成，失败不无限挂起。
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await delay()
  }
  throw new Error(message)
}
// 入口查询忽略隐藏标签，保证用例操作的是当前可见工具，不绕过组件 active 限制。
const visible = element => !!element?.getClientRects().length && !element.closest("[hidden]")
const byLabel = (host, label) => [...(host?.querySelectorAll(`[aria-label="${label}"]`) || [])].find(visible)
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(element => visible(element) && (element.getAttribute("aria-label") || element.textContent).replace(/\s/g, "") === name.replace(/\s/g, ""))
const dialog = name => [...document.querySelectorAll('[role="dialog"]')].find(element => element.querySelector(".ant-modal-title")?.textContent === name)
// 优先按 aria-label 查询，再回退 label 关联，让原生与 AntD 输入共用相同业务标签定位。
const field = (host, label) => {
  const named = byLabel(host, label)
  if (named) return named
  const element = [...(host?.querySelectorAll("label") || [])].find(item => item.textContent === label)
  return element?.querySelector("input,textarea,select") || (element?.htmlFor ? document.getElementById(element.htmlFor) : null)
}
// 按 input/textarea 原型使用原生 setter 派发 input，受控组件真实更新草稿而不是仅改变展示 DOM。
const setInput = (element, value) => {
  assert(element, "精细设置输入控件不存在")
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, String(value))
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
// 原生 select 直接走 change，AntD Select 走实际下拉项点击；两条路径都等待草稿刷新。
const choose = async (host, label, text) => {
  const element = field(host, label)
  assert(element, `${label}选择控件不存在`)
  if (element instanceof HTMLSelectElement) {
    const option = [...element.options].find(item => item.textContent === text)
    assert(option, `${label}没有${text}选项`)
    element.value = option.value
    element.dispatchEvent(new Event("change", { bubbles: true }))
  } else {
    const trigger = element.closest(".ant-select")?.querySelector(".ant-select-selector") || element
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    const option = await waitFor(() => [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")].find(item => item.textContent === text), `${label}选项未显示`)
    option.click()
  }
  await delay()
}
const paragraph = text => ({ type: "paragraph", content: text ? [{ type: "text", text }] : undefined })
const cell = (text, attrs = {}) => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [120], ...attrs }, content: [paragraph(text)] })
// 普通表给不同颜色/内边距用于混合态，合并表给一致逻辑列宽用于 colspan 覆盖范围断言。
const tableFixture = (merged = false) => ({ type: "table", content: [
  { type: "tableRow", attrs: { minHeight: 44 }, content: merged ? [cell("合并 A+B", { colspan: 2, colwidth: [110, 140] }), cell("C", { colwidth: [180] })] : [cell("A", { backgroundColor: "#ffdddd", paddingX: 3 }), cell("B", { backgroundColor: "#ddffdd", paddingX: 17 }), cell("C")] },
  { type: "tableRow", content: [cell("D", { colwidth: [merged ? 110 : 120] }), cell("E", { colwidth: [merged ? 140 : 120] }), cell("F", { colwidth: [merged ? 180 : 120] })] }
] })
// 每次从当前文档重新找目标节点与位置，避免尺寸/插入事务后继续使用过期坐标。
const nodeAt = (editor, type) => {
  let result = null
  editor.state.doc.descendants((node, pos) => { if (!result && node.type.name === type) result = { node, pos }; return !result })
  assert(result, `没有${type}测试节点`)
  return result
}
// 逻辑行列经 TableMap 转成绝对单元格起点，正确处理合并单元格占多个逻辑列的情况。
const tableCellPos = (editor, row, column) => {
  const { node, pos } = nodeAt(editor, "table")
  const map = TableMap.get(node)
  return pos + 1 + map.map[row * map.width + column]
}
// 明确使用合成 CellSelection 覆盖多格目标，不将程序化选区当作物理拖选行为。
const selectCells = (editor, fromRow, fromColumn, toRow = fromRow, toColumn = fromColumn) => editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, tableCellPos(editor, fromRow, fromColumn), tableCellPos(editor, toRow, toColumn))))
// 遍历实际单元格/表头节点而非逻辑重复格位，让多格属性断言逐真实节点核对。
const cells = editor => {
  const items = []
  nodeAt(editor, "table").node.descendants(node => { if (["tableCell", "tableHeader"].includes(node.type.name)) items.push(node) })
  return items
}
const image = editor => nodeAt(editor, "image").node.attrs
// 颜色比较先经浏览器 CSS 规范化，使 HEX 与 rgb 展示形式不影响真实视觉等价判断。
const color = value => { const element = document.createElement("span"); element.style.color = value; return element.style.color }
// 往返保存仅比对表格行/格与图片节点属性，聚焦精细设置存储契约，避免无关正文字段干扰。
const settingsShape = content => {
  const values = []
  const visit = node => {
    if (["tableCell", "tableHeader", "tableRow", "image"].includes(node.type)) values.push({ type: node.type, attrs: node.attrs })
    node.content?.forEach(visit)
  }
  visit(content)
  return JSON.stringify(values)
}

// 完整 Workspace 确保上下文标签、图片加载、弹窗目标跟踪和 FileActions 共享生产会话。
function PrecisionProbe({ onContext, onRecordChange }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onContext(context) }, [context, onContext])
  return <EditorWorkspace onDocumentChange={onRecordChange} />
}

// 同 ID 重开也增加 key 序号，正文 editor、目标映射监听和临时 URL 都独立于旧会话。
function PrecisionSession({ initialRecord, onContext, onRecord }) {
  const [session, setSession] = useState({ record: initialRecord, id: 0 })
  const changeRecord = record => {
    onRecord(record)
    setSession(previous => ({ record, id: previous.id + 1 }))
  }
  return <EditorProvider key={`${session.record.document.id}:${session.id}`} record={session.record}>
    <PrecisionProbe onContext={onContext} onRecordChange={changeRecord} />
  </EditorProvider>
}

/**
 * M11 使用真实 Provider、EditorWorkspace、FileActions 与 Ant Design 弹窗；输入经过 React
 * 原生事件链。CellSelection/NodeSelection 是明确标记的合成选区，不冒充物理鼠标或 IME。
 * 每项失败后卸载本项会话并继续；本轮随机文档/模板 ID 精确清理，不清空任何用户数据。
 */
export async function runPrecisionSettingsChecks(report = () => {}) {
  // records/templates 分别追踪本轮精确 ID/版本，测试宿主保持可见宽度供真实布局测量。
  const prefix = `精细设置验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const records = new Map()
  const templates = new Map()
  const results = []
  const host = document.createElement("div")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:900px;margin:24px 0"
  document.body.append(host)
  let current = null
  const track = record => { records.set(record.document.id, { document: record.document, assets: record.assets || new Map() }); return record }
  // 先卸载资源与保存所有者，再等图表弹窗 portal 消失；上一项草稿不进入下一项查询。
  const unmount = async () => {
    ReactDOM.unmountComponentAtNode(host)
    current = null
    await waitFor(() => !dialog("表格设置") && !dialog("图片设置"), "精细设置弹窗没有随会话卸载")
  }
  // 从 Blob 分配本轮会话 URL，等待正文/Context 目标匹配，再固定原始缩放便于像素断言。
  const mount = async record => {
    await unmount()
    record.assets.forEach(asset => { asset.url = createDocumentAssetUrl(asset) })
    ReactDOM.render(<PrecisionSession initialRecord={record} onContext={context => { current = context }} onRecord={track} />, host)
    const context = await waitFor(() => current?.editor && current.documentId === record.document.id && byLabel(host, "文档正文") && current, "精细设置真实编辑器未就绪")
    context.store.getState().updateView({ activeTab: "插入", outlineOpen: false, fitWidth: false, zoom: 1 })
    return context
  }
  // 生成宽高 2:1 的真实 PNG，让比例锁定/恢复断言基于实际 naturalWidth/naturalHeight。
  const canvas = document.createElement("canvas")
  canvas.width = 240
  canvas.height = 120
  canvas.getContext("2d").fillRect(0, 0, 240, 120)
  const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
  // 每项使用独立资源 ID 与已落盘 fixture，图片引用与表格属性可在保存、历史、模板和便携文件间核对。
  const seed = async (name, merged = false) => {
    const assetId = `precision-${Math.random().toString(16).slice(2, 12)}`
    const asset = { id: assetId, fileName: "精细设置.png", mimeType: png.type, byteLength: png.size, blob: png }
    const assets = new Map([[assetId, asset]])
    const document = { ...createDocument(), title: `${prefix}-${name}`, content: { type: "doc", content: [paragraph("来源批注与正文保持不变"), tableFixture(merged), { type: "image", attrs: { assetId, width: 240, height: 120 } }, paragraph("继续编辑的位置")] }, assets: [{ id: assetId, fileName: asset.fileName, mimeType: asset.mimeType, byteLength: asset.byteLength }] }
    track({ document, assets })
    const saved = await saveLocalDocument(document, assets, 0)
    return { id: document.id, document, assets, storageVersion: saved.storageVersion }
  }
  // 先建立指定逻辑单元格范围再打开真实表格设置，覆盖混合读取和打开时目标捕获。
  const openTable = async (editor, row = 0, column = 0, endRow = row, endColumn = column) => {
    current.store.getState().updateView({ activeTab: "表格" })
    selectCells(editor, row, column, endRow, endColumn)
    const control = await waitFor(() => button(host, "表格设置")?.disabled === false && button(host, "表格设置"), "表格设置入口不可用")
    control.click()
    return waitFor(() => field(dialog("表格设置"), "水平内边距") && dialog("表格设置"), "表格设置弹窗未打开")
  }
  // 用明确 NodeSelection 选中图片，真实按钮创建映射目标；不直接把图片属性注入弹窗草稿。
  const openImage = async editor => {
    current.store.getState().updateView({ activeTab: "插入" })
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, nodeAt(editor, "image").pos)))
    const control = await waitFor(() => button(host, "图片设置")?.disabled === false && button(host, "图片设置"), "图片设置入口不可用")
    control.click()
    return waitFor(() => field(dialog("图片设置"), "图片宽度") && dialog("图片设置"), "图片设置弹窗未打开")
  }
  // 表格与图片共享等待提交按钮和成功关闭的测试契约，各自仍走生产校验/命令实现。
  const apply = async name => {
    const control = button(dialog(name), name === "表格设置" ? "应用设置" : "保存设置")
    assert(control && !control.disabled, "精细设置提交按钮不可用")
    control.click()
    await waitFor(() => !dialog(name), "应用精细设置后弹窗未关闭")
  }
  // 受控输入更新后等待 React 同步，避免立即提交读到旧尺寸或颜色草稿。
  const put = async (name, label, value) => { setInput(field(dialog(name), label), value); await delay() }
  // 比例复选框仅在目标值不同才点击，验证双向联动而不是无意多次切换。
  const setLock = async value => {
    const element = field(dialog("图片设置"), "锁定宽高比例")
    assert(element?.type === "checkbox", "图片锁定比例复选框不存在")
    if (element.checked !== value) element.click()
    await delay()
  }
  // 精细设置完成后继续编辑正文，确认失败/只读恢复不会留下锁或错误的焦点状态。
  const keepEditing = editor => {
    const end = editor.state.doc.content.size - 1
    editor.commands.insertContentAt(end, "验收后可继续输入")
    assert(editor.getText().includes("验收后可继续输入"), "精细设置流程结束后无法继续编辑")
  }
  // 每项独立记录结果并卸载会话；失败不遮蔽后续图片、表格或保存规则的诊断。
  const check = async (name, run) => {
    try { await run(); const result = { name, passed: true }; results.push(result); report(result) }
    catch (error) { const result = { name, passed: false, error: error.message }; results.push(result); report(result) }
    finally { await unmount() }
  }
  try {
    // 混合值只代表当前选区差异；用户未触碰的字段必须逐格保留，整表边框则覆盖全表。
    await check("精细设置：多单元格混合值保留，底色/垂直/边框一次应用且单次撤销重做", async () => {
      const { editor } = await mount(await seed("多格混合"))
      const commentId = addDocumentComment(editor, TextSelection.create(editor.state.doc, 1, 5), "精细设置不能删除来源批注")
      const original = JSON.stringify(editor.getJSON())
      const text = editor.getText()
      const panel = await openTable(editor, 0, 0, 0, 1)
      assert(field(panel, "水平内边距").value === "", "混合内边距没有以空值呈现")
      await put("表格设置", "背景颜色", "#aabbcc")
      await choose(panel, "垂直对齐", "居中")
      await put("表格设置", "边框颜色", "#334455")
      await put("表格设置", "边框粗细", 3)
      await choose(panel, "边框线型", "虚线")
      editor.view.dispatch(closeHistory(editor.state.tr))
      await apply("表格设置")
      const updated = JSON.stringify(editor.getJSON())
      const nodes = cells(editor)
      assert(nodes[0].attrs.paddingX === 3 && nodes[1].attrs.paddingX === 17, "未修改的混合内边距被统一覆盖")
      assert(nodes.slice(0, 2).every(node => node.attrs.backgroundColor === "#aabbcc" && node.attrs.verticalAlign === "middle") && nodes[2].attrs.backgroundColor === null, "单元格设置越过选区或没有应用")
      assert(nodes.every(node => node.attrs.borderColor === "#334455" && node.attrs.borderWidth === 3 && node.attrs.borderStyle === "dashed"), "整表边框没有覆盖全部单元格")
      const domCell = editor.view.dom.querySelector("td")
      assert(getComputedStyle(domCell).backgroundColor === color("#aabbcc") && getComputedStyle(domCell).verticalAlign === "middle" && getComputedStyle(domCell).paddingLeft === "3px", "正文 DOM 没有呈现单元格样式")
      assert(editor.commands.undo() && JSON.stringify(editor.getJSON()) === original, "一次撤销未恢复所有精细设置")
      assert(editor.commands.redo() && JSON.stringify(editor.getJSON()) === updated, "一次重做没有恢复完整设置")
      assert(editor.getText() === text && getCommentEntries(editor.state.doc)[0].id === commentId, "精细设置改写了正文或批注锚点")
      keepEditing(editor)
    })
    // 用未合并行选择逻辑 B 列，验证同一列在 colspan 单元格内的对应 colwidth 同步改变。
    await check("精细设置：合并单元格逻辑列宽一致，行高与零内边距可应用并恢复自动", async () => {
      const { editor, assets } = await mount(await seed("合并列", true))
      await openTable(editor, 1, 1)
      const before = JSON.stringify(editor.getJSON())
      await put("表格设置", "选中列宽", 260)
      await put("表格设置", "选中行最小高度", 84)
      await put("表格设置", "水平内边距", 0)
      await put("表格设置", "垂直内边距", 0)
      await apply("表格设置")
      const table = nodeAt(editor, "table").node
      assert(JSON.stringify(table.child(0).child(0).attrs.colwidth) === "[110,260]" && table.child(1).child(1).attrs.colwidth[0] === 260, "合并单元格内的逻辑 B 列宽没有同步")
      assert(table.child(0).child(1).attrs.colwidth[0] === 180 && table.child(1).child(0).attrs.colwidth[0] === 110, "列宽设置污染了其他逻辑列")
      assert(table.child(0).attrs.minHeight === 44 && table.child(1).attrs.minHeight === 84, "行高没有限制到选中行")
      const rows = editor.view.dom.querySelectorAll("tr")
      const selected = rows[1].querySelectorAll("td")[1]
      assert(rows[1].getBoundingClientRect().height >= 83 && getComputedStyle(selected).paddingLeft === "0px" && getComputedStyle(selected).paddingTop === "0px", "正文没有呈现行高或零内边距")
      const updated = JSON.stringify(editor.getJSON())
      assert(editor.commands.undo() && JSON.stringify(editor.getJSON()) === before && editor.commands.redo() && JSON.stringify(editor.getJSON()) === updated, "列宽、行高、内边距没有共同单次撤销重做")
      await openTable(editor, 1, 1)
      button(dialog("表格设置"), "自动行高").click()
      await apply("表格设置")
      assert(nodeAt(editor, "table").node.child(1).attrs.minHeight === null, "自动行高没有清除持久属性")
      await openTable(editor, 0, 0)
      await put("表格设置", "选中列宽", 210)
      await apply("表格设置")
      assert(JSON.stringify(nodeAt(editor, "table").node.child(0).child(0).attrs.colwidth) === "[210,210]" && nodeAt(editor, "table").node.child(1).child(0).attrs.colwidth[0] === 210 && nodeAt(editor, "table").node.child(1).child(1).attrs.colwidth[0] === 210, "选中合并单元格没有覆盖其全部逻辑列")
      // 真实浏览器 serializer 保留 none；直接使用原始 getHTML，不能为通过验收补写 fixture CSS。
      await openTable(editor, 0, 0)
      await put("表格设置", "边框粗细", 0)
      await put("表格设置", "边框颜色", "#000000")
      await choose(dialog("表格设置"), "边框线型", "无边框")
      await apply("表格设置")
      const originalHtml = editor.getHTML()
      assert(originalHtml.includes("border-style: none"), "真实浏览器 getHTML 已丢失无边框枚举")
      const pasted = new Editor({ element: document.createElement("div"),
        extensions: createExtensions(id => assets.get(id)?.url || "", id => assets.get(id)),
        content: cleanPastedHtml(originalHtml, (id, kind) => assets.has(id) && (assets.get(id).kind || "image") === kind)
      })
      try {
        assert(cells(pasted).every(node => node.attrs.borderStyle === "none" && node.attrs.borderWidth === 0 && node.attrs.borderColor === "#000000"), "真实浏览器无边框复制粘贴丢失 none、零宽或颜色")
        assert(JSON.stringify(pasted.getJSON()) === JSON.stringify(editor.getJSON()), "真实浏览器图表内部粘贴改变了合并、尺寸或精细外观")
      } finally { pasted.destroy() }
      keepEditing(editor)
    })
    // 浏览器内建 min/max 与业务校验共同保护数据，直接 submit 也不能绕过；修正后同会话可保存。
    await check("精细设置：非法图表尺寸拒绝写入，边界值修正后可继续编辑", async () => {
      const { editor } = await mount(await seed("输入边界"))
      await openTable(editor)
      const before = JSON.stringify(editor.getJSON())
      for (const [label, value] of [["水平内边距", 41], ["边框粗细", 7], ["选中列宽", 34], ["选中行最小高度", 1001]]) await put("表格设置", label, value)
      dialog("表格设置").querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await delay()
      assert(JSON.stringify(editor.getJSON()) === before && dialog("表格设置")?.querySelector('[role="alert"]'), "表格越界数值被写入正文")
      for (const [label, value] of [["水平内边距", 40], ["边框粗细", 6], ["选中列宽", 35], ["选中行最小高度", 1000]]) await put("表格设置", label, value)
      await apply("表格设置")
      assert(cells(editor)[0].attrs.paddingX === 40 && cells(editor)[0].attrs.borderWidth === 6 && nodeAt(editor, "table").node.child(0).attrs.minHeight === 1000, "合法表格边界值未能修正并应用")
      await openImage(editor)
      const beforeImage = JSON.stringify(editor.getJSON())
      await put("图片设置", "图片宽度", 20001)
      await put("图片设置", "图片高度", 0)
      button(dialog("图片设置"), "保存设置").click()
      await delay()
      assert(JSON.stringify(editor.getJSON()) === beforeImage && dialog("图片设置")?.querySelector('[role="alert"]'), "图片越界尺寸被写入正文")
      await put("图片设置", "图片宽度", 200)
      await put("图片设置", "图片高度", 100)
      await apply("图片设置")
      assert(image(editor).width === 200 && image(editor).height === 100, "非法图片草稿修正后不能继续保存")
      keepEditing(editor)
    })
    // 只读中保留用户尚未提交的草稿；即使直接 submit，也不能绕过真实可编辑状态检查。
    await check("精细设置：表格只读切换保留草稿并禁止提交，返回编辑可继续应用", async () => {
      const { editor, store } = await mount(await seed("表格只读"))
      await openTable(editor)
      await put("表格设置", "水平内边距", 23)
      const before = JSON.stringify(editor.getJSON())
      store.getState().updateView({ readOnly: true })
      await waitFor(() => !editor.isEditable && field(dialog("表格设置"), "水平内边距")?.matches(":disabled") && button(dialog("表格设置"), "应用设置")?.disabled, "只读没有禁用表格精细设置")
      dialog("表格设置").querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await delay()
      assert(JSON.stringify(editor.getJSON()) === before && field(dialog("表格设置"), "水平内边距").value === "23", "只读写入了表格或清空草稿")
      store.getState().updateView({ readOnly: false })
      await waitFor(() => editor.isEditable && !button(dialog("表格设置"), "应用设置")?.disabled, "返回编辑后表格提交仍不可用")
      await apply("表格设置")
      assert(cells(editor)[0].attrs.paddingX === 23, "返回编辑后没有应用保留的表格草稿")
      keepEditing(editor)
    })
    // 前方文档插入应映射书签；完整替换同位置、同外观表格也不能被认成原目标。
    // 前方插入可映射，原节点同位置替换必须失效；坐标相同不能作为目标仍相同的依据。
    await check("精细设置：表格弹窗跟随前方插入，目标表格同位置替换后拒绝旧草稿", async () => {
      const { editor } = await mount(await seed("表格书签"))
      await openTable(editor, 1, 1)
      await put("表格设置", "水平内边距", 29)
      editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.paragraph.create(null, editor.schema.text("前方新增段落"))))
      await apply("表格设置")
      assert(cells(editor)[4].attrs.paddingX === 29 && cells(editor)[0].attrs.paddingX === 3, "文档插入后表格书签偏移到了错误单元格")
      await openTable(editor, 1, 1)
      await put("表格设置", "水平内边距", 31)
      const { node, pos } = nodeAt(editor, "table")
      const transaction = editor.state.tr.replaceWith(pos, pos + node.nodeSize, editor.schema.nodeFromJSON(node.toJSON()))
      transaction.setSelection(CellSelection.create(transaction.doc, pos + 1 + TableMap.get(transaction.doc.nodeAt(pos)).map[4]))
      editor.view.dispatch(transaction)
      const before = JSON.stringify(editor.getJSON())
      button(dialog("表格设置"), "应用设置").click()
      await delay()
      assert(JSON.stringify(editor.getJSON()) === before && dialog("表格设置")?.querySelector('[role="alert"]')?.textContent.includes("删除或替换"), "旧表格弹窗没有明确拒绝替换后的目标")
      button(dialog("表格设置"), "取消")?.click()
      keepEditing(editor)
    })
    // 宽度和高度两方向均通过弹窗事件驱动锁定计算；解锁后检查 NodeView 实际矩形比。
    await check("精细设置：图片宽高双向锁定、自由拉伸、对齐与原始比例恢复", async () => {
      const { editor } = await mount(await seed("图片尺寸"))
      await openImage(editor)
      await put("图片设置", "图片宽度", 360)
      assert(Number(field(dialog("图片设置"), "图片高度").value) === 180, "锁定宽度没有联动高度")
      await put("图片设置", "图片高度", 100)
      assert(Number(field(dialog("图片设置"), "图片宽度").value) === 200, "锁定高度没有联动宽度")
      await put("图片设置", "替代文本", "替代说明")
      await put("图片设置", "图片说明", "图片标题说明")
      const before = JSON.stringify(editor.getJSON())
      await apply("图片设置")
      assert(image(editor).width === 200 && image(editor).height === 100 && image(editor).lockAspectRatio, "图片锁定尺寸没有写入节点")
      const saved = JSON.stringify(editor.getJSON())
      assert(editor.commands.undo() && JSON.stringify(editor.getJSON()) === before && editor.commands.redo() && JSON.stringify(editor.getJSON()) === saved, "图片精细设置不能单次撤销重做")
      await openImage(editor)
      await setLock(false)
      await put("图片设置", "图片宽度", 320)
      await put("图片设置", "图片高度", 70)
      await choose(dialog("图片设置"), "图片对齐", "右对齐")
      await apply("图片设置")
      const figure = editor.view.dom.querySelector("figure[data-document-image]")
      const rendered = figure.querySelector("img")
      await rendered.decode()
      assert(image(editor).width === 320 && image(editor).height === 70 && !image(editor).lockAspectRatio && figure.dataset.imageAlign === "right", "解锁宽高或图片对齐没有生效")
      const rect = rendered.getBoundingClientRect()
      assert(Math.abs(rect.width / rect.height - 320 / 70) < 0.03 && rendered.alt === "替代说明" && rendered.title === "图片标题说明", "NodeView 没有真实显示自由拉伸比例或说明")
      figure.style.maxWidth = "160px"
      const reduced = rendered.getBoundingClientRect()
      assert(reduced.width <= 161 && Math.abs(reduced.width / reduced.height - 320 / 70) < 0.03, "max-width 缩小没有同时按文档比例缩小高度")
      figure.style.maxWidth = ""
      await openImage(editor)
      button(dialog("图片设置"), "恢复原始比例").click()
      await delay()
      assert(Number(field(dialog("图片设置"), "图片宽度").value) / Number(field(dialog("图片设置"), "图片高度").value) === 2, "恢复原始比例未使用资源自然尺寸")
      await choose(dialog("图片设置"), "图片对齐", "居中")
      await apply("图片设置")
      assert(image(editor).width / image(editor).height === 2 && image(editor).align === "center", "图片原始比例或居中没有保存")
      keepEditing(editor)
    })
    await check("精细设置：图片只读切换保留草稿且禁写，返回编辑保存说明和尺寸", async () => {
      const { editor, store } = await mount(await seed("图片只读"))
      await openImage(editor)
      await put("图片设置", "图片宽度", 300)
      await put("图片设置", "图片说明", "只读切换必须保留的草稿")
      const before = JSON.stringify(editor.getJSON())
      store.getState().updateView({ readOnly: true })
      await waitFor(() => !editor.isEditable && field(dialog("图片设置"), "图片宽度")?.disabled && button(dialog("图片设置"), "保存设置")?.disabled, "只读没有禁用图片设置")
      dialog("图片设置").querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await delay()
      assert(JSON.stringify(editor.getJSON()) === before && field(dialog("图片设置"), "图片说明").value === "只读切换必须保留的草稿", "只读写入图片或清空草稿")
      store.getState().updateView({ readOnly: false })
      await waitFor(() => editor.isEditable && !button(dialog("图片设置"), "保存设置")?.disabled, "返回编辑后图片仍禁止写入")
      await apply("图片设置")
      assert(image(editor).width === 300 && image(editor).height === 150 && image(editor).title === "只读切换必须保留的草稿", "图片只读期间保留的草稿未能继续保存")
      keepEditing(editor)
    })
    // 节点位置移动合法；先删除再放回同 assetId 图片则属于新目标，旧窗口必须拒绝。
    // 同 assetId 的新图片也属于替换目标，旧草稿必须拒绝，不能仅凭资源 ID 判断节点身份。
    await check("精细设置：图片弹窗书签映射插入，删除后同资源替换拒绝旧草稿", async () => {
      const { editor } = await mount(await seed("图片书签"))
      await openImage(editor)
      await put("图片设置", "图片宽度", 280)
      editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.paragraph.create(null, editor.schema.text("移动图片起点"))))
      await apply("图片设置")
      assert(image(editor).width === 280 && image(editor).height === 140, "图片书签未跟随文档前方插入")
      await openImage(editor)
      await put("图片设置", "替代文本", "不能写进替换图片的旧草稿")
      const { node, pos } = nodeAt(editor, "image")
      const transaction = editor.state.tr.delete(pos, pos + node.nodeSize).insert(pos, editor.schema.nodeFromJSON(node.toJSON()))
      transaction.setSelection(NodeSelection.create(transaction.doc, pos))
      editor.view.dispatch(transaction)
      const before = JSON.stringify(editor.getJSON())
      button(dialog("图片设置"), "保存设置").click()
      await delay()
      assert(JSON.stringify(editor.getJSON()) === before && dialog("图片设置")?.querySelector('[role="alert"]')?.textContent.includes("删除或替换"), "同 assetId 替换图片没有明确拒绝旧弹窗草稿")
      button(dialog("图片设置"), "取消")?.click()
      keepEditing(editor)
    })
    // 保存、同 ID 新 Provider、历史、模板、portable 仅聚焦新属性，不重复这些专项的管理流程。
    await check("精细设置：真实保存同 ID 重开，以及历史/模板/portable 保留图表属性", async () => {
      const record = await seed("属性持久化", true)
      const context = await mount(record)
      const commentId = addDocumentComment(context.editor, TextSelection.create(context.editor.state.doc, 1, 5), "来源文档批注独立保留")
      await openTable(context.editor, 1, 0, 1, 1)
      await put("表格设置", "背景颜色", "#ffeeaa")
      await put("表格设置", "垂直内边距", 12)
      await put("表格设置", "选中行最小高度", 90)
      await put("表格设置", "边框粗细", 2)
      await apply("表格设置")
      await openImage(context.editor)
      await setLock(false)
      await put("图片设置", "图片宽度", 310)
      await put("图片设置", "图片高度", 80)
      await choose(dialog("图片设置"), "图片对齐", "居中")
      await put("图片设置", "图片说明", "持久化图片说明")
      await apply("图片设置")
      button(host, "保存").click()
      await waitFor(() => context.store.getState().revision === context.store.getState().savedRevision, "真实 FileActions 保存尚未完成")
      const persisted = await getLocalDocument(record.id)
      const expected = settingsShape(context.editor.getJSON())
      assert(settingsShape(persisted.document.content) === expected, "IndexedDB 丢失精细设置属性")
      const reopened = await mount({ ...persisted, assets: await getDocumentAssets(persisted.document) })
      assert(reopened.editor !== context.editor && reopened.documentId === record.id && settingsShape(reopened.editor.getJSON()) === expected && !reopened.editor.can().undo(), "同 ID 重开没有还原属性或重建会话历史")
      const version = await createDocumentVersion(record.id, reopened.getStorageVersion(), "精细设置检查点")
      assert(settingsShape((await getDocumentVersion(record.id, version.id)).version.document.content) === expected, "历史检查点丢失图表属性")
      const template = await createDocumentTemplate(record.id, reopened.getStorageVersion(), `${prefix}-属性模板`)
      templates.set(template.id, template.storageVersion)
      assert(settingsShape((await getDocumentTemplate(template.id)).template.document.content) === expected, "模板快照丢失图表属性")
      const instance = track(await instantiateDocumentTemplate(template.id, template.storageVersion))
      assert(settingsShape(instance.document.content) === expected && !getCommentThreads(instance.document.content).length && getCommentThreads(reopened.editor.state.doc)[0].id === commentId, "模板实例丢失属性或错误处理了来源批注")
      const portable = await createPortableFile(reopened.getSnapshot(), reopened.assets)
      const imported = await readPortableFile(new File([JSON.stringify(portable)], "precision.mewoc.json"))
      assert(settingsShape(imported.document.content) === expected && getCommentThreads(imported.document.content)[0].id === commentId && imported.assets.size === 1, "portable 往返丢失属性、批注或图片资源")
      keepEditing(reopened.editor)
      assert(await reopened.saveDocument(), "精细设置重开后不能继续保存")
    })
    // 静态 HTML 创建到真实 iframe 后读 computed style，避免把 JSON 存在误判为导出可见。
    await check("精细设置：独立 HTML 实际 DOM 保留底色/边框/内边距/行高及图片拉伸对齐", async () => {
      const context = await mount(await seed("HTML样式"))
      await openTable(context.editor, 1, 0)
      await put("表格设置", "背景颜色", "#ccddee")
      await choose(dialog("表格设置"), "垂直对齐", "底部")
      await put("表格设置", "水平内边距", 19)
      await put("表格设置", "垂直内边距", 14)
      await put("表格设置", "选中行最小高度", 95)
      await put("表格设置", "边框颜色", "#123456")
      await put("表格设置", "边框粗细", 4)
      await choose(dialog("表格设置"), "边框线型", "点线")
      await apply("表格设置")
      await openImage(context.editor)
      await setLock(false)
      await put("图片设置", "图片宽度", 320)
      await put("图片设置", "图片高度", 80)
      await choose(dialog("图片设置"), "图片对齐", "右对齐")
      await apply("图片设置")
      const frame = document.createElement("iframe")
      frame.style.cssText = "width:700px;height:500px;border:0"
      host.append(frame)
      try {
        frame.srcdoc = await createDocumentHtml(context.getSnapshot(), context.assets)
        const body = await waitFor(() => frame.contentDocument?.querySelector("article.mewoc-content img") && frame.contentDocument, "独立 HTML 没有装载实际正文")
        const selected = body.querySelectorAll("tr")[1].querySelector("td")
        const style = frame.contentWindow.getComputedStyle(selected)
        assert(style.backgroundColor === color("#ccddee") && style.verticalAlign === "bottom" && style.paddingLeft === "19px" && style.paddingTop === "14px", "HTML 单元格底色、垂直对齐或内边距没有可见输出")
        assert(style.borderTopColor === color("#123456") && style.borderTopWidth === "4px" && style.borderTopStyle === "dotted" && selected.parentElement.getBoundingClientRect().height >= 94, "HTML 边框或行高未真实呈现")
        const rendered = body.querySelector("article img")
        await rendered.decode()
        const rect = rendered.getBoundingClientRect()
        assert(Math.abs(rect.width / rect.height - 4) < 0.03 && !body.querySelector("[data-resize-handle]") && rendered.src.startsWith("data:image/png;"), "HTML 图片没有保留拉伸比例、资源或排除编辑手柄")
        assert(rendered.dataset.mewocImageAlign === "right" && rendered.style.marginLeft === "auto" && Math.abs(rect.right - rendered.parentElement.getBoundingClientRect().right) < 2, "HTML 没有保留右对齐呈现")
      } finally { frame.remove() }
      keepEditing(context.editor)
    })
  // 卸载后按已知模板版本与文档 ID 精确清理，释放 Canvas 与宿主；临时 URL 回收由 Provider/预览所有者承担。
  } finally {
    await unmount()
    for (const [id, version] of templates) await deleteDocumentTemplate(id, version)
    await removeVerificationDocuments([...records.values()])
    host.remove()
    canvas.width = 0
    canvas.height = 0
  }
  return results
}
