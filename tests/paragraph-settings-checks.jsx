/**
 * 段落精细设置浏览器验收贯通混合属性草稿、原段落映射、格式刷、持久化和实际 HTML 样式。
 * 正文选区为明确的合成 ProseMirror 选区，输入/表单/仓库使用真实生产路径；无论失败都精确清理 fixture。
 */
import { useEffect, useState } from "react"
import ReactDOM from "react-dom"
import { Editor } from "@tiptap/core"
import { AllSelection, TextSelection } from "@tiptap/pm/state"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentVersion, getDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"
import { createDocumentTemplate, deleteDocumentTemplate, getDocumentTemplate, instantiateDocumentTemplate } from "../src/pages/editor/tools/document-template-repository.js"
import { addDocumentComment, getCommentEntries, getCommentThreads } from "../src/pages/editor/tools/document-comments.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { removeVerificationDocuments } from "./browser-checks.js"

// 对照形状只提取四项段落契约字段，避免序列化中无关默认属性影响往返保存断言。
const KEYS = ["spaceBefore", "spaceAfter", "keepWithNext", "keepTogether"]
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const delay = () => new Promise(resolve => setTimeout(resolve, 40))
// 有界等待 React、portal 与仓库条件同步，异步断言读取支持 Promise，避免场景因回调缺失永久挂起。
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await delay()
  }
  throw new Error(message)
}
// 只读取可见工具与字段，隐藏标签稳定挂载的控件不能冒充当前可操作入口。
const visible = element => !!element?.getClientRects().length && !element.closest("[hidden]")
const byLabel = (host, label) => [...(host?.querySelectorAll(`[aria-label="${label}"]`) || [])].find(visible)
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(element => visible(element) && (element.getAttribute("aria-label") || element.textContent).replace(/\s/g, "") === name.replace(/\s/g, ""))
const dialog = () => [...document.querySelectorAll('[role="dialog"]')].find(element => element.querySelector(".ant-modal-title")?.textContent === "段落设置")
const field = label => byLabel(dialog(), label)
// 原生 value setter 与 input 事件触发真实受控草稿更新，允许保留空值/越界值直到提交校验。
const setInput = (element, value) => {
  assert(element, "段落设置输入控件不存在")
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, String(value))
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
// 原生 select 用实际 option 文案查值并发 change，随后等待草稿刷新，不直接调用组件回调。
const choose = async (label, text) => {
  const element = field(label)
  assert(element instanceof HTMLSelectElement, `${label}原生选择控件不存在`)
  const option = [...element.options].find(item => item.textContent === text)
  assert(option, `${label}没有${text}选项`)
  element.value = option.value
  element.dispatchEvent(new Event("change", { bubbles: true }))
  await delay()
}
const paragraph = (text, attrs = {}) => ({ type: "paragraph", attrs, content: [{ type: "text", text }] })
const paragraphValues = attrs => Object.fromEntries(KEYS.map(key => [key, attrs[key]]))
// 每次扫描当前文档重新读取段落/标题及坐标，正文事务移动后不沿用 fixture 初始位置。
const blocks = editor => {
  const items = []
  editor.state.doc.descendants((node, pos) => { if (["paragraph", "heading"].includes(node.type.name)) items.push({ node, pos }) })
  return items
}
const block = (editor, text) => {
  const item = blocks(editor).find(({ node }) => node.textContent.includes(text))
  assert(item, `没有“${text}”段落`)
  return item
}
// 构造跨段完整文字范围并派发真实 editor 事务，覆盖弹窗捕获后的段落目标，而非只设 DOM 高亮。
const select = (editor, fromText, toText = fromText) => {
  const from = block(editor, fromText)
  const to = block(editor, toText)
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from.pos + 1, to.pos + to.node.nodeSize - 1)))
}
// 实际正文 DOM 用于核对间距/分页 CSS，JSON 属性存在不等于浏览器已经呈现正确样式。
const domBlock = (editor, text) => [...editor.view.dom.querySelectorAll("p,h1,h2,h3")].find(element => element.textContent.includes(text))
// 组合标题、列表、引用、表格和代码，覆盖属性支持边界；开头不同显式值用于逐字段混合态验证。
const fixture = () => ({ type: "doc", content: [
  paragraph("混合正文需要保留", { spaceBefore: 6.5, spaceAfter: 3, keepWithNext: true, keepTogether: false }),
  { type: "heading", attrs: { level: 2, spaceBefore: 12, spaceAfter: 7, keepWithNext: false, keepTogether: true }, content: [{ type: "text", text: "混合标题需要保留" }] },
  { type: "bulletList", content: [{ type: "listItem", content: [paragraph("列表第一项")] }, { type: "listItem", content: [paragraph("列表第二项")] }] },
  { type: "blockquote", content: [paragraph("引用内的段落")] },
  { type: "table", content: [
    { type: "tableRow", content: ["格A", "格B"].map(text => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [120] }, content: [paragraph(text)] })) },
    { type: "tableRow", content: ["格C", "格D"].map(text => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [120] }, content: [paragraph(text)] })) }
  ] },
  { type: "codeBlock", attrs: { language: "plaintext" }, content: [{ type: "text", text: "代码块不支持段落分页属性" }] },
  paragraph("默认来源及继续编辑位置")
] })
// 递归抽取段落/标题级别和四属性，聚焦持久化契约，避免无关节点字段改变遮掩本项结果。
const settingsShape = content => {
  const values = []
  const visit = node => {
    if (["paragraph", "heading"].includes(node.type)) values.push({ type: node.type, level: node.attrs?.level, attrs: paragraphValues(node.attrs || {}) })
    node.content?.forEach(visit)
  }
  visit(content)
  return JSON.stringify(values)
}

