/**
 * 正文聚焦和段落样式卡片的浏览器交互验收，使用真实 Provider/Workspace 检查状态与实际样式。
 * 验证标题应用、键盘扩展、失效/只读保护以及视图装饰不会进入保存和 HTML 输出。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import { TextSelection, NodeSelection } from "@tiptap/pm/state"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { saveLocalDocument, getLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentHtml } from "../src/pages/editor/tools/file-transfer.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const delay = () => new Promise(resolve => setTimeout(resolve, 40))
// 有界等待 React、编辑器 selection 与 DOM effect 同步，读取条件可异步，失败保留明确超时说明。
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay() }
  throw new Error(message)
}
const paragraph = (text, attrs = {}) => ({ type: "paragraph", attrs, content: [{ type: "text", text }] })
// fixture 同时包含正文、标题与代码块，分别验证可聚焦范围和样式应用支持边界。
const fixture = () => ({ type: "doc", content: [
  paragraph("聚焦第一段，保留精确间距。", { spaceAfter: 12.5, keepTogether: true }),
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "原有二级标题" }] },
  paragraph("继续编辑的第二段。"),
  { type: "codeBlock", attrs: { language: "plaintext" }, content: [{ type: "text", text: "代码不显示段落聚焦底色" }] },
  // 符合 StarterKit 的尾段约束，避免首个事务自动补正文影响本用例的纯焦点 revision 断言。
  paragraph("末尾继续输入位置")
] })
// 每次按当前文本重新找段落位置，避免前序样式转换后缓存 node/pos 产生过期测试坐标。
const findBlock = (editor, text) => {
  let result
  editor.state.doc.descendants((node, pos) => { if (node.isTextblock && node.textContent.includes(text)) result = { node, pos } })
  assert(result, `缺少段落：${text}`)
  return result
}
// 显式构造 ProseMirror 文字选区并聚焦正文；跨段覆盖完整目标内容，单段则使用光标。
const select = (editor, fromText, toText) => {
  const from = findBlock(editor, fromText)
  const to = toText ? findBlock(editor, toText) : from
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from.pos + 1, toText ? to.pos + to.node.nodeSize - 1 : from.pos + 1)))
  editor.view.focus()
}
// 探针取得会话服务并渲染完整 Workspace，让聚焦装饰和样式卡片走生产组件事件链。
function Probe({ onContext }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onContext(context) }, [context, onContext])
  return <EditorWorkspace onDocumentChange={() => {}} />
}

// 使用真实 Provider 和可见工具栏验证视图状态；合成选区覆盖状态链，物理键盘另外在完整页面核对。
export async function runEditorInteractionChecks(report = () => {}) {
  // 使用足够宽且可见的测试容器读取真实布局/伪元素，创建文档记录单独收集用于结束精确清理。
  const host = document.createElement("div")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:850px;margin:24px 0"
  document.body.append(host)
  const records = []
  let context
  // 查询器把常驻卡片和 portal 扩展卡片统一定位，避免把不同 DOM 根误当作不同样式会话。
  const picker = () => host.querySelector("[data-paragraph-style-picker]")
  const more = () => picker()?.querySelector('[aria-label="更多段落样式"]')
  const panel = () => document.getElementById(more()?.getAttribute("aria-controls"))
  const card = level => (level > 3 ? panel() : picker())?.querySelector(`[data-paragraph-style="${level}"]`)
  const cards = () => [...picker().querySelectorAll("[data-paragraph-style]"), ...(panel()?.querySelectorAll("[data-paragraph-style]") || [])]
  const focused = () => host.querySelectorAll(".mewoc-focused-paragraph")
  // 每个场景重建真实已保存文档与 Provider，隔离撤销历史、样式目标和 store revision。
  const mount = async () => {
    ReactDOM.unmountComponentAtNode(host)
    context = null
    const document = { ...createDocument(), title: `交互验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, content: fixture() }
    const assets = new Map()
    const saved = await saveLocalDocument(document, assets, 0)
    records.push({ document, assets })
    ReactDOM.render(<EditorProvider record={{ document, assets, storageVersion: saved.storageVersion }}><Probe onContext={value => { context = value }} /></EditorProvider>, host)
    await waitFor(() => context?.editor && picker(), "真实样式工具栏未就绪")
    context.store.getState().updateView({ activeTab: "开始", outlineOpen: false, zoom: 1 })
    return context
  }
  // 隐藏标题级别先经 UI 展开，再点击卡片；不绕过组件目标捕获和可编辑性检查。
  const apply = async level => {
    if (level > 3 && !card(level)) { more().click(); await waitFor(() => card(level), "未展开更多样式") }
    assert(card(level) && !card(level).disabled, `样式 ${level} 不可应用`)
    card(level).click()
    await delay()
  }
  // 场景失败仍卸载本次会话，避免旧 card/portal/保存队列影响后续场景，并继续汇总报告。
  const check = async (name, run) => {
    try { await mount(); await run(context); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
    finally { ReactDOM.unmountComponentAtNode(host) }
  }
  try {
    await check("交互：光标段落浅底跟随，跨段仅定位锚点且焦点不增加文档修改", async ({ editor, store }) => {
      const before = JSON.stringify(editor.getJSON())
      const revision = store.getState().revision
      select(editor, "聚焦第一段")
      await waitFor(() => focused().length === 1, "段落未显示聚焦底")
      const css = getComputedStyle(focused()[0], "::before")
      assert(css.backgroundColor === "rgb(245, 248, 252)" && css.borderRadius === "3px", "聚焦背景偏离参考颜色或圆角")
      assert(css.top === "-5px" && css.left === "-8px", "聚焦背景范围偏离参考")
      select(editor, "继续编辑", "聚焦第一段")
      await delay()
      assert(focused().length === 1 && focused()[0].textContent.includes("继续编辑"), "反向选区未跟随锚点段落")
      assert(JSON.stringify(editor.getJSON()) === before && store.getState().revision === revision, "焦点写入了正文或revision")
      const selection = getComputedStyle(editor.view.dom, "::selection")
      assert(selection.backgroundColor === "rgb(148, 207, 255)", "文字选区颜色未匹配参考")
    })
    await check("交互：失焦、只读、代码及节点选区不残留段落背景", async ({ editor, store }) => {
      select(editor, "聚焦第一段")
      await waitFor(() => focused().length === 1, "无聚焦段落")
      host.querySelector('[aria-label="文档标题"]').focus()
      await waitFor(() => focused().length === 0, "失焦后仍有聚焦底")
      select(editor, "代码不显示")
      await delay()
      assert(focused().length === 0, "代码块误加段落背景")
      const block = findBlock(editor, "聚焦第一段")
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, block.pos)))
      await delay()
      assert(focused().length === 0, "节点选区误加段落背景")
      select(editor, "聚焦第一段")
      store.getState().updateView({ readOnly: true })
      await waitFor(() => !editor.isEditable && !focused().length, "只读仍显示编辑聚焦背景")
    })
    await check("交互：预览卡片应用 H2/H6 后回到正文，间距保留且一次撤销", async ({ editor }) => {
      select(editor, "聚焦第一段")
      await delay()
      assert(card(0).getAttribute("aria-pressed") === "true", "正文卡片没有回显")
      const original = JSON.stringify(editor.getJSON())
      await apply(2)
      assert(findBlock(editor, "聚焦第一段").node.attrs.level === 2, "H2未应用")
      assert(editor.view.hasFocus(), "应用样式后没有回到正文")
      assert(card(2).getAttribute("aria-pressed") === "true", "H2卡片未回显")
      await apply(6)
      const result = findBlock(editor, "聚焦第一段").node
      assert(result.type.name === "heading" && result.attrs.level === 6 && result.attrs.spaceAfter === 12.5 && result.attrs.keepTogether === true, "H6丢失原段落精细属性")
      assert(more().getAttribute("aria-expanded") === "false", "应用后未收起扩展面板")
      editor.commands.undo()
      assert(findBlock(editor, "聚焦第一段").node.attrs.level === 2, "撤销跨越了本次样式操作")
      editor.commands.undo()
      assert(JSON.stringify(editor.getJSON()) === original, "两次撤销未恢复原文")
    })
    await check("交互：混合选区不假选中，统一样式保留选区文字与内容", async ({ editor }) => {
      select(editor, "聚焦第一段", "原有二级标题")
      const selectedText = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
      const text = editor.getText()
      await delay()
      assert(cards().every(element => element.getAttribute("aria-pressed") !== "true"), "混合样式误高亮单一卡片")
      await apply(3)
      assert(findBlock(editor, "聚焦第一段").node.attrs.level === 3 && findBlock(editor, "原有二级标题").node.attrs.level === 3, "未统一选中段落")
      assert(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) === selectedText && editor.getText() === text, "套用样式丢失选区或文字")
    })
    await check("交互：键盘可到达隐藏标题，Enter 应用与 Escape 收起恢复正文", async ({ editor }) => {
      select(editor, "聚焦第一段")
      card(0).focus()
      card(0).dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
      await waitFor(() => card(6) && document.activeElement === card(6), "键盘 End 未展开并定位 H6")
      card(6).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      await waitFor(() => findBlock(editor, "聚焦第一段").node.attrs.level === 6 && editor.view.hasFocus(), "键盘应用H6后未返回正文")
      const before = JSON.stringify(editor.getJSON())
      more().focus()
      more().click()
      await waitFor(() => more().getAttribute("aria-expanded") === "true", "键盘展开失败")
      more().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await waitFor(() => more().getAttribute("aria-expanded") === "false" && editor.view.hasFocus(), "Esc未收起并恢复正文")
      assert(JSON.stringify(editor.getJSON()) === before, "取消样式选择改动了正文")
    })
    await check("交互：展开期间只读禁写，关闭返回后仍可继续编辑", async ({ editor, store }) => {
      select(editor, "聚焦第一段")
      const press = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true })
      more().dispatchEvent(press)
      assert(!press.defaultPrevented, "展开按钮不应阻止原生焦点转移")
      more().focus()
      more().click()
      await waitFor(() => more().getAttribute("aria-expanded") === "true", "样式面板未打开")
      assert(!editor.view.hasFocus() && focused().length === 0, "展开样式面板后仍显示正文聚焦底")
      const original = JSON.stringify(editor.getJSON())
      store.getState().updateView({ switching: true })
      await waitFor(() => !editor.isEditable, "切换状态未生效")
      assert(cards().every(element => element.disabled), "只读仍能点样式")
      assert(JSON.stringify(editor.getJSON()) === original, "切换状态写入正文")
      store.getState().updateView({ switching: false })
      await waitFor(() => editor.isEditable, "未恢复编辑")
      select(editor, "继续编辑")
      editor.commands.insertContent("恢复后输入")
      assert(editor.getText().includes("恢复后输入"), "退出面板后无法继续输入")
    })
    await check("交互：列表结构不支持标题时明确提示，下一次可正常修改其他正文", async ({ editor }) => {
      editor.commands.setContent({ type: "doc", content: [
        { type: "bulletList", content: [{ type: "listItem", content: [paragraph("必须保持列表结构")] }] },
        paragraph("可以修改的新正文")
      ] })
      select(editor, "必须保持列表")
      await delay()
      await apply(2)
      assert(picker().querySelector('[role="alert"]')?.textContent.includes("结构"), "不支持的结构缺少提示")
      select(editor, "可以修改的新正文")
      await delay()
      await apply(3)
      assert(findBlock(editor, "可以修改的新正文").node.attrs.level === 3, "一次失败锁住了后续目标")
      assert(findBlock(editor, "必须保持列表").node.type.name === "paragraph", "失败后修改了原列表结构")
    })
    await check("交互：空文档聚焦时仍显示输入占位提示", async ({ editor }) => {
      editor.commands.clearContent()
      editor.commands.setTextSelection(1)
      editor.view.focus()
      await waitFor(() => focused().length === 1, "空段落未聚焦")
      assert(getComputedStyle(focused()[0], "::after").content.includes("在这里写下你的想法"), "聚焦背景覆盖了空白输入提示")
    })
    await check("交互：保存保留 H6，HTML 和快照不携带聚焦样式", async current => {
      const { editor } = current
      select(editor, "聚焦第一段")
      await apply(6)
      await waitFor(() => focused().length === 1, "H6没有聚焦反馈")
      assert(await current.saveDocument(), "保存失败")
      const record = await getLocalDocument(current.documentId)
      assert(record.document.content.content[0].attrs.level === 6, "保存未保留H6")
      const serialized = JSON.stringify(record.document)
      assert(!serialized.includes("mewoc-focused") && !editor.getHTML().includes("mewoc-focused"), "保存或HTML序列化含视图装饰")
      const html = await createDocumentHtml(current.getSnapshot(), current.assets)
      assert(html.includes("<h6") && !html.includes("mewoc-focused-paragraph") && !html.includes("data-paragraph-style-picker") && !html.includes("data-mewoc-editor-surface"), "静态导出携带编辑UI或丢失H6")
    })
  // 最终清理所有已知文档 ID 及宿主节点；先卸载保存所有者，再删除 fixture 仓库记录。
  } finally {
    ReactDOM.unmountComponentAtNode(host)
    host.remove()
    await removeVerificationDocuments(records)
  }
}
