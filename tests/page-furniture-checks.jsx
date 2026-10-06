/**
 * M23 使用真实 Provider、Workspace、IndexedDB 和 DOCX Worker 验证页眉页脚闭环。
 * 输入与组合事件为明确的合成动作；系统 PDF 留给独立示例，不以自动断言假称打印已完成。
 */
import { useEffect, useState } from "react"
import ReactDOM from "react-dom"
import { closeHistory } from "@tiptap/pm/history"
import { TextSelection } from "@tiptap/pm/state"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { DocumentHistoryAction } from "../src/pages/editor/components/DocumentHistoryAction.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { DEFAULT_WATERMARK } from "../src/pages/editor/tools/page-settings.js"
import { getPageFurnitureText, getPageFurnitureFontPt } from "../src/pages/editor/tools/page-furniture.js"
import { getPagePagination, PAGE_PAGINATION_KEY } from "../src/pages/editor/extensions/page-pagination.js"
import { supportsPageMarginBoxes } from "../src/pages/editor/tools/page-furniture-export.js"
import { getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"
import { createDocumentTemplate, getDocumentTemplate, instantiateDocumentTemplate, deleteDocumentTemplate } from "../src/pages/editor/tools/document-template-repository.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { readDocxDocument } from "../src/pages/editor/tools/docx-import-file.js"
import { TOOLBAR_MODE_KEY, TOOLBAR_MODES } from "../src/pages/editor/tools/toolbar-preferences.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { removeVerificationDocuments } from "./browser-checks.js"
import { readParagraphGlyphs } from "./paragraph-pagination-checks.jsx"

const assert = (value, message) => { if (!value) throw new Error(message) }
const delay = (milliseconds = 35) => new Promise(resolve => setTimeout(resolve, milliseconds))
const waitFor = async (read, message) => { const end = Date.now() + 12000; while (Date.now() < end) { const value = await read(); if (value) return value; await delay() } throw new Error(message) }
const visible = element => !!element?.getClientRects().length && !element.closest("[hidden]") && getComputedStyle(element).visibility !== "hidden"
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(element => visible(element) && (element.getAttribute("aria-label") || element.textContent).replace(/\s/g, "") === name.replace(/\s/g, ""))
const dialog = name => [...document.querySelectorAll('[role="dialog"]')].find(element => visible(element) && element.querySelector(".ant-modal-title")?.textContent === name)
const field = name => dialog("页眉页脚")?.querySelector(`[aria-label="${name}"]`)
const json = value => JSON.stringify(value)
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
// 多个有限高段落确实产生多页，避免只有一个超高段落时误把展开页当作跨段分页。
const plainContent = () => ({ type: "doc", content: [paragraph("页眉页脚不属于这段正文。"), paragraph("第二段保留选择与撤销。"), ...Array.from({ length: 14 }, (_, index) => paragraph(`${index + 1} · ` + "长正文继续保持完整。".repeat(10)))] })
const furniture = (text, alignment = "center", pageNumber = "none") => ({ text, alignment, pageNumber })
const setInput = (element, value) => { assert(element instanceof HTMLInputElement, "页眉页脚输入不存在"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, String(value)); element.dispatchEvent(new Event("input", { bubbles: true })) }
const setSelect = (element, value) => { assert(element instanceof HTMLSelectElement, "页眉页脚选项不存在"); element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })) }
const near = (left, right, tolerance = 0.8) => Math.abs(left - right) < tolerance
const preferences = () => new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
const restorePreferences = saved => { for (const [key, value] of saved) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } }
const snapshotFields = context => json({ id: context.documentId, page: context.store.getState().page, content: context.editor.getJSON(), revision: context.store.getState().revision })
const chooseWordFile = file => {
  const input = dialog("导入 Word 文档")?.querySelector('input[aria-label="选择 Word 文件"]')
  assert(input, "正式 Word 文件输入不存在")
  Object.defineProperty(input, "files", { configurable: true, value: [file] })
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

function Probe({ onReady, onChange }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onReady(context) }, [context, onReady])
  return <EditorWorkspace onDocumentChange={onChange} />
}

