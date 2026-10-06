/**
 * 批注浏览器验收连接真实正文、工具栏弹窗、侧栏、保存与历史恢复，验证锚点和线程生命周期。
 * 每项用随机身份隔离仓库数据，错误只影响当前场景；卸载会话后精确清理本轮文档。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import { closeHistory } from "@tiptap/pm/history"
import { TextSelection } from "@tiptap/pm/state"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentVersion, getDocumentVersion, getDocumentVersions, restoreDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"
import { addDocumentComment, focusDocumentComment, getCommentEntries, getCommentThreads, updateDocumentComment } from "../src/pages/editor/tools/document-comments.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
// 有界等待编辑器、AntD portal、保存和历史读取完成，支持异步仓库条件，超时反馈当前等待目标。
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}
// 只查询可见控件，稳定挂载但隐藏的工具栏不能充当本场景操作入口。
const visible = element => !!element?.getClientRects().length && !element.closest("[hidden]")
const byLabel = (host, label) => [...(host?.querySelectorAll(`[aria-label="${label}"]`) || [])].find(visible)
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(element => visible(element) && (element.getAttribute("aria-label") || element.textContent).replace(/\s/g, "") === name.replace(/\s/g, ""))
const dialog = () => document.querySelector('[role="dialog"] [aria-label="批注内容"]')?.closest('[role="dialog"]')
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
// 通过原生 textarea setter 和 input 事件走 React 受控链，避免仅改 DOM 值却未更新批注草稿。
const setInput = (element, value) => {
  assert(element, "批注输入框不存在")
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const preventRecordChange = () => {}

// 会话探针将就绪 Context 交给用例，同时渲染完整工作区，使正文装饰与批注面板同源更新。
function CommentsProbe({ onContext }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onContext(context) }, [context, onContext])
  return <EditorWorkspace onDocumentChange={preventRecordChange} />
}

/**
 * 在真实 Provider、工具栏和纸张上验证批注，不用独立命令替代有状态的弹窗流程。
 * 每轮只创建随机 fixture ID；卸载保存队列后按精确 ID 删除本轮 live/history 数据。
 */