// 渲染完整 Workspace 并暴露会话，使格式刷、弹窗与正文装饰都走真实组件事件链。
function ParagraphProbe({ onContext, onRecordChange }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onContext(context) }, [context, onContext])
  return <EditorWorkspace onDocumentChange={onRecordChange} />
}

// 额外会话序号保证同 ID 重开也隔离保存队列、选区书签和撤销栈。
function ParagraphSession({ initialRecord, onContext, onRecord }) {
  const [session, setSession] = useState({ record: initialRecord, id: 0 })
  const changeRecord = record => {
    onRecord(record)
    setSession(previous => ({ record, id: previous.id + 1 }))
  }
  return <EditorProvider key={`${session.record.document.id}:${session.id}`} record={session.record}>
    <ParagraphProbe onContext={onContext} onRecordChange={changeRecord} />
  </EditorProvider>
}

/**
 * M12 通过真实 Provider、EditorWorkspace、FileActions 和段落弹窗验证状态链；数字输入和
 * select 使用浏览器原生事件。选区由 ProseMirror 合成，不宣称覆盖物理鼠标或输入法行为。
 * 每项失败后继续后续项；所有文档和模板使用本轮随机身份，卸载后只按精确 ID 清理。
 */
export async function runParagraphSettingsChecks(report = () => {}) {
  // 本轮唯一标题与精确文档/模板表记录所有 fixture 身份，清理只作用于已创建数据。
  const prefix = `段落设置验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const records = new Map()
  const templates = new Map()
  const results = []
  const host = document.createElement("div")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:900px;margin:24px 0"
  document.body.append(host)
  let current = null
  const track = record => { records.set(record.document.id, { document: record.document, assets: record.assets || new Map() }); return record }
  // 先结束会话副作用，再等待段落 portal 销毁，旧草稿或目标不会影响下一场景。
  const unmount = async () => {
    ReactDOM.unmountComponentAtNode(host)
    current = null
    await waitFor(() => !dialog(), "段落弹窗没有随会话卸载")
  }
  // 等待真实正文和 Context 指向目标 ID 后固定视图参数，隔离缩放/工具栏偏好对样式断言的干扰。
  const mount = async record => {
    await unmount()
    ReactDOM.render(<ParagraphSession initialRecord={record} onContext={context => { current = context }} onRecord={track} />, host)
    const context = await waitFor(() => current?.editor && current.documentId === record.document.id && byLabel(host, "文档正文") && current, "段落设置真实编辑器未就绪")
    context.store.getState().updateView({ activeTab: "开始", outlineOpen: false, fitWidth: false, zoom: 1 })
    return context
  }
  // 真实写入基础 fixture 并保存 storageVersion，后续自动保存和历史/模板检查采用可靠源版本。
  const seed = async name => {
    const document = { ...createDocument(), title: `${prefix}-${name}`, content: fixture() }
    const assets = new Map()
    track({ document, assets })
    const saved = await saveLocalDocument(document, assets, 0)
    return { id: document.id, document, assets, storageVersion: saved.storageVersion }
  }
  // 选择原段落范围再点真实段落入口；表格上下文仍可手动切开始标签，保持同一正文选区。
  const open = async (editor, fromText = "混合正文", toText = fromText) => {
    if (fromText) select(editor, fromText, toText)
    // 表格选区会自动进入表格工具；段落设置明确使用开始入口，保留同一正文选区。
    current.store.getState().updateView({ activeTab: "开始" })
    const control = await waitFor(() => button(host, "段落设置")?.disabled === false && button(host, "段落设置"), "段落设置入口不可用")
    control.click()
    return waitFor(() => field("段前间距") && dialog(), "段落设置弹窗未打开")
  }
  // 输入事件后短等 React 草稿同步，让后续提交读取用户刚输入的数值而不是上帧值。
  const put = async (label, value) => { setInput(field(label), value); await delay() }
  // 等待实际提交按钮可用并点击，成功后必须关闭弹窗；不调用 applyParagraphSettings 绕过草稿规则。
  const apply = async () => {
    const control = button(dialog(), "应用段落设置")
    assert(control && !control.disabled, "应用段落设置按钮不可用")
    control.click()
    await waitFor(() => !dialog(), "应用段落设置后弹窗未关闭")
  }
  // 每条设置流程结束后实际继续插入正文，确认目标监听/禁写状态没有残留而锁住下一次输入。
  const keepEditing = editor => {
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "设置后继续输入")
    assert(editor.getText().includes("设置后继续输入"), "段落设置之后无法继续输入")
  }
  // 失败仍卸载本项并收集报告，继续后续规则；资源与仓库数据由最外层统一清理。
  const check = async (name, run) => {
    try { await run(); const result = { name, passed: true }; results.push(result); report(result) }
    catch (error) { const result = { name, passed: false, error: error.message }; results.push(result); report(result) }
    finally { await unmount() }
  }
  try {
    // 四字段分别汇总混合态，只修改前间距和段内分页，不应覆盖各段后间距或同页状态。
    await check("段落设置：跨段混合值只应用已改字段，正文批注保留且单次撤销重做", async () => {
      const { editor } = await mount(await seed("混合字段"))
      const id = addDocumentComment(editor, TextSelection.create(editor.state.doc, 1, 5), "段落外观不能改变这段原文")
      const before = JSON.stringify(editor.getJSON())
      const text = editor.getText()
      await open(editor, "混合正文", "混合标题")
      assert(field("段前间距").value === "" && field("段后间距").value === "", "跨段数字混合态没有留空")
      assert(field("与下段同页").selectedOptions[0].textContent.includes("混合") && field("段内不分页").selectedOptions[0].textContent.includes("混合"), "跨段分页混合态没有回显")
      await put("段前间距", 18.5)
      await choose("段内不分页", "开启")
      await apply()
      const first = block(editor, "混合正文").node.attrs
      const heading = block(editor, "混合标题").node.attrs
      assert(first.spaceBefore === 18.5 && heading.spaceBefore === 18.5 && first.keepTogether && heading.keepTogether, "修改字段没有应用到两段")
      assert(first.spaceAfter === 3 && heading.spaceAfter === 7 && first.keepWithNext === true && heading.keepWithNext === false, "未修改的混合字段被统一覆盖")
      const after = JSON.stringify(editor.getJSON())
      assert(editor.commands.undo() && JSON.stringify(editor.getJSON()) === before, "多段设置未单次完整撤销")
      assert(editor.commands.redo() && JSON.stringify(editor.getJSON()) === after, "多段设置未单次完整重做")
      assert(editor.getText() === text && getCommentEntries(editor.state.doc)[0].id === id && !getCommentEntries(editor.state.doc)[0].orphaned, "段落设置改写正文或丢失批注")
      keepEditing(editor)
    })
    // 0 与 false 是用户显式值；恢复默认则写回 null，沿用当前段落类型自己的默认外观。
    await check("段落设置：零间距与关闭分页区别默认值，恢复默认清除四项显式属性", async () => {
      const { editor } = await mount(await seed("零值与默认"))
      await open(editor)
      await put("段前间距", 0)
      await put("段后间距", 0)
      await choose("与下段同页", "关闭")
      await choose("段内不分页", "关闭")
      await apply()
      assert(JSON.stringify(paragraphValues(block(editor, "混合正文").node.attrs)) === JSON.stringify({ spaceBefore: 0, spaceAfter: 0, keepWithNext: false, keepTogether: false }), "零值或 false 被替换成默认")
      const rendered = domBlock(editor, "混合正文")
      assert(getComputedStyle(rendered).marginTop === "0px" && getComputedStyle(rendered).marginBottom === "0px", "显式零间距没有呈现")
      await open(editor)
      button(dialog(), "恢复默认").click()
      await delay()
      assert(field("段前间距").value === "" && field("段后间距").value === "" && field("与下段同页").selectedOptions[0].textContent === "默认", "恢复默认没有重置草稿")
      await apply()
      assert(KEYS.every(key => block(editor, "混合正文").node.attrs[key] === null), "恢复默认未清除四项持久属性")
      assert(domBlock(editor, "混合正文").style.marginTop === "" && domBlock(editor, "混合正文").style.marginBottom === "", "默认间距仍残留内联 CSS")
      keepEditing(editor)
    })
    // 全选包括标题、列表、引用、表格内的 paragraph；CellSelection 后仅改选中列里的段落。
    await check("段落设置：标题/列表/引用/表格全选正确，表格不连续 CellSelection 限定范围", async () => {
      const { editor } = await mount(await seed("类型与表格范围"))
      const before = JSON.stringify(editor.getJSON())
      editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
      await open(editor, null)
      await put("段后间距", 8.5)
      await choose("段内不分页", "开启")
      await apply()
      assert(blocks(editor).every(({ node }) => node.attrs.spaceAfter === 8.5 && node.attrs.keepTogether === true), "全选遗漏标题、列表、引用或表格段落")
      let code = null
      editor.state.doc.descendants(node => { if (node.type.name === "codeBlock") code = node })
      assert(code && KEYS.every(key => !(key in code.attrs)), "全选把段落设置写进代码块")
      assert(editor.commands.undo() && JSON.stringify(editor.getJSON()) === before, "全选设置不能一步撤销")
      let table = null
      editor.state.doc.descendants((node, pos) => { if (node.type.name === "table") table = { node, pos } })
      const map = TableMap.get(table.node)
      editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, table.pos + 1 + map.map[0], table.pos + 1 + map.map[2])))
      await open(editor, null)
      await put("段前间距", 11.5)
      await choose("与下段同页", "关闭")
      await apply()
      for (const text of ["格A", "格C"]) assert(block(editor, text).node.attrs.spaceBefore === 11.5 && block(editor, text).node.attrs.keepWithNext === false, "选中单元格段落没有应用")
      for (const text of ["格B", "格D", "列表第一项", "引用内的段落"]) assert(block(editor, text).node.attrs.spaceBefore === null, "单元格选择污染了未选中段落")
      assert(block(editor, "混合标题").node.attrs.spaceBefore === 12, "表格设置改变了表外标题")
      assert(editor.commands.undo() && JSON.stringify(editor.getJSON()) === before, "CellSelection 段落设置未单次撤销")
      keepEditing(editor)
    })
    // 原生输入保留非法草稿，业务提交守卫拒绝；用户无需关闭窗口就能修正继续应用。
    await check("段落设置：负数/越界/非半点间距拒绝，修正 0 和 120 边界后继续编辑", async () => {
      const { editor } = await mount(await seed("非法草稿"))
      await open(editor)
      const before = JSON.stringify(editor.getJSON())
      for (const value of [-0.5, 120.5, 1.25]) {
        await put("段前间距", value)
        dialog().querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
        await delay()
        assert(JSON.stringify(editor.getJSON()) === before && dialog()?.querySelector('[role="alert"]'), `非法段前间距 ${value} 未被拒绝`)
      }
      await put("段前间距", 120)
      await put("段后间距", 0)
      await apply()
      assert(block(editor, "混合正文").node.attrs.spaceBefore === 120 && block(editor, "混合正文").node.attrs.spaceAfter === 0, "非法草稿修正后仍不能应用合法边界")
      keepEditing(editor)
    })
    // 禁写切换不能清空草稿，提交事件仍需实时拒绝；恢复编辑后沿原目标应用，不能改成新光标段落。
    await check("段落设置：只读与切换状态保留草稿且禁止提交，恢复编辑后应用", async () => {
      const { editor, store } = await mount(await seed("只读草稿"))
      await open(editor)
      await put("段前间距", 14.5)
      await choose("与下段同页", "关闭")
      const before = JSON.stringify(editor.getJSON())
      for (const key of ["readOnly", "switching"]) {
        store.getState().updateView({ [key]: true })
        await waitFor(() => !editor.isEditable && field("段前间距")?.matches(":disabled") && button(dialog(), "应用段落设置")?.disabled, `${key} 没有禁用段落设置`)
        dialog().querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
        await delay()
        assert(JSON.stringify(editor.getJSON()) === before && field("段前间距").value === "14.5" && field("与下段同页").selectedOptions[0].textContent === "关闭", `${key} 写入段落或丢失草稿`)
        store.getState().updateView({ [key]: false })
        await waitFor(() => editor.isEditable && !button(dialog(), "应用段落设置")?.disabled, `${key} 恢复后仍不能编辑`)
      }
      await apply()
      assert(block(editor, "混合正文").node.attrs.spaceBefore === 14.5 && block(editor, "混合正文").node.attrs.keepWithNext === false, "恢复编辑没有应用原草稿")
      keepEditing(editor)
    })
    // 原段起点插入文字和前方插入段落都合法；整段替换或删除后不能把旧草稿写给邻段。
    await check("段落设置：目标书签跟随插入，整段同位替换与删除拒绝旧草稿", async () => {
      const { editor } = await mount(await seed("目标书签"))
      await open(editor, "混合标题")
      await put("段后间距", 17.5)
      const heading = block(editor, "混合标题")
      editor.view.dispatch(editor.state.tr.insertText("起点文字", heading.pos + 1))
      editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodeFromJSON(paragraph("前方新增段落"))))
      await apply()
      assert(block(editor, "混合标题").node.attrs.spaceAfter === 17.5 && block(editor, "前方新增").node.attrs.spaceAfter === null, "段落书签没有跟随合法插入")
      for (const action of ["replace", "delete"]) {
        const label = action === "replace" ? "混合正文" : "替换后的新段落"
        await open(editor, label)
        await put("段前间距", 21)
        const target = block(editor, label)
        const transaction = action === "replace" ? editor.state.tr.replaceWith(target.pos, target.pos + target.node.nodeSize, editor.schema.nodeFromJSON(paragraph("替换后的新段落"))) : editor.state.tr.delete(target.pos, target.pos + target.node.nodeSize)
        transaction.setSelection(TextSelection.create(transaction.doc, target.pos + 1))
        editor.view.dispatch(transaction)
        const before = JSON.stringify(editor.getJSON())
        await waitFor(() => button(dialog(), "应用段落设置")?.disabled && dialog()?.querySelector('[role="alert"]'), "目标失效没有禁用旧草稿或说明原因")
        dialog().querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
        await delay()
        assert(JSON.stringify(editor.getJSON()) === before, "失效段落书签把草稿写到了新目标")
        button(dialog(), "取消").click()
        await waitFor(() => !dialog(), "失效段落弹窗取消失败")
      }
      keepEditing(editor)
    })
    // 格式刷传递显式值；从默认 paragraph 复制 null 时，标题仍是标题并恢复自己的默认。
    await check("段落设置：真实格式刷复制四属性，默认来源清除目标显式值且批注不丢", async () => {
      const { editor } = await mount(await seed("格式刷"))
      const openPaintMenu = async () => {
        const trigger = await waitFor(() => byLabel(host, "格式刷选项") && !byLabel(host, "格式刷选项").disabled && byLabel(host, "格式刷选项"), "格式刷选项入口不可用")
        trigger.click()
        // Popover 位于 document.body，必须从可见浮层读取，不能再在工具栏宿主内找旧按钮。
        return waitFor(() => trigger.getAttribute("aria-expanded") === "true" && button(document, "应用格式")?.disabled === false && button(document, "应用格式"), "格式刷菜单应用入口不可用")
      }
      const source = block(editor, "混合正文")
      const target = block(editor, "混合标题")
      const sourceId = addDocumentComment(editor, TextSelection.create(editor.state.doc, source.pos + 1, source.pos + 4), "保留来源批注")
      const targetId = addDocumentComment(editor, TextSelection.create(editor.state.doc, target.pos + 1, target.pos + 4), "保留目标批注")
      const before = JSON.stringify(editor.getJSON())
      select(editor, "混合正文")
      const copy = await waitFor(() => !byLabel(host, "格式刷")?.disabled && byLabel(host, "格式刷"), "真实格式刷入口不可用")
      copy.click()
      select(editor, "混合标题")
      const applyPaint = await openPaintMenu()
      applyPaint.click()
      assert(JSON.stringify(paragraphValues(block(editor, "混合标题").node.attrs)) === JSON.stringify(paragraphValues(block(editor, "混合正文").node.attrs)), "格式刷没有复制完整四属性")
      assert(block(editor, "混合标题").node.type.name === "heading" && block(editor, "混合标题").node.attrs.level === 2, "格式刷改变了目标标题类型")
      assert(getCommentEntries(editor.state.doc).some(entry => entry.id === sourceId && !entry.orphaned) && getCommentEntries(editor.state.doc).some(entry => entry.id === targetId && !entry.orphaned), "格式刷复制属性时丢失批注锚点")
      assert(editor.commands.undo() && JSON.stringify(editor.getJSON()) === before, "格式刷四属性不能完整单次撤销")
      select(editor, "默认来源")
      byLabel(host, "格式刷").click()
      select(editor, "混合标题")
      const resetPaint = await openPaintMenu()
      resetPaint.click()
      assert(KEYS.every(key => block(editor, "混合标题").node.attrs[key] === null) && block(editor, "混合标题").node.type.name === "heading", "默认来源没有清除显式属性或破坏标题默认类型")
      keepEditing(editor)
    })
    // 仅聚焦四属性存储契约，不重复历史和模板专项中的管理/恢复流程。
    await check("段落设置：真实保存同 ID 重开，历史/模板/portable 保留半点、零值和分页属性", async () => {
      const record = await seed("持久化")
      const context = await mount(record)
      const id = addDocumentComment(context.editor, TextSelection.create(context.editor.state.doc, 1, 5), "只属于来源文档")
      await open(context.editor)
      await put("段前间距", 0)
      await put("段后间距", 14.5)
      await choose("与下段同页", "关闭")
      await choose("段内不分页", "开启")
      await apply()
      button(host, "保存").click()
      await waitFor(() => context.store.getState().revision === context.store.getState().savedRevision, "FileActions 段落保存未完成")
      const persisted = await getLocalDocument(record.id)
      const expected = settingsShape(context.editor.getJSON())
      assert(settingsShape(persisted.document.content) === expected, "IndexedDB 丢失段落设置")
      const reopened = await mount({ ...persisted, assets: new Map() })
      assert(reopened.editor !== context.editor && reopened.documentId === record.id && settingsShape(reopened.editor.getJSON()) === expected && !reopened.editor.can().undo(), "同 ID 重开未恢复段落属性或未重建撤销会话")
      const version = await createDocumentVersion(record.id, reopened.getStorageVersion(), "段落精细属性")
      assert(settingsShape((await getDocumentVersion(record.id, version.id)).version.document.content) === expected, "历史丢失段落设置")
      const template = await createDocumentTemplate(record.id, reopened.getStorageVersion(), `${prefix}-属性模板`)
      templates.set(template.id, template.storageVersion)
      assert(settingsShape((await getDocumentTemplate(template.id)).template.document.content) === expected, "模板快照丢失段落属性")
      const instance = track(await instantiateDocumentTemplate(template.id, template.storageVersion))
      assert(settingsShape(instance.document.content) === expected && !getCommentThreads(instance.document.content).length && getCommentThreads(reopened.editor.state.doc)[0].id === id, "模板实例丢失段落属性或破坏来源批注")
      const portable = await createPortableFile(reopened.getSnapshot(), reopened.assets)
      const imported = await readPortableFile(new File([JSON.stringify(portable)], "paragraph.mewoc.json"))
      assert(settingsShape(imported.document.content) === expected && getCommentThreads(imported.document.content)[0].id === id, "portable 往返丢失段落设置或批注")
      keepEditing(reopened.editor)
      assert(await reopened.saveDocument(), "重新打开后的段落设置不能继续保存")
    })
    // 不只查 JSON：浏览器原始 getHTML 内部复制后重建 schema，再将独立 HTML 放到 iframe。
    await check("段落设置：内部 HTML 复制及独立 HTML 实际间距和分页样式完整保留", async () => {
      const context = await mount(await seed("HTML样式"))
      await open(context.editor)
      await put("段前间距", 0)
      await put("段后间距", 0)
      await choose("与下段同页", "关闭")
      await choose("段内不分页", "关闭")
      await apply()
      await open(context.editor, "混合标题")
      await put("段前间距", 18.5)
      await put("段后间距", 9)
      await choose("与下段同页", "开启")
      await choose("段内不分页", "开启")
      await apply()
      const pasted = new Editor({ element: document.createElement("div"), extensions: createExtensions(), content: cleanPastedHtml(context.editor.getHTML()) })
      try { assert(JSON.stringify(pasted.getJSON()) === JSON.stringify(context.editor.getJSON()), "内部 HTML 复制丢失显式零值、false、半点或分页属性") }
      finally { pasted.destroy() }
      const frame = document.createElement("iframe")
      frame.style.cssText = "width:700px;height:500px;border:0"
      host.append(frame)
      try {
        frame.srcdoc = await createDocumentHtml(context.getSnapshot(), context.assets)
        const body = await waitFor(() => frame.contentDocument?.querySelector("article.mewoc-content h2") && frame.contentDocument, "独立 HTML 没有装载段落正文")
        const paragraph = [...body.querySelectorAll("article p")].find(element => element.textContent.includes("混合正文"))
        const heading = body.querySelector("article h2")
        const paragraphStyle = frame.contentWindow.getComputedStyle(paragraph)
        const headingStyle = frame.contentWindow.getComputedStyle(heading)
        assert(paragraphStyle.marginTop === "0px" && paragraphStyle.marginBottom === "0px", "HTML 显式零间距未真实呈现")
        assert(Math.abs(parseFloat(headingStyle.marginTop) - 18.5 * 4 / 3) < 0.05 && Math.abs(parseFloat(headingStyle.marginBottom) - 12) < 0.05, "HTML 半点 pt 间距未真实呈现")
        assert(headingStyle.breakAfter === "avoid" && headingStyle.breakInside === "avoid" && heading.style.breakAfter === "avoid" && heading.style.breakInside === "avoid", "HTML 开启分页规则没有真实呈现 avoid 标志")
        assert(paragraphStyle.breakAfter === "auto" && paragraphStyle.breakInside === "auto" && paragraph.style.breakAfter === "auto" && paragraph.style.breakInside === "auto", "HTML false 分页规则没有显式覆盖默认")
      } finally { frame.remove() }
      keepEditing(context.editor)
    })
  // 卸载保存队列后删除本轮模板和精确文档 ID，最后移除宿主；避免延迟自动保存复活测试数据。
  } finally {
    await unmount()
    for (const [id, version] of templates) await deleteDocumentTemplate(id, version)
    await removeVerificationDocuments([...records.values()])
    host.remove()
  }
  return results
}
