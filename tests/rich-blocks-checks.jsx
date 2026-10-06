/**
 * M19 富文本容器验收使用真实 Workspace、设置表单、IndexedDB 与独立 HTML。
 * 正文选区、按键和组合输入是明确的合成事件；不宣称覆盖物理鼠标或真实输入法候选操作。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import { Editor } from "@tiptap/core"
import { closeHistory } from "@tiptap/pm/history"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { getDocumentAssets, getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import {
  TEXT_BOX_DEFAULTS, DETAILS_DEFAULTS, captureBlockContainerInsertTarget, insertBlockContainerAtTarget,
  captureBlockContainerTarget, applyBlockContainerSettings, unwrapBlockContainer, exitBlockContainer
} from "../src/pages/editor/tools/block-containers.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { TOOLBAR_MODE_KEY, TOOLBAR_MODES } from "../src/pages/editor/tools/toolbar-preferences.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const delay = () => new Promise(resolve => setTimeout(resolve, 40))
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay() }
  throw new Error(message)
}
const visible = element => !!element?.getClientRects().length && !element.closest("[hidden]") && getComputedStyle(element).visibility !== "hidden"
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(element => visible(element)
  && (element.getAttribute("aria-label") || element.textContent).replace(/\s/g, "") === name.replace(/\s/g, ""))
const content = editor => JSON.stringify(editor.getJSON())
const text = (value, marks) => ({ type: "text", text: value, ...(marks && { marks }) })
const paragraph = (value = "", attrs = {}) => ({ type: "paragraph", attrs, ...(value && { content: [text(value)] }) })
const container = (type, body, attrs = type === "textBox" ? TEXT_BOX_DEFAULTS : DETAILS_DEFAULTS) => ({ type, attrs: { ...attrs }, content: body })
const nodes = (editor, type) => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === type) result.push({ node, pos }) })
  return result
}
const block = (editor, value) => {
  const result = [...nodes(editor, "paragraph"), ...nodes(editor, "heading")].find(({ node }) => node.textContent === value)
  assert(result, `没有“${value}”正文块`)
  return result
}
const selectBlock = (editor, value, offset = 1) => {
  const item = block(editor, value)
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, item.pos + offset)))
  editor.view.focus()
}
const selectContainer = (editor, type, index = 0, nodeSelection = false) => {
  const item = nodes(editor, type)[index]
  assert(item, `没有${type}容器`)
  editor.view.dispatch(editor.state.tr.setSelection(nodeSelection ? NodeSelection.create(editor.state.doc, item.pos)
    : TextSelection.near(editor.state.doc.resolve(item.pos + 1))))
  editor.view.focus()
  return item
}
const boxDom = editor => editor.view.dom.querySelector('[data-type="text-box"]')
const detailsDom = editor => editor.view.dom.querySelector("[data-details-view]")
const detailsToggle = editor => detailsDom(editor)?.querySelector("[data-details-toggle]")
const settingsDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(element => visible(element)
  && ["文本框设置", "折叠详情设置"].includes(element.querySelector(".ant-modal-title")?.textContent))
const field = name => settingsDialog()?.querySelector(`[aria-label="${name}"]`)
const setInput = (element, value) => {
  assert(element instanceof HTMLInputElement, "容器设置输入不存在")
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, String(value))
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const richBody = () => [
  { type: "heading", attrs: { level: 3, textAlign: "right", spaceBefore: 6.5 }, content: [text("详情内部标题")] },
  { type: "paragraph", attrs: { lineHeight: 2, spaceAfter: 7 }, content: [text("详情可检索正文", [{ type: "bold" }]), { type: "hardBreak" }, text("第二行说明")] },
  { type: "bulletList", content: [{ type: "listItem", content: [paragraph("容器内列表")] }] },
  { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("容器内已完成任务")] }] },
  { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph("容器内表格")] }] }] }
]
const richFixture = () => ({ type: "doc", content: [paragraph("容器之前"), container("textBox", richBody()),
  container("details", richBody(), { summary: "可折叠的详细内容" }), paragraph("容器之后")] })

function Probe({ onContext }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onContext(context) }, [context, onContext])
  return <EditorWorkspace onDocumentChange={() => {}} />
}

/** 本轮随机 ID 精确清理；每项排空保存并卸载，不修改用户文档、偏好或资源缓存。 */
export async function runRichBlocksChecks(report = () => {}) {
  const preferences = new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
  const records = new Map()
  const host = document.createElement("div")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:900px;margin:24px 0"
  document.body.append(host)
  let current = null
  const toolbar = () => host.querySelector("[data-toolbar-mode]")
  const activePanel = () => [...host.querySelectorAll('[role="tabpanel"]')].find(visible)
  const menuItem = name => [...document.querySelectorAll('[role="menuitemradio"]')].find(element => visible(element) && element.textContent === name)
  const switchMode = async mode => {
    if (toolbar().dataset.toolbarMode === mode) return
    button(host, "切换工具栏").click()
    const label = TOOLBAR_MODES.find(item => item.key === mode).label
    const item = await waitFor(() => menuItem(label), "容器验收工具栏模式菜单未打开")
    item.click()
    await waitFor(() => toolbar().dataset.toolbarMode === mode && !menuItem(label), "容器验收工具栏模式未切换")
  }
  const switchInsert = async () => {
    current.store.getState().updateView({ activeTab: "插入" })
    return waitFor(() => activePanel()?.getAttribute("aria-label") === "插入工具" && activePanel(), "插入工具未显示")
  }
  const unmount = async () => {
    if (current?.editor && !current.editor.isDestroyed) await current.saveDocument()
    ReactDOM.unmountComponentAtNode(host)
    current = null
    await waitFor(() => !settingsDialog(), "容器弹窗没有随会话卸载")
    await delay()
  }
  const mount = async record => {
    await unmount()
    localStorage.removeItem(TOOLBAR_MODE_KEY)
    localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    if (!record) {
      const document = { ...createDocument(), title: `富文本容器验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        content: { type: "doc", content: [paragraph("前半后半"), paragraph("后续位置")] } }
      const assets = new Map()
      const saved = await saveLocalDocument(document, assets, 0)
      record = { document, assets, storageVersion: saved.storageVersion }
      records.set(document.id, { document, assets })
    }
    ReactDOM.render(<EditorProvider record={record}><Probe onContext={context => { current = context }} /></EditorProvider>, host)
    await waitFor(() => current?.editor && current.documentId === record.document.id && toolbar(), "富文本容器 Workspace 未就绪")
    current.store.getState().updateView({ outlineOpen: false, searchOpen: false, fitWidth: false, zoom: 1, activeTab: "插入" })
    await switchInsert()
    return current
  }
  const openSettings = async (type, index = 0) => {
    selectContainer(current.editor, type, index)
    await switchInsert()
    const name = type === "textBox" ? "文本框设置" : "折叠详情设置"
    const trigger = await waitFor(() => button(activePanel(), name)?.disabled === false && button(activePanel(), name), `${name}入口不可用`)
    trigger.click()
    return waitFor(() => settingsDialog()?.querySelector("input") && settingsDialog(), `${name}没有打开`)
  }
  const put = async (name, value) => { setInput(field(name), value); await delay() }
  const submit = () => settingsDialog().querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  const apply = async () => {
    const trigger = button(settingsDialog(), "应用设置")
    assert(trigger && !trigger.disabled, "应用容器设置不可用")
    trigger.click()
    await waitFor(() => !settingsDialog(), "应用容器设置后没有关闭弹窗")
  }
  const check = async (name, run) => {
    try { await mount(); await run(current); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
    finally { await unmount() }
  }
  try {
    await check("富文本容器：两种模式在原光标插入并保留分段文字，一次撤销重做", async ({ editor }) => {
      for (const mode of ["ribbon", "compact"]) for (const type of ["textBox", "details"]) {
        await switchMode(mode)
        editor.commands.setContent({ type: "doc", content: [paragraph("前半后半"), paragraph("后续位置")] })
        selectBlock(editor, "前半后半", 3)
        await switchInsert()
        const before = content(editor)
        const trigger = await waitFor(() => button(activePanel(), type === "textBox" ? "插入文本框" : "插入折叠详情")?.disabled === false
          && button(activePanel(), type === "textBox" ? "插入文本框" : "插入折叠详情"), "容器插入入口不可用")
        // 按下后改选正文，click 仍必须命中按下时的书签，不能随新光标移动。
        trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
        selectBlock(editor, "后续位置")
        trigger.click()
        assert(nodes(editor, type).length === 1, `${mode}没有插入${type}`)
        const texts = [...editor.state.doc.content.content].filter(node => node.type.name === "paragraph").map(node => node.textContent)
        assert(texts.includes("前半") && texts.includes("后半") && texts.includes("后续位置"), "光标插入丢字或没有保持原分段位置")
        const after = content(editor)
        assert(editor.commands.undo() && content(editor) === before, "容器插入不是一次完整撤销")
        assert(editor.commands.redo() && content(editor) === after, "容器插入不是一次完整重做")
      }
    })

    await check("富文本容器：完整段落和标题包裹保留属性、文字格式与相邻正文", async ({ editor }) => {
      for (const type of ["textBox", "details"]) {
        editor.commands.setContent({ type: "doc", content: [
          { type: "paragraph", attrs: { lineHeight: 2, textAlign: "center", spaceBefore: 6.5 }, content: [text("原段落格式", [{ type: "bold" }, { type: "italic" }])] },
          { type: "heading", attrs: { level: 4, leftIndent: 2, keepWithNext: true }, content: [text("原标题格式", [{ type: "underline" }])] }, paragraph("未选择的尾段")
        ] })
        const first = block(editor, "原段落格式")
        const last = block(editor, "原标题格式")
        const originalBlocks = JSON.stringify([first.node.toJSON(), last.node.toJSON()])
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, first.pos + 1, last.pos + last.node.nodeSize - 1)))
        await switchInsert()
        const before = content(editor)
        const trigger = await waitFor(() => button(activePanel(), type === "textBox" ? "插入文本框" : "插入折叠详情")?.disabled === false
          && button(activePanel(), type === "textBox" ? "插入文本框" : "插入折叠详情"), "整段包裹入口不可用")
        trigger.click()
        assert(JSON.stringify(nodes(editor, type)[0].node.content.toJSON()) === originalBlocks, "包裹重建了原段落、标题或 marks")
        assert(block(editor, "未选择的尾段").node.type.name === "paragraph", "包裹修改了相邻未选正文")
        assert(editor.commands.undo() && content(editor) === before, "整段包裹不能一次撤销")
      }
    })

    await check("富文本容器：部分文字、列表、表格及已有容器中的插入入口禁用", async ({ editor }) => {
      editor.commands.setContent({ type: "doc", content: [...richFixture().content,
        { type: "bulletList", content: [{ type: "listItem", content: [paragraph("独立列表段落")] }] },
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph("独立表格段落")] }] }] }, paragraph("结构之后")] })
      const checkDisabled = async () => {
        await switchInsert()
        for (const label of ["插入文本框", "插入折叠详情"]) assert(button(activePanel(), label)?.disabled, `${label}接受了不支持的结构选区`)
      }
      const first = block(editor, "容器之前")
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, first.pos + 1, first.pos + 3)))
      await checkDisabled()
      for (const value of ["独立列表段落", "独立表格段落", "容器内列表", "容器内表格", "详情可检索正文第二行说明"]) {
        selectBlock(editor, value)
        await checkDisabled()
      }
      selectContainer(editor, "details", 0, true)
      await checkDisabled()
      selectBlock(editor, "容器之后")
      await switchInsert()
      await waitFor(() => button(activePanel(), "插入文本框")?.disabled === false && button(activePanel(), "插入折叠详情")?.disabled === false,
        "回到普通段落后插入入口没有恢复")
    })

    await check("文本框设置：无效数值拒绝，零值和上限真实呈现并可一次撤销", async ({ editor }) => {
      editor.commands.setContent(richFixture())
      const before = content(editor)
      await openSettings("textBox")
      for (const [name, value] of [["文本框边框宽度", -1], ["文本框边框宽度", 7], ["文本框边框宽度", 1.5], ["文本框边框宽度", ""]]) {
        await put(name, value)
        submit()
        await delay()
        assert(content(editor) === before && settingsDialog()?.querySelector('[role="alert"]'), `非法边框宽度 ${value} 没有拒绝`)
      }
      await put("文本框边框宽度", 6)
      for (const value of [-1, 41, 1.5, ""]) {
        await put("文本框内边距", value)
        submit()
        await delay()
        assert(content(editor) === before && settingsDialog()?.querySelector('[role="alert"]'), `非法内边距 ${value} 没有拒绝`)
      }
      await put("文本框内边距", 40)
      await put("文本框背景颜色", "#ffeeaa")
      await put("文本框边框颜色", "#123456")
      await apply()
      let css = getComputedStyle(boxDom(editor))
      assert(css.backgroundColor === "rgb(255, 238, 170)" && css.borderTopColor === "rgb(18, 52, 86)" && css.borderTopWidth === "6px" && css.paddingTop === "40px", "文本框设置只有 JSON 值而没有实际 CSS")
      assert(editor.commands.undo() && content(editor) === before, "文本框多字段设置没有一次撤销")
      await openSettings("textBox")
      await put("文本框边框宽度", 0)
      await put("文本框内边距", 0)
      await apply()
      css = getComputedStyle(boxDom(editor))
      assert(css.borderTopWidth === "0px" && css.paddingTop === "0px" && nodes(editor, "textBox")[0].node.attrs.padding === 0, "显式零值被恢复成默认外观")
    })

    await check("折叠详情设置：标题纯文字转义，空标题拒绝且 120 字边界保留", async ({ editor }) => {
      editor.commands.setContent(richFixture())
      await openSettings("details")
      const before = content(editor)
      await put("详情标题", "   ")
      submit()
      await delay()
      assert(content(editor) === before && settingsDialog()?.querySelector('[role="alert"]'), "空白详情标题没有拒绝")
      const title = "安全 <标题> & \"说明\""
      await put("详情标题", title)
      await apply()
      assert(nodes(editor, "details")[0].node.attrs.summary === title && detailsToggle(editor).textContent.includes(title), "详情标题没有按原文字显示")
      assert(!detailsToggle(editor).querySelector("标题"), "详情标题被解释为 HTML")
      const parsed = new DOMParser().parseFromString(editor.getHTML(), "text/html")
      assert(parsed.querySelector("details summary").textContent === title, "序列化没有正确转义详情标题")
      await openSettings("details")
      await put("详情标题", "长".repeat(120))
      await apply()
      assert(nodes(editor, "details")[0].node.attrs.summary.length === 120, "合法长标题被裁掉")
    })

    await check("折叠详情：收起展开与只读浏览不改正文、修改序号或撤销历史", async ({ editor, store }) => {
      editor.commands.setContent(richFixture())
      selectBlock(editor, "容器之后")
      const beforeInput = content(editor)
      editor.view.dispatch(closeHistory(editor.state.tr))
      editor.commands.insertContent("独立输入")
      editor.view.dispatch(closeHistory(editor.state.tr))
      const afterInput = content(editor)
      const revision = store.getState().revision
      selectContainer(editor, "details")
      detailsToggle(editor).click()
      assert(detailsDom(editor).dataset.expanded === "false" && detailsDom(editor).querySelector("[data-details-content]").hidden,
        "详情没有收起真实正文")
      assert(editor.state.selection instanceof NodeSelection, "收起后仍保留不可见的正文光标")
      store.getState().updateView({ readOnly: true })
      await waitFor(() => !editor.isEditable, "只读没有生效")
      detailsToggle(editor).click()
      assert(detailsDom(editor).dataset.expanded === "true", "只读模式不能展开详情")
      detailsToggle(editor).click()
      store.getState().updateView({ readOnly: false })
      await waitFor(() => editor.isEditable, "只读恢复失败")
      assert(content(editor) === afterInput && store.getState().revision === revision, "折叠浏览写入正文或修改序号")
      assert(editor.commands.undo() && content(editor) === beforeInput, "折叠浏览占用了独立正文输入的撤销步骤")
    })

    await check("折叠详情：直接选区、只读搜索和大纲导航均展开目标正文", async ({ editor, store }) => {
      editor.commands.setContent({ type: "doc", content: [paragraph("详情之前"), container("details", richBody()), paragraph("详情之后")] })
      const before = content(editor)
      const revision = store.getState().revision
      detailsToggle(editor).click()
      selectBlock(editor, "详情可检索正文第二行说明")
      assert(detailsDom(editor).dataset.expanded === "true", "文字选区进入折叠正文没有展开")
      detailsToggle(editor).click()
      store.getState().updateView({ searchOpen: true, readOnly: true })
      const searchInput = await waitFor(() => host.querySelector('input[aria-label="查找内容"]'), "真实查找面板未打开")
      setInput(searchInput, "详情可检索")
      await waitFor(() => editor.storage.findAndReplace.results.length === 1 && !editor.isEditable, "搜索未找到折叠正文")
      button(host, "下一处匹配").click()
      await waitFor(() => detailsDom(editor).dataset.expanded === "true", "只读搜索导航没有展开详情")
      assert(editor.state.selection instanceof TextSelection && editor.state.selection.from > nodes(editor, "details")[0].pos, "搜索光标未进入目标详情")
      store.getState().updateView({ readOnly: false, outlineOpen: true, searchOpen: false })
      await waitFor(() => editor.isEditable && host.querySelector('aside[aria-label="文档大纲"]'), "大纲未打开")
      detailsToggle(editor).click()
      button(host.querySelector('aside[aria-label="文档大纲"]'), "详情内部标题").click()
      await waitFor(() => detailsDom(editor).dataset.expanded === "true", "大纲导航没有展开详情内部标题")
      assert(content(editor) === before && store.getState().revision === revision, "导航折叠正文改写了文档")
    })

    await check("容器设置：原目标位置映射，改选其他容器不转移草稿且未改字段保留并发值", async ({ editor }) => {
      editor.commands.setContent({ type: "doc", content: [paragraph("前方文字"), container("textBox", [paragraph("原文本框正文")]),
        container("textBox", [paragraph("另一文本框正文")]), paragraph("结尾文字")] })
      await openSettings("textBox")
      await put("文本框内边距", 23)
      editor.commands.insertContentAt(1, "前方插入", { updateSelection: false })
      const original = nodes(editor, "textBox")[0]
      editor.view.dispatch(editor.state.tr.setNodeAttribute(original.pos, "borderColor", "#345678"))
      selectContainer(editor, "textBox", 1)
      const beforeApply = content(editor)
      await apply()
      const originalAttrs = nodes(editor, "textBox")[0].node.attrs
      const otherAttrs = nodes(editor, "textBox")[1].node.attrs
      assert(originalAttrs.padding === 23 && originalAttrs.borderColor === "#345678", "设置没命中原目标或覆盖了未触碰的并发属性")
      assert(otherAttrs.padding === TEXT_BOX_DEFAULTS.padding && otherAttrs.borderColor === TEXT_BOX_DEFAULTS.borderColor, "设置误写后来改选的容器")
      assert(editor.commands.undo() && content(editor) === beforeApply, "撤销设置同时撤掉此前输入或并发属性更新")
    })

    await check("容器设置：删除目标后撤销恢复不能复活旧草稿书签", async ({ editor }) => {
      editor.commands.setContent(richFixture())
      await openSettings("details")
      await put("详情标题", "不应提交的旧草稿")
      const original = nodes(editor, "details")[0]
      editor.view.dispatch(closeHistory(editor.state.tr.delete(original.pos, original.pos + original.node.nodeSize)))
      editor.view.dispatch(closeHistory(editor.state.tr))
      assert(editor.commands.undo() && nodes(editor, "details").length === 1, "测试无法撤销恢复详情")
      await delay()
      const restored = content(editor)
      assert(button(settingsDialog(), "应用设置").disabled && settingsDialog().querySelector('[role="alert"]'), "删除目标后旧草稿没有失效反馈")
      submit()
      await delay()
      assert(content(editor) === restored && nodes(editor, "details")[0].node.attrs.summary !== "不应提交的旧草稿", "撤销恢复复活了旧容器目标")
      button(settingsDialog(), "取消").click()
      await waitFor(() => !settingsDialog(), "失效草稿不能取消")
    })

    await check("容器编辑：只读、切换和组合输入守卫拒绝 UI/API 写入，设置草稿恢复后可提交", async ({ editor, store }) => {
      editor.commands.setContent(richFixture())
      for (const reason of ["readOnly", "switching", "composition"]) {
        selectContainer(editor, "textBox")
        const target = captureBlockContainerTarget(editor)
        selectBlock(editor, "容器之后")
        const insertTarget = captureBlockContainerInsertTarget(editor)
        await switchInsert()
        const before = content(editor)
        if (reason === "composition") {
          editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
          await waitFor(() => editor.view.composing, "合成组合输入未开始")
        } else {
          store.getState().updateView({ [reason]: true })
          await waitFor(() => !editor.isEditable && button(activePanel(), "插入文本框").disabled, "禁写状态没有同步工具栏")
        }
        const blocked = store.getState().readOnly || store.getState().switching
        assert(!insertBlockContainerAtTarget(editor, insertTarget, "textBox", TEXT_BOX_DEFAULTS, blocked).ok
          && !applyBlockContainerSettings(editor, target, { padding: 20 }, blocked).ok
          && !unwrapBlockContainer(editor, target, blocked).ok && !exitBlockContainer(editor, target, blocked).ok, `${reason}允许直接 API 写入`)
        const trigger = button(activePanel(), "插入折叠详情")
        trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
        trigger.click()
        assert(content(editor) === before, `${reason}允许工具栏写入`)
        if (reason === "composition") {
          editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
          await waitFor(() => !editor.view.composing, "合成组合输入未结束")
        } else {
          store.getState().updateView({ [reason]: false })
          await waitFor(() => editor.isEditable && !button(activePanel(), "插入文本框").disabled, "恢复编辑没有重新开放工具栏")
        }
      }
      await openSettings("textBox")
      await put("文本框内边距", 24)
      store.getState().updateView({ readOnly: true })
      await waitFor(() => field("文本框内边距").disabled && button(settingsDialog(), "应用设置").disabled, "只读设置弹窗未禁用")
      const before = content(editor)
      submit()
      await delay()
      assert(content(editor) === before && field("文本框内边距").value === "24", "只读提交改正文或丢弃草稿")
      store.getState().updateView({ readOnly: false })
      await waitFor(() => !field("文本框内边距").disabled, "恢复编辑没有保留可用草稿")
      await apply()
      assert(nodes(editor, "textBox")[0].node.attrs.padding === 24, "恢复后无法提交原草稿")
    })

    await check("容器退出：Mod+Enter 实际键盘路径复用后段，缺少后段时新增并可撤销", async ({ editor, store }) => {
      for (const type of ["textBox", "details"]) for (const existing of [true, false]) {
        editor.commands.setContent({ type: "doc", content: [container(type, [paragraph("键盘退出正文")]),
          ...(existing ? [paragraph("已有后段")] : [{ type: "horizontalRule" }, paragraph("尾段")])] })
        selectContainer(editor, type)
        const before = content(editor)
        const revision = store.getState().revision
        const mac = /Mac|iPhone|iPad/.test(navigator.platform)
        const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true })
        editor.view.dom.dispatchEvent(event)
        const node = nodes(editor, type)[0]
        const afterPos = node.pos + node.node.nodeSize
        assert(event.defaultPrevented && editor.state.selection.from === afterPos + 1 && editor.state.doc.nodeAt(afterPos)?.type.name === "paragraph", "Mod+Enter 未通过快捷键进入容器后正文")
        if (existing) assert(content(editor) === before && store.getState().revision === revision, "退出到已有后段制造了正文变化")
        else assert(content(editor) !== before && editor.commands.undo() && content(editor) === before, "退出新增段落不可一次撤销")
      }
    })

    await check("容器移除：文本框正文与详情标题及富内容全部保留，一次撤销还原", async ({ editor }) => {
      for (const type of ["textBox", "details"]) {
        editor.commands.setContent({ type: "doc", content: [container(type, richBody(), type === "details" ? { summary: "移除后仍保留的标题" } : TEXT_BOX_DEFAULTS), paragraph("外部正文")] })
        selectContainer(editor, type)
        await switchInsert()
        const before = content(editor)
        const body = nodes(editor, type)[0].node.content.toJSON()
        const trigger = await waitFor(() => button(activePanel(), type === "textBox" ? "移除文本框" : "移除详情")?.disabled === false
          && button(activePanel(), type === "textBox" ? "移除文本框" : "移除详情"), "容器移除入口不可用")
        trigger.click()
        assert(!nodes(editor, type).length, "移除容器没有剥离外壳")
        const restoredBody = editor.getJSON().content.slice(type === "details" ? 1 : 0, (type === "details" ? 1 : 0) + body.length)
        assert(JSON.stringify(restoredBody) === JSON.stringify(body), "移除容器改变了标题、文字格式、列表、任务或表格正文")
        if (type === "details") assert(editor.state.doc.firstChild.textContent === "移除后仍保留的标题", "移除详情丢失属性标题")
        assert(editor.commands.undo() && content(editor) === before, "移除容器不能一次完整撤销")
      }
    })

    await check("富文本容器：IndexedDB 保存重开与 Mewoc 往返保留属性、富正文和附件字节", async context => {
      const blob = new Blob(["abc"], { type: "text/plain" })
      const id = `m19-attachment-${Math.random().toString(16).slice(2, 12)}`
      context.assets.set(id, { id, kind: "attachment", fileName: "容器附件.txt", mimeType: blob.type, byteLength: blob.size, blob, url: URL.createObjectURL(blob) })
      const body = [...richBody(), { type: "attachment", attrs: { assetId: id } }]
      context.editor.commands.setContent({ type: "doc", content: [container("textBox", body, { backgroundColor: "#ffeeaa", borderColor: "#123456", borderWidth: 3, padding: 24 }),
        container("details", richBody(), { summary: "保存后的详细内容" }), paragraph("外部正文")] })
      assert(await context.saveDocument(), "容器正文保存失败")
      const expected = content(context.editor)
      const saved = await getLocalDocument(context.documentId)
      const storedAssets = await getDocumentAssets(saved.document)
      assert(JSON.stringify(saved.document.content) === expected && storedAssets.has(id), "IndexedDB 丢失容器正文或内部资源引用")
      const reopened = await mount({ ...saved, assets: storedAssets })
      assert(reopened.editor !== context.editor && content(reopened.editor) === expected && !reopened.editor.can().undo(), "重开没有恢复容器或沿用了旧撤销会话")
      const portable = await createPortableFile(reopened.getSnapshot(), reopened.assets)
      const imported = await readPortableFile(new File([JSON.stringify(portable)], "rich-blocks.mewoc.json"))
      assert(JSON.stringify(imported.document.content) === expected && imported.assets.size === 1 && await imported.assets.get(id).blob.text() === "abc", "Mewoc 往返丢失容器或附件字节")
      assert(detailsDom(reopened.editor).dataset.expanded === "true", "重开错误持久化了上一会话的折叠状态")
    })

    await check("富文本容器：折叠后 HTML 仍展开完整正文，iframe 外观及清理粘贴往返一致", async context => {
      context.editor.commands.setContent({ type: "doc", content: [container("textBox", richBody(), { backgroundColor: "#ffeeaa", borderColor: "#123456", borderWidth: 3, padding: 24 }),
        container("details", richBody(), { summary: "静态 <标题> & 正文" }), paragraph("HTML 尾段")] })
      selectContainer(context.editor, "details")
      detailsToggle(context.editor).click()
      assert(detailsDom(context.editor).dataset.expanded === "false", "静态导出测试没有先收起详情")
      const before = content(context.editor)
      const pasted = new Editor({ element: document.createElement("div"), extensions: createExtensions(), content: cleanPastedHtml(context.editor.getHTML()) })
      try { assert(content(pasted) === before, "真实 schema HTML 清理往返丢失容器属性、标题或富正文") }
      finally { pasted.destroy() }
      const copied = context.editor.view.serializeForClipboard(context.editor.state.doc.slice(0, context.editor.state.doc.content.size))
      assert(copied.dom.querySelector("details[open] [data-details-content] table") && !copied.dom.querySelector("[data-details-toggle],[hidden]"), "复制携带折叠 NodeView 或遗漏详情表格")
      const selectedDetails = nodes(context.editor, "details")[0]
      // Tiptap 的纯文本序列化器读取实际 state.selection；slice 只决定 HTML，不能代替正文选区。
      context.editor.view.dispatch(context.editor.state.tr.setSelection(NodeSelection.create(context.editor.state.doc, selectedDetails.pos)))
      const fullCopy = context.editor.view.serializeForClipboard(context.editor.state.selection.content())
      assert(fullCopy.text.includes("静态 <标题> & 正文") && fullCopy.text.includes("详情可检索正文") && fullCopy.text.includes("容器内表格"),
        "整个详情纯文本复制丢失属性标题或正文")
      let bodyPosition = null
      selectedDetails.node.descendants((node, pos) => {
        if (node.type.name === "paragraph" && node.textContent === "详情可检索正文第二行说明") bodyPosition = selectedDetails.pos + 1 + pos
      })
      assert(bodyPosition !== null, "未找到部分复制的详情正文")
      context.editor.view.dispatch(context.editor.state.tr.setSelection(TextSelection.create(context.editor.state.doc, bodyPosition + 1, bodyPosition + 4)))
      const partialCopy = context.editor.view.serializeForClipboard(context.editor.state.selection.content())
      assert(partialCopy.text === "详情可" && !partialCopy.text.includes("静态 <标题> & 正文"), "部分正文复制混入了详情标题或未选择文字")
      // 部分正文选区会自动展开详情；重新收起后再验证静态导出，以保留本项的初始视图条件。
      detailsToggle(context.editor).click()
      assert(detailsDom(context.editor).dataset.expanded === "false", "部分复制后无法恢复折叠导出条件")
      const frame = document.createElement("iframe")
      frame.style.cssText = "width:700px;height:600px;border:0"
      host.append(frame)
      try {
        frame.srcdoc = await createDocumentHtml(context.getSnapshot(), context.assets)
        const document = await waitFor(() => frame.contentDocument?.querySelector("article details[open] [data-details-content] table") && frame.contentDocument,
          "独立 HTML 没有加载展开的完整详情正文")
        const box = document.querySelector('article [data-type="text-box"]')
        const details = document.querySelector("article details")
        const body = details.querySelector("[data-details-content]")
        const boxStyle = frame.contentWindow.getComputedStyle(box)
        const bodyStyle = frame.contentWindow.getComputedStyle(body)
        assert(boxStyle.backgroundColor === "rgb(255, 238, 170)" && boxStyle.borderTopColor === "rgb(18, 52, 86)" && boxStyle.borderTopWidth === "3px" && boxStyle.paddingTop === "24px", "离线 HTML 文本框外观没有实际呈现")
        assert(bodyStyle.display === "block" && body.getBoundingClientRect().height > 0 && body.querySelector('ul[data-type="taskList"]') && details.querySelector("summary").textContent === "静态 <标题> & 正文", "离线 HTML 详情隐藏正文或损坏标题/待办")
        assert(content(context.editor) === before && detailsDom(context.editor).dataset.expanded === "false", "静态导出反向改写了编辑器正文或视图")
      } finally { frame.remove() }
    })
  } finally {
    await unmount()
    host.remove()
    await removeVerificationDocuments([...records.values()])
    for (const [key, value] of preferences) {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    }
  }
}