export async function runDocumentCommentsChecks(report) {
  // 唯一前缀与精确 ID 清理表标识本轮 fixture，宿主使用真实可见尺寸供侧栏/焦点查询。
  const prefix = `批注验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const cleanup = new Map()
  const host = document.createElement("div")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:760px;margin:24px 0"
  document.body.append(host)
  let current = null
  // 先卸载 Provider 销毁保存队列和书签监听，再等待批注 portal 清除，避免场景之间遗留草稿。
  const unmount = async () => {
    ReactDOM.unmountComponentAtNode(host)
    current = null
    await waitFor(() => !dialog(), "批注弹窗卸载失败")
  }
  // 重建记录对应的真实会话，等待正文和批注入口都就绪后才选择或提交，避免抢在 useEditor 初始化前。
  const mount = async record => {
    await unmount()
    ReactDOM.render(<EditorProvider record={record}><CommentsProbe onContext={context => { current = context }} /></EditorProvider>, host)
    const context = await waitFor(() => current?.editor && current.documentId === record.document.id && byLabel(host, "文档正文") && current, "批注编辑会话未就绪")
    context.store.getState().updateView({ activeTab: "工具", outlineOpen: false, fitWidth: true })
    await waitFor(() => byLabel(host, "添加批注"), "工具中的批注入口未出现")
    return context
  }
  // 用真实仓库存初始正文并记住版本，保证后续保存/历史断言比较的是实际落盘路径。
  const seed = async (name, texts = ["第一段需要审阅的文字", "第二段也要一起保留"]) => {
    const document = { ...createDocument(), title: `${prefix}-${name}`, content: { type: "doc", content: texts.map(paragraph) } }
    const assets = new Map()
    cleanup.set(document.id, { document, assets })
    const saved = await saveLocalDocument(document, assets, 0)
    return { id: document.id, document, assets, storageVersion: saved.storageVersion }
  }
  // 保存后从 IndexedDB 重新读记录以验证持久化；当前 fixture 无资源，因此恢复时提供空集合。
  const load = async id => ({ ...await getLocalDocument(id), assets: new Map() })
  // 选中文字后经实际添加按钮打开弹窗，覆盖入口可用性、选区捕获和正文失焦的书签逻辑。
  const openAdd = async (context, from, to) => {
    context.store.getState().updateView({ activeTab: "工具" })
    context.editor.commands.setTextSelection({ from, to })
    const trigger = await waitFor(() => !byLabel(host, "添加批注")?.disabled && byLabel(host, "添加批注"), "选中文字后添加批注仍不可用")
    trigger.click()
    return waitFor(() => byLabel(dialog(), "批注内容"), "添加批注弹窗没有打开")
  }
  // 输入经 React 事件更新草稿后等待保存按钮可用，再确认并等待弹窗关闭。
  const saveDialog = async text => {
    setInput(await waitFor(() => byLabel(dialog(), "批注内容"), "批注弹窗没有输入框"), text)
    const save = await waitFor(() => !button(dialog(), "保存批注")?.disabled && button(dialog(), "保存批注"), "保存批注按钮不可用")
    save.click()
    await waitFor(() => !dialog(), "保存批注后弹窗未关闭")
  }
  const card = id => host.querySelector(`[data-comment-id="${id}"]`)
  // 批注与查找侧栏互斥，显式关闭查找让断言只读取当前批注列表。
  const openPanel = async context => {
    context.store.getState().updateView({ commentsOpen: true, searchOpen: false })
    return waitFor(() => byLabel(host, "批注面板"), "批注面板未打开")
  }
  // 每项独立报告并总是卸载本项会话，批注书签和撤销栈不会从失败场景传到下一项。
  const check = async (name, run) => {
    try { await run(); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
    finally { await unmount() }
  }
  try {
    await check("批注：上下标互换不会触发订阅循环比较，工具栏和侧栏继续响应", async () => {
      const context = await mount(await seed("文字标记订阅", ["H2O 与 x2 内容"]))
      const { editor } = context
      await openPanel(context)
      editor.commands.setTextSelection({ from: 2, to: 3 })
      for (let index = 0; index < 4; index += 1) {
        editor.commands[index % 2 ? "setSubscript" : "setSuperscript"]()
        await waitFor(() => byLabel(host, "添加批注") && byLabel(host, "批注面板"), "切换上下标后批注界面已崩溃")
        assert(!byLabel(host, "添加批注").disabled, "切换上下标后文字选区无法添加批注")
      }
      await openAdd(context, 2, 3)
      await saveDialog("上下标格式保留后的批注")
      const entry = getCommentEntries(editor.state.doc)[0]
      await waitFor(() => card(entry.id)?.textContent.includes("上下标格式保留后的批注"), "切换格式后批注侧栏没有更新")
      editor.commands.setSuperscript()
      await waitFor(() => card(entry.id), "已批注文字切换格式后侧栏崩溃")
      assert(getCommentEntries(editor.state.doc)[0].anchorText === "2", "格式切换改变了批注引用")
    })
    await check("批注：跨段选区通过真实弹窗创建，正文高亮与侧栏同步", async () => {
      const record = await seed("跨段")
      const context = await mount(record)
      const { editor } = context
      const body = editor.getText()
      const to = editor.state.doc.child(0).nodeSize + 5
      await openAdd(context, 3, to)
      assert(dialog().textContent.includes("选中的文字") && dialog().textContent.includes("第二段"), "弹窗没有展示跨段原文")
      await saveDialog("请补充这两段的事实依据。")
      const entry = getCommentEntries(editor.state.doc)[0]
      assert(entry && entry.ranges.length === 2 && entry.anchorText.includes("\n第二段"), "跨段批注锚点没有覆盖两段文字")
      await waitFor(() => card(entry.id)?.textContent.includes(entry.text), "批注面板没有显示新批注")
      assert(editor.view.dom.querySelectorAll(`[data-mewoc-comment-id="${entry.id}"]`).length === 2, "正文没有显示两段批注高亮")
      assert(editor.getText() === body && context.store.getState().commentsOpen && !context.store.getState().searchOpen, "添加批注改写了正文或未打开面板")
    })
    await check("批注：编辑、解决、筛选、重新打开和删除可撤销且不改正文", async () => {
      const context = await mount(await seed("侧栏操作"))
      const body = context.editor.getText()
      await openAdd(context, 1, 6)
      await saveDialog("待补充说明")
      const id = getCommentThreads(context.editor.state.doc)[0].id
      byLabel(card(id), "编辑批注").click()
      await saveDialog("已经补充具体修改建议")
      assert(getCommentThreads(context.editor.state.doc)[0].text === "已经补充具体修改建议", "编辑内容没有写入批注线程")
      byLabel(card(id), "解决批注").click()
      await waitFor(() => getCommentThreads(context.editor.state.doc)[0].resolved && card(id)?.textContent.includes("已解决"), "解决状态没有更新")
      byLabel(host, "待处理批注").click()
      await waitFor(() => !card(id) && host.textContent.includes("所有批注都已处理"), "待处理筛选仍显示已解决批注")
      byLabel(host, "已解决批注").click()
      await waitFor(() => card(id), "已解决筛选没有显示批注")
      byLabel(card(id), "重新打开批注").click()
      await waitFor(() => !card(id), "重新打开后批注仍停留在已解决筛选")
      byLabel(host, "全部批注").click()
      await waitFor(() => card(id) && byLabel(card(id), "解决批注"), "重新打开的批注未返回待处理")
      byLabel(card(id), "删除批注").click()
      await waitFor(() => !card(id), "删除批注未清理侧栏")
      assert(getCommentThreads(context.editor.state.doc).length === 0 && !context.editor.view.dom.querySelector("[data-mewoc-comment-id]"), "删除批注没有清理线程和正文锚点")
      assert(context.editor.commands.undo(), "删除批注无法撤销")
      await waitFor(() => card(id), "撤销删除未恢复批注卡片")
      const restored = getCommentThreads(context.editor.state.doc)[0]
      assert(restored.id === id && restored.text === "已经补充具体修改建议" && !restored.resolved && context.editor.getText() === body, "撤销没有恢复完整批注或正文被改写")
    })
    // 锚点位置随事务映射，原文完全删除仍保留线程供审阅；撤销后应恢复可定位锚点。
    await check("批注：原文插入删除映射锚点，整段删除保留批注并可撤销定位", async () => {
      const context = await mount(await seed("锚点跟随", ["前缀关联原文后缀"]))
      const { editor } = context
      const id = addDocumentComment(editor, TextSelection.create(editor.state.doc, 3, 7), "这段原文需要调整")
      assert(id, "测试批注没有创建")
      await openPanel(context)
      editor.view.dispatch(closeHistory(editor.state.tr))
      editor.commands.insertContentAt(1, "新增")
      let entry = getCommentEntries(editor.state.doc)[0]
      assert(entry.ranges[0].from === 5 && entry.anchorText === "关联原文", "前方插入后锚点没有移动到原文")
      byLabel(card(id), "定位批注").click()
      assert(editor.state.selection.from === entry.ranges[0].from && editor.state.selection.to === entry.ranges[0].to, "面板定位使用了旧坐标")
      editor.view.dispatch(closeHistory(editor.state.tr))
      editor.commands.deleteRange(entry.ranges[0])
      entry = getCommentEntries(editor.state.doc)[0]
      await waitFor(() => card(id)?.textContent.includes("原文已删除"), "原文删完后侧栏没有显示孤立状态")
      assert(entry.orphaned && entry.text === "这段原文需要调整" && byLabel(card(id), "定位批注").disabled, "孤立批注被丢弃或仍能定位")
      assert(editor.commands.undo(), "删除原文无法撤销")
      await waitFor(() => !byLabel(card(id), "定位批注")?.disabled, "撤销原文后批注仍不可定位")
      entry = getCommentEntries(editor.state.doc)[0]
      assert(!entry.orphaned && entry.anchorText === "关联原文" && focusDocumentComment(editor, id) && editor.state.selection.from === 5, "撤销原文未恢复批注锚点")
    })
    // 只读禁止线程写操作但允许查看/定位，未提交草稿不能因模式变化被清空，查看不应触发保存。
    await check("批注：只读切换保留未提交草稿，禁用写操作而查看定位不触发保存", async () => {
      const context = await mount(await seed("只读", ["已有批注和新的选区分开"]))
      const { editor, store } = context
      const id = addDocumentComment(editor, TextSelection.create(editor.state.doc, 1, 5), "原批注")
      await openPanel(context)
      const input = await openAdd(context, 8, 12)
      setInput(input, "只读切换时必须保留的草稿")
      store.getState().updateView({ readOnly: true })
      await waitFor(() => !editor.isEditable && byLabel(dialog(), "批注内容")?.disabled && button(dialog(), "保存批注")?.disabled, "只读没有禁止未提交弹窗写入")
      dialog().querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
      assert(getCommentThreads(editor.state.doc).length === 1 && byLabel(dialog(), "批注内容").value === "只读切换时必须保留的草稿", "只读提交仍新增批注或丢失输入")
      button(dialog(), "取消").click()
      await waitFor(() => !dialog(), "只读弹窗取消失败")
      for (const label of ["编辑批注", "解决批注", "删除批注"]) assert(byLabel(card(id), label)?.disabled, `只读仍允许${label}`)
      assert(byLabel(host, "添加批注").disabled && !byLabel(card(id), "定位批注").disabled, "只读入口或定位状态不正确")
      const revision = store.getState().revision
      const content = JSON.stringify(editor.getJSON())
      byLabel(card(id), "定位批注").click()
      assert(editor.state.selection.from === 1 && editor.state.selection.to === 5 && store.getState().revision === revision && JSON.stringify(editor.getJSON()) === content, "只读定位写入正文或触发保存")
    })
    await check("批注：真实保存和同 ID 重建保留线程，文档会话之间互不共享", async () => {
      const record = await seed("持久化")
      const context = await mount(record)
      await openAdd(context, 1, 6)
      await saveDialog("保存后重新打开仍要看得到")
      const id = getCommentThreads(context.editor.state.doc)[0].id
      assert(await context.saveDocument(), "批注正文保存失败")
      const persisted = await load(record.id)
      assert(getCommentThreads(persisted.document.content)[0].id === id, "IndexedDB 没有保存批注元数据")
      const reopened = await mount(persisted)
      await openPanel(reopened)
      assert(context.editor !== reopened.editor, "同 ID 重建复用了旧编辑器实例")
      // useEditor 为兼容 React 的重新挂载，下一 tick 才销毁旧实例；先等清理完成再核验生命周期。
      await waitFor(() => context.editor.isDestroyed, "旧编辑器卸载后未销毁")
      assert(!reopened.editor.can().undo(), "同 ID 重建沿用了旧正文撤销历史")
      assert(getCommentEntries(reopened.editor.state.doc)[0].id === id && card(id)?.textContent.includes("保存后重新打开仍要看得到"), "重新打开丢失批注或锚点")
      const other = await seed("隔离", ["另一份文档没有批注"])
      const isolated = await mount(other)
      assert(getCommentThreads(isolated.editor.state.doc).length === 0 && !isolated.store.getState().commentsOpen && !isolated.editor.view.dom.querySelector("[data-mewoc-comment-id]"), "批注或面板状态串到另一文档")
      assert(getCommentThreads((await getLocalDocument(record.id)).document.content)[0].id === id, "切换其他文档破坏了原批注记录")
    })
    await check("批注：历史检查点恢复旧线程，自动备份保留最新批注状态", async () => {
      const record = await seed("历史批注")
      const context = await mount(record)
      await openAdd(context, 1, 6)
      await saveDialog("初稿批注")
      const id = getCommentThreads(context.editor.state.doc)[0].id
      assert(await context.saveDocument(), "检查点前保存失败")
      const version = await createDocumentVersion(record.id, context.getStorageVersion(), "含初稿批注")
      assert(updateDocumentComment(context.editor, id, "恢复前最新批注"), "最新批注没有修改")
      assert(await context.saveDocument(), "最新批注没有保存")
      // 先卸载旧会话，恢复事务和新 Provider 使用恢复后的存储版本，避免旧保存队列覆盖历史结果。
      const storageVersion = context.getStorageVersion()
      await unmount()
      const restored = await restoreDocumentVersion(record.id, version.id, storageVersion)
      const reopened = await mount(restored)
      await openPanel(reopened)
      const thread = getCommentThreads(reopened.editor.state.doc)[0]
      assert(thread.id === id && thread.text === "初稿批注" && card(id)?.textContent.includes("初稿批注"), "历史恢复未恢复原批注线程和侧栏")
      const backup = (await getDocumentVersions(record.id)).find(item => item.reason === "before-restore")
      assert(backup && getCommentThreads((await getDocumentVersion(record.id, backup.id)).version.document.content)[0].text === "恢复前最新批注", "恢复前自动备份缺少最新批注")
      assert(!reopened.editor.can().undo() && reopened.getStorageVersion() === restored.storageVersion, "恢复后的保存版本或撤销会话未重建")
    })
    // 剪贴板中的批注身份必须剥离，避免复制出共享线程；清除普通文字格式则必须保留原批注。
    await check("批注：复制与 HTML 粘贴剥离旧 ID，清除文字格式保留原批注锚点", async () => {
      const context = await mount(await seed("复制与格式", ["批注原文与普通文字"]))
      const { editor } = context
      editor.commands.setTextSelection({ from: 1, to: 5 })
      editor.commands.toggleBold()
      const id = addDocumentComment(editor, editor.state.selection, "原文批注只有一条")
      assert(id, "带格式批注没有建立")
      const slice = editor.state.selection.content()
      const copied = editor.view.props.transformCopied(slice, editor.view)
      const pasted = editor.view.props.transformPasted(slice, editor.view, false)
      for (const item of [copied, pasted]) {
        let commentMarks = 0
        let boldMarks = 0
        item.content.descendants(node => { commentMarks += node.marks.filter(mark => mark.type.name === "commentAnchor").length; boldMarks += node.marks.filter(mark => mark.type.name === "bold").length })
        assert(!commentMarks && boldMarks > 0, "复制/粘贴剥离批注时丢失了其他文字格式或仍携带旧 ID")
      }
      const html = editor.getHTML()
      const before = getCommentEntries(editor.state.doc)[0]
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      assert(editor.view.pasteHTML(html), "HTML 粘贴没有经过编辑器输入通道")
      const after = getCommentEntries(editor.state.doc)[0]
      assert(getCommentThreads(editor.state.doc).length === 1 && after.ranges.length === before.ranges.length && after.anchorText === before.anchorText, "粘贴复用了原批注 ID 或扩张了锚点")
      assert(editor.getText().split("批注原文").length === 3, "HTML 粘贴没有保留正文")
      editor.commands.setTextSelection(before.ranges[0])
      context.store.getState().updateView({ activeTab: "开始" })
      const clear = await waitFor(() => byLabel(host, "清除文字格式"), "清除格式按钮未出现")
      clear.click()
      assert(getCommentEntries(editor.state.doc)[0].id === id && getCommentEntries(editor.state.doc)[0].anchorText === before.anchorText, "清除格式删除了批注锚点")
      let originalBold = false
      editor.state.doc.nodesBetween(before.ranges[0].from, before.ranges[0].to, node => { if (node.isText && node.marks.some(mark => mark.type.name === "bold")) originalBold = true })
      assert(!originalBold, "清除格式没有移除原文字加粗")
    })
    await check("批注：弹窗选区跟随正文变化，原选区删除后拒绝保存并保留草稿", async () => {
      const context = await mount(await seed("弹窗书签", ["前缀原文目标后缀"]))
      const { editor } = context
      await openAdd(context, 3, 7)
      setInput(byLabel(dialog(), "批注内容"), "书签应跟随前方插入")
      editor.commands.insertContentAt(1, "新增")
      await saveDialog("书签应跟随前方插入")
      const entry = getCommentEntries(editor.state.doc)[0]
      assert(entry.anchorText === "原文目标" && entry.ranges[0].from === 5, "弹窗提交使用了失效的原始坐标")
      const lastPosition = editor.state.doc.content.size - 1
      await openAdd(context, lastPosition - 2, lastPosition)
      setInput(byLabel(dialog(), "批注内容"), "原文删除后不要丢失这份输入")
      editor.commands.deleteRange({ from: lastPosition - 2, to: lastPosition })
      button(dialog(), "保存批注").click()
      await waitFor(() => dialog()?.querySelector('[role="alert"]'), "失效选区提交没有展示错误")
      assert(getCommentThreads(editor.state.doc).length === 1 && byLabel(dialog(), "批注内容").value === "原文删除后不要丢失这份输入", "失效选区仍创建批注或清空了输入")
      button(dialog(), "取消").click()
      await waitFor(() => !dialog(), "失效选区弹窗取消失败")
    })
  // 先卸载保存所有者再删除已知 fixture 文档/历史记录，避免延迟保存把测试记录重新写回。
  } finally {
    await unmount()
    host.remove()
    await removeVerificationDocuments([...cleanup.values()])
  }
}