export async function runPageFurnitureChecks(report = () => {}) {
  const savedPreferences = preferences()
  const records = new Map()
  const templates = new Map()
  const host = document.createElement("section")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:900px;margin:24px 0"
  document.body.append(host)
  let current
  const capture = context => { current = context }
  const paper = () => host.querySelector("[data-mewoc-editor-surface]")
  const sheets = () => [...(paper()?.querySelectorAll("[data-mewoc-page-layer] > [data-mewoc-page-index]") || [])]
  const layer = (position, index = 0) => sheets()[index]?.querySelector(`[data-mewoc-page-furniture="${position}"]`)
  const settledPages = async () => {
    await delay()
    return waitFor(() => {
      const state = PAGE_PAGINATION_KEY.getState(current.editor.state)
      const layout = getPagePagination(current.editor)
      return state?.settings.enabled && !state.pending && layout.pageCount > 0 && sheets().length === layout.pageCount &&
        paper()?.getAttribute("data-mewoc-pagination-status") === layout.status && layout
    }, "编辑页分页与纸面装饰未就绪")
  }
  const panel = () => [...host.querySelectorAll('[role="tabpanel"]')].find(visible)
  function SessionHost({ record }) {
    const [selected, setSelected] = useState(record)
    const change = next => { records.set(next.document.id, next); setSelected(next) }
    return <EditorProvider key={selected.document.id} record={selected}><Probe onReady={capture} onChange={change} /></EditorProvider>
  }
  const unmount = async () => {
    if (current?.editor && !current.editor.isDestroyed) {
      current.store.getState().updateView({ readOnly: false, switching: false })
      await current.saveDocument()
    }
    ReactDOM.unmountComponentAtNode(host)
    current = null
    await waitFor(() => !dialog("页眉页脚") && !dialog("导入 Word 文档") && !dialog("历史版本"), "页眉页脚专项弹窗未卸载")
  }
  const mount = async record => {
    await unmount()
    localStorage.removeItem(TOOLBAR_MODE_KEY)
    localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    if (!record) {
      const document = { ...createDocument(), title: `M23 页眉页脚验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, content: plainContent() }
      const assets = new Map()
      const saved = await saveLocalDocument(document, assets, 0)
      record = { document, assets, storageVersion: saved.storageVersion }
    }
    records.set(record.document.id, record)
    ReactDOM.render(<SessionHost record={record} />, host)
    await waitFor(() => current?.editor && current.documentId === record.document.id && paper(), "页眉页脚 Workspace 未就绪")
    current.store.getState().updateView({ activeTab: "页面", outlineOpen: false, fitWidth: false, zoom: 1 })
    await waitFor(() => panel()?.getAttribute("aria-label") === "页面工具", "页面工具未显示")
    await settledPages()
    return current
  }
  const open = async () => {
    current.store.getState().updateView({ activeTab: "页面" })
    const control = await waitFor(() => button(panel(), "页眉页脚")?.disabled === false && button(panel(), "页眉页脚"), "页眉页脚入口不可用")
    control.click()
    return waitFor(() => dialog("页眉页脚"), "页眉页脚弹窗未打开")
  }
  const put = async (name, value) => { setInput(field(name), value); await delay() }
  const choose = async (name, value) => { setSelect(field(name), value); await delay() }
  const enable = async (label, value = true) => { const control = field(`启用${label}`); assert(control, "启用控件不存在"); if (control.checked !== value) control.click(); await delay() }
  const apply = async () => { const control = button(dialog("页眉页脚"), "应用"); assert(control && !control.disabled, "页眉页脚应用不可用"); control.click(); await waitFor(() => !dialog("页眉页脚"), "页眉页脚应用未完成"); await settledPages() }
  const cancel = async () => { button(dialog("页眉页脚"), "取消").click(); await waitFor(() => !dialog("页眉页脚"), "页眉页脚取消未关闭") }
  const invalidSubmit = async () => {
    const before = snapshotFields(current)
    dialog("页眉页脚").querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await waitFor(() => dialog("页眉页脚")?.querySelector('[role="alert"]'), "页眉页脚无效草稿没有显示错误")
    assert(snapshotFields(current) === before, "失败提交仍改变原页面、正文或修订")
  }
  const setBoth = async () => {
    await open()
    await enable("页眉"); await put("页眉文字", "审阅资料 M23"); await choose("页眉对齐", "left")
    await enable("页脚"); await put("页脚文字", "存档资料 M23"); await choose("页脚对齐", "right"); await choose("页脚页码", "page-total")
    await apply()
  }
  const check = async (name, run) => {
    try { await mount(); await run(current); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
    finally { await unmount() }
  }
  try {
    await check("页眉页脚：完整与极简工具栏均可配置三种对齐和三种页码", async ({ store }) => {
      for (const mode of ["ribbon", "compact"]) {
        if (host.querySelector("[data-toolbar-mode]").dataset.toolbarMode !== mode) {
          button(host, "切换工具栏").click()
          const label = TOOLBAR_MODES.find(item => item.key === mode).label
          const item = await waitFor(() => [...document.querySelectorAll('[role="menuitemradio"]')].find(node => visible(node) && node.textContent === label), "页眉页脚模式菜单未打开")
          item.click(); await waitFor(() => host.querySelector("[data-toolbar-mode]").dataset.toolbarMode === mode, "页眉页脚模式没有切换")
        }
        for (const [alignment, pageNumber] of [["left", "none"], ["center", "page"], ["right", "page-total"]]) {
          await open()
          for (const label of ["页眉", "页脚"]) { await enable(label); await put(`${label}文字`, `${label}功能验收`); await choose(`${label}对齐`, alignment); await choose(`${label}页码`, pageNumber) }
          await apply()
          for (const [position, label] of [["header", "页眉"], ["footer", "页脚"]]) {
            const value = store.getState().page[position]
            assert(value.alignment === alignment && value.pageNumber === pageNumber && value.text === `${label}功能验收`, "控件值没有准确提交")
            for (let index = 0; index < sheets().length; index += 1) {
              assert(layer(position, index)?.querySelector("text")?.textContent === getPageFurnitureText(value, { pageNumber: index + 1, pageTotal: sheets().length }), "编辑页实际编号、总页数或文字没有准确呈现")
            }
          }
        }
      }
    })
    await check("页眉页脚草稿：实时预览安全文字，取消不改变页面、正文、选择或修订", async ({ editor }) => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 6)))
      const before = snapshotFields(current); const selection = json(editor.state.selection.toJSON())
      await open(); await enable("页眉"); await put("页眉文字", "预览 <b> & 保留"); await choose("页眉页码", "page-total")
      const preview = dialog("页眉页脚").querySelector("[data-page-furniture-preview]")
      assert(preview?.querySelector('[data-mewoc-page-furniture="header"] text')?.textContent === "预览 <b> & 保留 · 第 1 / … 页" && !preview.querySelector("b"), "预览没有安全显示文字与总页数示意")
      assert(!layer("header") && snapshotFields(current) === before && json(editor.state.selection.toJSON()) === selection, "预览提前写入或改变正文选区")
      await cancel(); assert(snapshotFields(current) === before && !layer("header"), "取消仍修改页面")
    })
    await check("页眉页脚草稿：跨模式保留，合并时保留实时纸型、边距、水印与另一端属性", async ({ store }) => {
      await setBoth(); await open(); await put("页眉文字", "新的页眉文字")
      const live = structuredClone(store.getState().page)
      live.size = "Letter"; live.marginsMm.right = 23; live.watermark = { ...DEFAULT_WATERMARK, text: "并发水印" }
      live.header.alignment = "center"; live.footer.text = "另一端实时内容"; live.footer.pageNumber = "page"
      store.getState().updatePage(live); store.getState().updateView({ activeTab: "插入" })
      button(host, "切换工具栏").click()
      const minimal = await waitFor(() => [...document.querySelectorAll('[role="menuitemradio"]')].find(node => visible(node) && node.textContent === "极简模式"), "草稿模式菜单未打开")
      minimal.click(); await delay()
      assert(field("页眉文字").value === "新的页眉文字", "模式切换丢失草稿")
      await apply()
      const page = store.getState().page
      assert(page.header.text === "新的页眉文字" && page.header.alignment === "center" && page.footer.text === "另一端实时内容" && page.footer.pageNumber === "page" && page.size === "Letter" && page.marginsMm.right === 23 && page.watermark.text === "并发水印", "旧草稿覆盖未编辑的实时字段")
      await open(); await put("页眉文字", "不应复活已关闭页眉")
      store.getState().updatePage({ ...store.getState().page, header: null }); await apply()
      assert(store.getState().page.header === null && !layer("header"), "只改文字复活了已被关闭的实时页眉")
    })
    await check("页眉页脚提交：只读、切换、正文及表单组合输入阻止写入，恢复与新会话隔离", async ({ editor, store }) => {
      await open(); await enable("页眉"); await put("页眉文字", "受保护的草稿")
      for (const reason of ["readOnly", "switching", "composition", "formComposition"]) {
        if (reason === "composition") { editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); await waitFor(() => editor.view.composing, "正文组合状态未开启") }
        else if (reason === "formComposition") field("页眉文字").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
        else { store.getState().updateView({ [reason]: true }); await waitFor(() => !editor.isEditable, "实时禁写未生效") }
        await invalidSubmit(); assert(field("页眉文字").value === "受保护的草稿", "禁写丢失草稿")
        if (reason === "composition") { editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); await waitFor(() => !editor.view.composing, "正文组合状态未结束") }
        else if (reason === "formComposition") field("页眉文字").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
        else { store.getState().updateView({ [reason]: false }); await waitFor(() => editor.isEditable, "实时恢复编辑失败") }
      }
      await apply(); assert(store.getState().page.header.text === "受保护的草稿", "解除禁写后草稿不能应用")
      await open(); await put("页眉文字", "旧会话不应继承")
      await mount(); assert(!dialog("页眉页脚") && !current.store.getState().page.header, "旧会话草稿进入新文档")
    })
    await check("页眉页脚校验：不足12mm边距、超长及宽度不足保留错误草稿，修正后可应用", async ({ store }) => {
      store.getState().updatePage({ ...store.getState().page, marginsMm: { top: 11.99, right: 20, bottom: 11.99, left: 20 } })
      await open(); await enable("页眉"); await put("页眉文字", "边距校验"); await invalidSubmit()
      assert(field("页眉文字").value === "边距校验", "错误后草稿被清除")
      store.getState().updatePage({ ...store.getState().page, marginsMm: { top: 12, right: 20, bottom: 12, left: 20 } })
      await put("页眉文字", "长".repeat(81)); await invalidSubmit()
      store.getState().updatePage({ ...store.getState().page, marginsMm: { top: 12, right: 85, bottom: 12, left: 85 } })
      await put("页眉文字", "长".repeat(40)); await invalidSubmit()
      await put("页眉文字", "短页眉"); await enable("页脚"); await put("页脚文字", "短页脚"); await apply()
      assert(store.getState().page.header.text === "短页眉" && store.getState().page.footer.text === "短页脚", "修正草稿后仍不能应用合法12mm边距")
    })
    await check("页眉页脚：每个编辑页页脚不覆盖文字，缩放、统计、复制与正文撤销保持独立", async ({ editor, store }) => {
      const initial = json(editor.getJSON())
      editor.view.dispatch(closeHistory(editor.state.tr)); editor.commands.insertContentAt(2, "可撤销内容"); editor.view.dispatch(closeHistory(editor.state.tr))
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 7)))
      await settledPages()
      const content = json(editor.getJSON()); const text = editor.getText(); const selection = json(editor.state.selection.toJSON())
      const bodyHeight = editor.view.dom.offsetHeight; const paperHeight = paper().offsetHeight
      const statistic = [...host.querySelectorAll("footer span")].find(node => node.textContent.includes("字符（不含空白）"))?.textContent
      await setBoth()
      assert(json(editor.getJSON()) === content && editor.getText() === text && json(editor.state.selection.toJSON()) === selection && editor.view.dom.offsetHeight === bodyHeight && paper().offsetHeight === paperHeight, "页面装饰改变正文布局或选择")
      assert([...host.querySelectorAll("footer span")].find(node => node.textContent.includes("字符（不含空白）"))?.textContent === statistic, "页眉页脚进入正文统计")
      const clipboard = editor.view.serializeForClipboard(editor.state.selection.content())
      assert(!clipboard.dom.querySelector("svg") && !clipboard.text.includes("审阅资料") && !clipboard.text.includes("存档资料"), "页面装饰进入复制正文")
      for (const zoom of [0.5, 1, 1.5]) {
        store.getState().updateView({ zoom, fitWidth: false }); const layout = await settledPages()
        assert(layout.pageCount > 1 && layout.overflowCount === 0, "长正文夹具没有实际形成多张标准编辑页")
        // placement 现在可能是段内字符位置，不能把每条文字行当成独立 NodeView；独立量真实字形。
        const glyphs = []
        editor.state.doc.forEach((node, pos) => {
          if (["paragraph", "heading"].includes(node.type.name)) glyphs.push(...readParagraphGlyphs(editor, editor.view.nodeDOM(pos)).map(item => item.rect))
        })
        assert(glyphs.every(rect => sheets().some(sheet => rect.top >= sheet.getBoundingClientRect().top - 1 && rect.bottom <= sheet.getBoundingClientRect().bottom + 1)), "正文文字不在任何编辑纸面")
        for (let index = 0; index < sheets().length; index += 1) {
          const footer = layer("footer", index).getBoundingClientRect(); const sheet = sheets()[index].getBoundingClientRect()
          assert(near(footer.bottom, sheet.bottom) && near(footer.width, sheet.width), "页脚未锚定对应编辑页的底边与纸宽")
          for (const rect of glyphs.filter(rect => rect.top >= sheet.top - 1 && rect.top < sheet.bottom - 1)) assert(footer.top >= rect.bottom - 1, "本页页脚覆盖正文文字")
          assert(layer("header", index).getAttribute("aria-hidden") === "true" && getComputedStyle(layer("header", index)).pointerEvents === "none" && getComputedStyle(layer("footer", index)).userSelect === "none", "装饰层截获交互")
          assert(layer("footer", index).querySelector("text").textContent === getPageFurnitureText(store.getState().page.footer, { pageNumber: index + 1, pageTotal: sheets().length }), "缩放后实际编辑页码或总页数改变")
        }
      }
      assert(paper().querySelectorAll("[data-mewoc-page-furniture]").length === sheets().length * 2, "编辑页未各有一组页眉页脚或重复绘制")
      assert(editor.commands.undo() && json(editor.getJSON()) === initial && store.getState().page.footer.pageNumber === "page-total", "页眉页脚占用正文撤销或随正文撤销丢失")
    })
    await check("页眉页脚保存：重开、Mewoc备份及独立模板保留设置，关闭和无修改不增加修订", async context => {
      await setBoth(); assert(await context.saveDocument(), "页眉页脚保存失败")
      const expected = json(context.store.getState().page); const saved = await getLocalDocument(context.documentId)
      const template = await createDocumentTemplate(context.documentId, saved.storageVersion, `M23临时模板-${Date.now()}`)
      templates.set(template.id, template.storageVersion)
      assert(json((await getDocumentTemplate(template.id)).template.document.page) === expected, "模板快照丢失装饰")
      const instance = await instantiateDocumentTemplate(template.id, template.storageVersion); records.set(instance.document.id, instance)
      assert(instance.document.id !== context.documentId && json(instance.document.page) === expected, "模板实例没有独立保留装饰")
      await mount({ ...saved, assets: new Map() }); assert(json(current.store.getState().page) === expected && layer("footer"), "保存重开丢失装饰")
      const portable = await createPortableFile(current.getSnapshot(), current.assets)
      const reopened = await readPortableFile(new File([json(portable)], "页眉页脚.mewoc.json"))
      assert(reopened.document.id !== current.documentId && json(reopened.document.page) === expected, "Mewoc往返没有独立恢复页面")
      await mount(instance); assert(layer("header")?.querySelector("text").textContent === "审阅资料 M23", "模板实例画布未显示装饰")
      const revision = current.store.getState().revision; await open(); await apply(); assert(current.store.getState().revision === revision, "无修改提交仍增加修订")
      await open(); await enable("页眉", false); await enable("页脚", false); await apply()
      assert(current.store.getState().page.header === null && current.store.getState().page.footer === null && !layer("header") && !layer("footer"), "关闭装饰没有明确保存语义")
    })
    await check("页眉页脚历史：预览使用检查点页面，当前文档与修订保持不变", async context => {
      await setBoth(); await context.saveDocument(); const saved = await getLocalDocument(context.documentId)
      const version = await createDocumentVersion(context.documentId, saved.storageVersion, "M23页眉页脚检查点")
      context.store.getState().updatePage({ ...context.store.getState().page, header: furniture("当前页眉"), footer: null })
      const before = snapshotFields(context); const previewHost = document.createElement("div"); host.append(previewHost)
      try {
        ReactDOM.render(<DocumentHistoryAction record={{ id: context.documentId, document: saved.document }} currentDocumentId={context.documentId} initialOpen onPrepare={() => true} />, previewHost)
        const history = await waitFor(() => dialog("历史版本")?.querySelector(`[data-version-id="${version.id}"]`) && dialog("历史版本"), "历史检查点未显示")
        button(history.querySelector(`[data-version-id="${version.id}"]`), "预览").click()
        const preview = await waitFor(() => history.querySelector('[aria-label="版本预览"] [data-mewoc-page-furniture="footer"]') && history.querySelector('[aria-label="版本预览"]'), "历史装饰预览未显示")
        assert(preview.querySelector('[data-mewoc-page-furniture="header"] text').textContent === "审阅资料 M23" && preview.querySelector('[data-mewoc-page-furniture="footer"] text').textContent.includes("第 1 / … 页"), "历史预览读取当前装饰或虚构总页数")
        assert(snapshotFields(context) === before, "历史只读预览改变当前页面或正文")
      } finally { ReactDOM.unmountComponentAtNode(previewHost); previewHost.remove(); await delay() }
    })
    await check("页眉页脚Word：真实Worker、预览和确认恢复动态装饰、水印，正文不重复", async () => {
      const source = { ...createDocument(), title: "M23原生装饰往返", page: { ...createDocument().page, marginsMm: { top: 12, right: 17, bottom: 12, left: 23 }, header: furniture("Word审阅资料", "left", "page"), footer: furniture("Word存档资料", "right", "page-total"), watermark: { ...DEFAULT_WATERMARK, text: "Word水印 M23" } }, content: { type: "doc", content: [paragraph("M23正文必须保持完整。"), paragraph("第二段正文与装饰隔离。") ] } }
      const file = new File([(await createDocumentDocx(source, new Map())).blob], "M23装饰.docx")
      const direct = await readDocxDocument(file)
      assert(json(direct.record.document.page.header) === json(source.page.header) && json(direct.record.document.page.footer) === json(source.page.footer), "真实Worker不能恢复动态页眉页脚")
      const before = snapshotFields(current); const id = current.documentId
      button(host, "导入 Word").click(); await waitFor(() => dialog("导入 Word 文档"), "Word预览未打开"); chooseWordFile(file)
      const preview = await waitFor(() => dialog("导入 Word 文档")?.querySelector('textarea[aria-label="Word 导入正文预览"]'), "Word预览未生成")
      const pagePreview = dialog("导入 Word 文档").querySelector("[data-docx-import-page-preview]")
      assert(pagePreview?.querySelectorAll("[data-mewoc-page-furniture]").length === 2 && pagePreview.querySelector("[data-mewoc-watermark]"), "Word页面预览缺少页眉页脚或水印")
      assert(!preview.value.includes("Word审阅资料") && !preview.value.includes("Word存档资料") && !preview.value.includes("Word水印 M23") && snapshotFields(current) === before, "装饰进入预览正文或提前修改当前会话")
      button(dialog("导入 Word 文档"), "导入为新文档").click(); await waitFor(() => current.documentId !== id && !dialog("导入 Word 文档"), "Word确认未切换独立会话")
      assert(json(current.store.getState().page.header) === json(source.page.header) && json(current.store.getState().page.footer) === json(source.page.footer) && current.store.getState().page.watermark.text === source.page.watermark.text, "确认导入丢失页面装饰")
      assert(current.editor.state.doc.childCount === 2 && current.editor.state.doc.textBetween(0, current.editor.state.doc.content.size, "\n") === "M23正文必须保持完整。\n第二段正文与装饰隔离。", "Word往返添加装饰正文或改变正文顺序")
      const roundtrip = await readDocxDocument(new File([(await createDocumentDocx(current.getSnapshot(), current.assets)).blob], "M23再次导出.docx"))
      assert(json(roundtrip.record.document.page.header) === json(source.page.header) && json(roundtrip.record.document.page.footer) === json(source.page.footer), "再次DOCX输出丢失装饰")
    })
    await check("页眉页脚HTML：真实iframe保留安全文字与page/pages边距框，正文和窄幅字号隔离", async ({ store }) => {
      const page = { ...store.getState().page, header: furniture('审核 <&> " \\ </style>', "left", "page"), footer: furniture("HTML存档", "right", "page-total") }
      store.getState().updatePage(page)
      const html = await createDocumentHtml(current.getSnapshot(), current.assets)
      const frame = document.createElement("iframe"); frame.style.cssText = "width:850px;height:600px;border:0"; host.append(frame)
      try {
        await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = () => reject(new Error("HTML iframe载入失败")); frame.srcdoc = html })
        const printed = frame.contentDocument; await printed.fonts.ready
        assert(!printed.querySelector("script") && printed.querySelectorAll("style").length === 1, "页眉字符闭合style或生成活动脚本")
        assert(printed.querySelector(".mewoc-export-header").textContent === getPageFurnitureText(page.header), "HTML页眉安全文字被截断")
        assert(!printed.querySelector("article").textContent.includes("HTML存档") && !printed.querySelector("article").textContent.includes("审核 <&>"), "装饰进入HTML正文")
        const pageRule = [...printed.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(rule => rule.cssText.startsWith("@page"))
        if (supportsPageMarginBoxes()) {
          const rules = [...pageRule.cssRules]
          assert(rules.find(rule => rule.name === "top-center")?.style.content.includes("counter(page)") && rules.find(rule => rule.name === "bottom-center")?.style.content.includes("counter(pages)"), "真实CSS解析丢失原生页码规则")
          assert(rules.find(rule => rule.name === "top-left")?.style.content === "none" && rules.find(rule => rule.name === "bottom-right")?.style.content === "none", "多余边距盒仍重复输出")
        } else assert(printed.querySelector(".mewoc-export-furniture-hint")?.textContent.includes("Chrome 131"), "不支持的浏览器没有打印限制说明")
        const footer = printed.querySelector(".mewoc-export-footer").getBoundingClientRect(); const article = printed.querySelector("article").getBoundingClientRect()
        assert(footer.top >= article.bottom - 1, "HTML连续页脚覆盖长正文")
        const textNode = printed.querySelector(".mewoc-export-header span"); const range = printed.createRange(); range.selectNodeContents(textNode)
        const ink = range.getBoundingClientRect(); const box = textNode.getBoundingClientRect()
        assert(ink.left >= box.left - 1 && ink.right <= box.right + 1, "HTML实际字体文字超出预留正文宽度")
      } finally { frame.remove() }
      store.getState().updatePage({ ...store.getState().page, marginsMm: { top: 12, right: 85, bottom: 12, left: 85 }, header: furniture("测".repeat(17)), footer: furniture("窄页脚") })
      await waitFor(() => layer("header")?.querySelector("text")?.textContent === "测".repeat(17), "窄幅装饰没有显示")
      assert(getPageFurnitureFontPt(store.getState().page, store.getState().page.header) >= 6 && getPageFurnitureFontPt(store.getState().page, store.getState().page.header) < 9, "窄幅文字未采用有效适配字号")
      const ink = layer("header").querySelector("text").getBoundingClientRect(); const sheet = paper().getBoundingClientRect()
      assert(ink.left >= sheet.left + 85 * 96 / 25.4 - 1 && ink.right <= sheet.right - 85 * 96 / 25.4 + 1, "窄幅实际SVG文字超出左右边距")
    })
  } finally {
    await unmount()
    for (const [id, version] of templates) await deleteDocumentTemplate(id, version)
    await removeVerificationDocuments([...records.values()])
    host.remove(); restorePreferences(savedPreferences)
  }
}

/**
 * 手动补验只挂载正式 Workspace，不生成 passed 结果。可操作弹窗、导出和系统打印。
 * 结束按钮排空当前保存、卸载资源，仅删除此示例确实新建的文档并还原两项偏好。
 */
export async function showPageFurnitureExample() {
  const savedPreferences = preferences()
  const source = { ...createDocument(), title: "M23 · 页眉页脚与页码补验",
    page: { size: "A5", orientation: "landscape", marginsMm: { top: 12, right: 20, bottom: 12, left: 20 },
      header: furniture("M23 页面验收", "left", "page"), footer: furniture("内部资料", "right", "page-total"),
      watermark: { text: "草稿 M23", color: "#6554C0", opacity: 0.18, angle: -35 } },
    content: { type: "doc", content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "M23 · 页眉页脚与页码" }] },
      ...Array.from({ length: 12 }, (_, index) => paragraph(`${String(index + 1).padStart(2, "0")} · 页面补验正文。` + "本段用于核对横向 A5 的页眉、页脚、真实页码与总页数；页面装饰和水印保持独立，正文跨页继续完整。".repeat(5)))
    ] } }
  // 有真实定位 mark 的批注附录参与输出分页，不能只在屏幕上显示一条孤立说明。
  const commentId = "m23-print-comment"
  const time = new Date().toISOString()
  source.content.attrs = { commentThreads: [{ id: commentId, text: "系统 PDF 补验还应完整包含批注说明，页码与总页数必须统计该附录。".repeat(40), quote: "M23 · 页眉页脚与页码", createdAt: time, updatedAt: time, resolved: false }] }
  source.content.content[0].content[0].marks = [{ type: "commentAnchor", attrs: { id: commentId } }]
  const assets = new Map(); const saved = await saveLocalDocument(source, assets, 0)
  const first = { document: source, assets, storageVersion: saved.storageVersion }
  const records = new Map([[source.id, first]])
  const host = document.createElement("section")
  host.dataset.pageFurnitureExample = ""
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:950px;margin:24px 0"
  document.body.append(host)
  let current; let closing = false; let resolveFinished; let rejectFinished
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
  const finish = async () => {
    if (closing) return
    closing = true
    let failure
    try { if (current?.editor && !current.editor.isDestroyed && !await current.saveDocument()) throw new Error("页眉页脚补验文档未能完成保存") }
    catch (error) { failure = error }
    try { ReactDOM.unmountComponentAtNode(host); await waitFor(() => !dialog("页眉页脚") && !dialog("导入 Word 文档"), "补验弹窗未卸载"); await removeVerificationDocuments([...records.values()]) }
    catch (error) { failure ||= error }
    finally { host.remove(); restorePreferences(savedPreferences) }
    if (failure) rejectFinished(failure); else resolveFinished()
  }
  const capture = context => { current = context }
  function ExampleHost() {
    const [record, setRecord] = useState(first)
    const change = next => {
      // 只纳入未入库的新建/导入文档；已存在的文档库记录不属于本例清理范围。
      if (!next.storageVersion && !next.id) records.set(next.document.id, next)
      setRecord(next)
    }
    return <>
      <p>补验专用长文：可在页面工具中设置页眉页脚、检查窄窗口焦点，再导出 HTML、Word 或系统 PDF。PDF 关闭系统页眉页脚。</p>
      <button type="button" aria-label="结束页眉页脚补验" onClick={finish}>结束页眉页脚补验</button>
      <EditorProvider key={record.document.id} record={record}><Probe onReady={capture} onChange={change} /></EditorProvider>
    </>
  }
  try {
    localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    ReactDOM.render(<ExampleHost />, host)
    await waitFor(() => current?.editor && current.documentId === source.id && host.querySelector("[data-mewoc-editor-surface]"), "页眉页脚补验 Workspace 未就绪")
    current.store.getState().updateView({ activeTab: "页面", outlineOpen: false, fitWidth: false, zoom: 1 })
    await finished
  } catch (error) {
    if (!closing) { await finish(); await finished.catch(() => {}) }
    throw error
  }
}
