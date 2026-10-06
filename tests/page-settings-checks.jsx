/**
 * M21 在真实 Workspace 验证纸张、水印、保存和静态 HTML；输入与选区为明确的合成事件。
 * 专用随机文档隔离测试数据，保存排空后精确清理，包括本轮创建的历史版本。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import { closeHistory } from "@tiptap/pm/history"
import { TextSelection } from "@tiptap/pm/state"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { DocumentHistoryAction } from "../src/pages/editor/components/DocumentHistoryAction.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { getPageDimensions, DEFAULT_WATERMARK } from "../src/pages/editor/tools/page-settings.js"
import { getWatermarkGeometry } from "../src/pages/editor/tools/page-watermark.js"
import { getPagePagination, PAGE_PAGINATION_KEY } from "../src/pages/editor/extensions/page-pagination.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { TOOLBAR_MODE_KEY, TOOLBAR_MODES } from "../src/pages/editor/tools/toolbar-preferences.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const delay = () => new Promise(resolve => setTimeout(resolve, 40))
const waitFor = async (read, message) => { const end = Date.now() + 10000; while (Date.now() < end) { const value = await read(); if (value) return value; await delay() } throw new Error(message) }
const visible = element => !!element?.getClientRects().length && !element.closest("[hidden]") && getComputedStyle(element).visibility !== "hidden"
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(element => visible(element) && (element.getAttribute("aria-label") || element.textContent).replace(/\s/g, "") === name.replace(/\s/g, ""))
const dialog = name => [...document.querySelectorAll('[role="dialog"]')].find(element => visible(element) && element.querySelector(".ant-modal-title")?.textContent === name)
const field = name => dialog("纸张设置")?.querySelector(`[aria-label="${name}"]`)
const json = value => JSON.stringify(value)
const content = editor => json(editor.getJSON())
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const fixture = () => ({ type: "doc", content: [paragraph("页面设置正文，不应包含水印文字。"), paragraph("第二段保留选择和撤销历史。"), ...Array.from({ length: 14 }, (_, index) => paragraph(`${index + 1} · ` + "长正文保持正常编辑。".repeat(10)))] })
const setInput = (element, value) => { assert(element instanceof HTMLInputElement, "纸张输入不存在"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, String(value)); element.dispatchEvent(new Event("input", { bubbles: true })) }
const setSelect = (element, value) => { assert(element instanceof HTMLSelectElement, "纸张选项不存在"); element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })) }
const near = (left, right, tolerance = 0.6) => Math.abs(left - right) < tolerance
function Probe({ onContext }) { const context = useDocumentEditor(); useEffect(() => { if (context.editor) onContext(context) }, [context, onContext]); return <EditorWorkspace onDocumentChange={() => {}} /> }

export async function runPageSettingsChecks(report = () => {}) {
  const preferences = new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
  const records = new Map()
  const host = document.createElement("div")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:900px;margin:24px 0"
  document.body.append(host)
  let current
  const toolbar = () => host.querySelector("[data-toolbar-mode]")
  const paper = () => host.querySelector("[data-mewoc-editor-surface]")
  const sheets = () => [...(paper()?.querySelectorAll("[data-mewoc-page-layer] > [data-mewoc-page-index]") || [])]
  const watermark = () => paper().querySelector("[data-mewoc-watermark]")
  const settledPages = async () => {
    await delay()
    return waitFor(() => {
      const state = PAGE_PAGINATION_KEY.getState(current.editor.state)
      const layout = getPagePagination(current.editor)
      return state?.settings.enabled && !state.pending && layout.pageCount > 0 && sheets().length === layout.pageCount &&
        paper()?.getAttribute("data-mewoc-pagination-status") === layout.status && layout
    }, "页面设置后的分页纸面未就绪")
  }
  const panel = () => [...host.querySelectorAll('[role="tabpanel"]')].find(visible)
  const menuItem = name => [...document.querySelectorAll('[role="menuitemradio"]')].find(element => visible(element) && element.textContent === name)
  const mode = async value => { if (toolbar().dataset.toolbarMode === value) return; button(host, "切换工具栏").click(); const label = TOOLBAR_MODES.find(item => item.key === value).label; (await waitFor(() => menuItem(label), "页面模式菜单未打开")).click(); await waitFor(() => toolbar().dataset.toolbarMode === value && !menuItem(label), "页面模式未切换") }
  const pagePanel = async () => { current.store.getState().updateView({ activeTab: "页面" }); return waitFor(() => panel()?.getAttribute("aria-label") === "页面工具" && panel(), "页面工具未显示") }
  const unmount = async () => { if (current?.editor && !current.editor.isDestroyed) await current.saveDocument(); ReactDOM.unmountComponentAtNode(host); current = null; await delay() }
  const mount = async record => {
    await unmount(); localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    if (!record) { const document = { ...createDocument(), title: `页面增强验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, content: fixture() }; const assets = new Map(); const saved = await saveLocalDocument(document, assets, 0); record = { document, assets, storageVersion: saved.storageVersion }; records.set(document.id, { document, assets }) }
    ReactDOM.render(<EditorProvider record={record}><Probe onContext={context => { current = context }} /></EditorProvider>, host)
    await waitFor(() => current?.editor && current.documentId === record.document.id && paper(), "页面 Workspace 未就绪")
    current.store.getState().updateView({ activeTab: "页面", outlineOpen: false, fitWidth: false, zoom: 1 }); await pagePanel(); await settledPages(); return current
  }
  const open = async () => { await pagePanel(); (await waitFor(() => button(panel(), "纸张设置")?.disabled === false && button(panel(), "纸张设置"), "纸张设置不可用")).click(); return waitFor(() => dialog("纸张设置"), "纸张表单未打开") }
  const put = async (name, value) => { setInput(field(name), value); await delay() }
  const choose = async (name, value) => { setSelect(field(name), value); await delay() }
  const enable = async value => { const control = field("文字水印"); if (control.checked !== value) control.click(); await delay() }
  const apply = async () => { const control = button(dialog("纸张设置"), "应用"); assert(control && !control.disabled, "页面应用不可用"); control.click(); await waitFor(() => !dialog("纸张设置"), "页面应用未关闭"); await settledPages() }
  const cancel = async () => { button(dialog("纸张设置"), "取消").click(); await waitFor(() => !dialog("纸张设置"), "页面取消未关闭") }
  const submitInvalid = async () => { const before = json(current.store.getState().page); const revision = current.store.getState().revision; dialog("纸张设置").querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await waitFor(() => dialog("纸张设置")?.querySelector('[role="alert"]'), "页面无效草稿没有错误"); assert(json(current.store.getState().page) === before && current.store.getState().revision === revision, "无效草稿改写页面或修订") }
  const setWatermark = async (text = "审阅水印") => { await open(); await enable(true); await put("水印文字", text); await apply(); return current.store.getState().page }
  const check = async (name, run) => { try { await mount(); await run(current); report({ name, passed: true }) } catch (error) { report({ name, passed: false, error: error.message }) } finally { await unmount() } }
  try {
    await check("纸张：两种工具栏中四种规格及横竖方向真实改变纸面尺寸与说明", async ({ store }) => {
      for (const value of ["ribbon", "compact"]) { await mode(value); for (const size of ["A3", "A4", "A5", "Letter"]) for (const orientation of ["portrait", "landscape"]) { await open(); await choose("纸张规格", size); dialog("纸张设置").querySelector(`input[name="page-orientation"][value="${orientation}"]`).click(); await delay(); await apply(); const dimensions = getPageDimensions(store.getState().page); await waitFor(() => near(paper().getBoundingClientRect().width, dimensions.widthMm * 96 / 25.4), "纸型没有真实改变画布宽度"); assert(near(parseFloat(getComputedStyle(paper()).minHeight), dimensions.heightMm * 96 / 25.4) && host.querySelector("[data-page-settings-summary]").textContent.includes(`${size} · ${orientation === "portrait" ? "纵向" : "横向"}`), "纸面高度或规格方向说明错误") } }
    })
    await check("页边距：预设及非对称自定义，空值、负数和不足40mm正文区域拒绝应用", async ({ store }) => {
      await open(); for (const [id, amount] of [["normal", 20], ["narrow", 12.7], ["wide", 25.4]]) { await choose("边距预设", id); for (const label of ["上", "右", "下", "左"]) assert(Number(field(`${label}边距（mm）`).value) === amount, "边距预设未填满四边") } await put("左边距（mm）", 31.5); await put("上边距（mm）", 15); assert(field("边距预设").value === "custom", "非对称边距没有标自定义"); await apply(); assert(store.getState().page.marginsMm.left === 31.5 && near(parseFloat(getComputedStyle(paper()).paddingLeft), 31.5 * 96 / 25.4), "自定义边距未真实应用"); await open(); for (const invalid of ["", -1, 200]) { await put("左边距（mm）", invalid); await submitInvalid() } await put("左边距（mm）", 144.6); await put("右边距（mm）", 25.4); await apply(); assert(near(store.getState().page.marginsMm.left + store.getState().page.marginsMm.right, 170), "恰好40mm正文的合法边界被拒绝")
    })
    await check("水印草稿：即时预览规格、文字、颜色透明角度，取消不修改正文或页面", async ({ editor, store }) => {
      const before = json(store.getState().page); const revision = store.getState().revision; const text = content(editor); await open(); await choose("纸张规格", "A5"); await enable(true); await put("水印文字", "预览 <草稿> & 保留"); await put("水印颜色", "#123456"); await put("不透明度（%）", 35); await put("水印角度（°）", 23)
      // 实测控件几何，防止通用字段选择器覆盖紧凑 radio / 色块，挤掉标签或 HEX 输入。
      for (const label of dialog("纸张设置").querySelectorAll('[role="radiogroup"] label')) { const radio = label.querySelector("input").getBoundingClientRect(); assert(radio.width <= 20 && radio.height <= 20 && label.getBoundingClientRect().height < 30, "方向单选框被撑满或文字变成竖排") }
      const swatch = field("选择水印颜色").getBoundingClientRect(); const hex = field("水印颜色").getBoundingClientRect(); assert(near(swatch.width, 42) && hex.width > 150 && near(swatch.top, hex.top) && swatch.right <= hex.left, "颜色块没有保持42px或HEX框被挤掉/不在同一行")
      const preview = dialog("纸张设置").querySelector("[data-page-settings-preview]"); const svg = preview.querySelector("[data-mewoc-watermark]"); const node = svg.querySelector("text"); assert(svg.getAttribute("viewBox") === "0 0 148 210" && node.textContent === "预览 <草稿> & 保留" && node.getAttribute("transform") === "rotate(23 74 105)" && getComputedStyle(node).fill === "rgb(18, 52, 86)" && getComputedStyle(node).opacity === "0.35", "草稿预览没有准确呈现水印"); assert(!watermark() && json(store.getState().page) === before && store.getState().revision === revision && content(editor) === text, "预览提前写入页面或正文"); await cancel(); assert(json(store.getState().page) === before && !watermark(), "取消水印仍改了页面")
    })
    await check("水印：每页一层置于文字下方，不影响布局、选区、正文统计、复制及正文撤销", async ({ editor, store }) => {
      const before = content(editor)
      editor.view.dispatch(closeHistory(editor.state.tr)); editor.commands.insertContentAt(2, "可撤销正文"); editor.view.dispatch(closeHistory(editor.state.tr))
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 5)))
      const initialLayout = await settledPages()
      assert(initialLayout.pageCount > 1 && initialLayout.overflowCount === 0, "水印夹具没有实际形成多张标准编辑页")
      const selected = json(editor.state.selection.toJSON()); const text = editor.getText()
      const shape = { height: paper().offsetHeight, width: paper().offsetWidth, bodyHeight: editor.view.dom.offsetHeight }
      const currentBody = content(editor)
      await setWatermark("  水印 <script>保留文字</script>  ")
      assert(paper().querySelectorAll("[data-mewoc-watermark]").length === sheets().length, "编辑页水印数量不足或重复绘制")
      for (const sheet of sheets()) {
        const layers = sheet.querySelectorAll("[data-mewoc-watermark]")
        const layer = layers[0]
        assert(layers.length === 1 && layer.getAttribute("aria-hidden") === "true" && getComputedStyle(layer).pointerEvents === "none" && getComputedStyle(layer).userSelect === "none", "水印层截获操作或同一页重复绘制")
        assert(getComputedStyle(layer).zIndex === "0" && getComputedStyle(paper().querySelector("[data-mewoc-editor-body]")).zIndex === "1", "水印不在正文下方")
        assert(layer.querySelector("text").textContent === "水印 <script>保留文字</script>" && !layer.querySelector("script"), "水印文字没有安全转义或去掉首尾空白")
      }
      assert(content(editor) === currentBody && editor.getText() === text && json(editor.state.selection.toJSON()) === selected && shape.height === paper().offsetHeight && shape.width === paper().offsetWidth && shape.bodyHeight === editor.view.dom.offsetHeight, "水印改变正文、选择、统计或布局")
      const copied = editor.view.serializeForClipboard(editor.state.selection.content())
      assert(!copied.dom.querySelector("svg, [data-mewoc-page-gap]") && !copied.text.includes("水印"), "水印或分页装饰混入复制正文")
      assert(editor.commands.undo() && content(editor) === before && store.getState().page.watermark, "页面设置占用了正文撤销或随正文撤销丢失")
    })
    await check("水印校验：空文字、非法颜色、透明度和角度越界都保留错误草稿且不提交", async () => {
      await open(); await enable(true); for (const [name, value, valid] of [["水印文字", " ", "合法水印"], ["水印文字", "长".repeat(81), "合法水印"], ["水印颜色", "red", "#797087"], ["不透明度（%）", 4.9, 12], ["不透明度（%）", 50.1, 12], ["水印角度（°）", -91, -35], ["水印角度（°）", 91, -35]]) { await put(name, value); await submitInvalid(); await put(name, valid) } assert(field("水印文字").maxLength >= 160, "原生字符上限不能容纳80个Unicode代理对"); await put("水印文字", "😀".repeat(80)); await apply(); assert(Array.from(current.store.getState().page.watermark.text).length === 80, "80个Unicode码点的合法水印被拒绝")
    })
    await check("页面草稿：跨标签与极简模式保留，未修改的并发边距和水印字段不被覆盖", async ({ store }) => {
      await setWatermark(); await open(); await put("左边距（mm）", 31); await put("水印文字", "新文字"); const updated = structuredClone(store.getState().page); updated.marginsMm.right = 22; updated.watermark.color = "#0a5b7c"; updated.watermark.opacity = 0.3; store.getState().updatePage(updated); store.getState().updateView({ activeTab: "插入" }); await mode("compact"); assert(field("左边距（mm）").value === "31" && field("水印文字").value === "新文字", "跨模式丢失页面草稿"); await apply(); const page = store.getState().page; assert(page.marginsMm.left === 31 && page.marginsMm.right === 22 && page.watermark.text === "新文字" && page.watermark.color === "#0a5b7c" && page.watermark.opacity === 0.3, "旧页面草稿覆盖未修改的并发字段")
    })
    await check("页面提交：实时只读、切换及组合输入拒绝，恢复后保留草稿；新会话不接收旧草稿", async ({ editor, store }) => {
      await open(); await choose("纸张规格", "A5"); for (const reason of ["readOnly", "switching", "composition"]) { if (reason === "composition") editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); else store.getState().updateView({ [reason]: true }); await waitFor(() => reason === "composition" ? editor.view.composing : !editor.isEditable, "页面禁写未生效"); await submitInvalid(); assert(field("纸张规格").value === "A5", "禁写丢失纸张草稿"); if (reason === "composition") { editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); await waitFor(() => !editor.view.composing, "组合输入未结束") } else { store.getState().updateView({ [reason]: false }); await waitFor(() => editor.isEditable, "页面恢复编辑失败") } } await apply(); assert(store.getState().page.size === "A5", "恢复后草稿没有应用"); await open(); await choose("纸张规格", "A3"); await mount(); assert(!dialog("纸张设置") && current.store.getState().page.size === "A4", "旧页面草稿进入新会话")
    })
    await check("页面保存：非A4水印保存重开与Mewoc往返，关闭水印和无修改应用不制造额外修订", async context => {
      await open(); await choose("纸张规格", "Letter"); await choose("边距预设", "narrow"); await enable(true); await put("水印文字", "持久水印"); await apply(); assert(await context.saveDocument(), "页面保存失败"); const expected = json(context.store.getState().page); const record = await getLocalDocument(context.documentId); const reopened = await mount({ ...record, assets: new Map() }); assert(json(reopened.store.getState().page) === expected && watermark().querySelector("text").textContent === "持久水印", "同ID重开丢水印/规格"); const portable = await createPortableFile(reopened.getSnapshot(), reopened.assets); const imported = await readPortableFile(new File([JSON.stringify(portable)], "page-settings.mewoc.json")); assert(json(imported.document.page) === expected, "Mewoc往返丢页面设置"); await open(); await enable(false); await apply(); assert(current.store.getState().page.watermark === null && !watermark(), "关闭水印没有持久语义"); const revision = current.store.getState().revision; await open(); await apply(); assert(current.store.getState().revision === revision, "未修改页面应用制造了修订")
    })
    await check("水印几何：80字及90度在横竖纸面内，缩放保持比例且每张编辑页只有一次水印", async ({ store }) => {
      for (const orientation of ["portrait", "landscape"]) {
        await open(); await choose("纸张规格", "A5"); dialog("纸张设置").querySelector(`input[value="${orientation}"]`).click()
        await enable(true); await put("水印文字", "长".repeat(80)); await put("水印角度（°）", 90); await apply()
        const page = store.getState().page; const geometry = getWatermarkGeometry(page); const dimensions = getPageDimensions(page)
        const pageCount = getPagePagination(current.editor).pageCount
        assert(pageCount > 1, "A5 水印夹具没有实际形成多个编辑页")
        for (const zoom of [0.75, 1, 1.25]) {
          store.getState().updateView({ zoom }); const layout = await settledPages()
          assert(layout.pageCount === pageCount && paper().querySelectorAll("[data-mewoc-watermark]").length === pageCount, "缩放改变分页或页面水印重复/遗漏")
          for (const sheet of sheets()) {
            const svg = sheet.querySelector("[data-mewoc-watermark]"); const box = svg.getBoundingClientRect(); const paperBox = sheet.getBoundingClientRect()
            assert(near(box.width, dimensions.widthMm * 96 / 25.4 * zoom) && near(box.height, dimensions.heightMm * 96 / 25.4 * zoom) && svg.querySelector("text").textContent.length === 80, "水印没有随真实纸面同比缩放")
            const textBox = svg.querySelector("text").getBBox()
            assert(textBox.height <= geometry.textHeightMm * 1.2 && geometry.textWidthMm <= dimensions.heightMm * 0.78 + 0.01 && box.top >= paperBox.top - 1 && box.bottom <= paperBox.bottom + 1, "长水印或旋转后超出对应纸面")
          }
        }
      }
    })
    await check("离线HTML：实际iframe纸型、边距、水印同几何且正文与源快照保持原样", async context => {
      await open(); await choose("纸张规格", "A3"); dialog("纸张设置").querySelector('input[value="landscape"]').click(); await choose("边距预设", "wide"); await enable(true); await put("水印文字", "静态 <草稿> & 水印"); await put("水印颜色", "#125678"); await put("不透明度（%）", 20); await put("水印角度（°）", -30); await apply(); const before = content(context.editor); const source = context.getSnapshot(); const frame = document.createElement("iframe"); frame.style.cssText = "width:900px;height:600px;border:0"; host.append(frame); try { frame.srcdoc = await createDocumentHtml(source, context.assets); const document = await waitFor(() => frame.contentDocument?.querySelector(".mewoc-export-watermark") && frame.contentDocument, "页面HTML水印未载入"); const paper = document.querySelector(".mewoc-export-page"); const svg = document.querySelector(".mewoc-export-watermark svg"); const text = svg.querySelector("text"); assert(near(parseFloat(frame.contentWindow.getComputedStyle(paper).width), 420 * 96 / 25.4) && near(parseFloat(frame.contentWindow.getComputedStyle(paper).paddingLeft), 25.4 * 96 / 25.4) && svg.getAttribute("viewBox") === "0 0 420 297" && text.textContent === "静态 <草稿> & 水印", "HTML纸型/边距/安全水印错误"); assert(text.getAttribute("transform") === "rotate(-30 210 148.5)" && frame.contentWindow.getComputedStyle(text).opacity === "0.2" && document.querySelectorAll(".mewoc-export-watermark").length === 1 && !document.querySelector("article svg"), "HTML水印角度透明度错误或混入正文"); assert(document.querySelector("article").textContent.includes("第二段保留") && content(context.editor) === before && json(context.store.getState().page) === json(source.page), "HTML导出改写来源") } finally { frame.remove() }
    })
    await check("历史版本：真实只读预览从A5快照显示水印和比例，不误读当前A3页面", async context => {
      await open(); await choose("纸张规格", "A5"); await enable(true); await put("水印文字", "历史水印"); await apply(); await context.saveDocument(); const saved = await getLocalDocument(context.documentId); const version = await createDocumentVersion(context.documentId, saved.storageVersion, "A5水印检查点"); const updated = { ...context.store.getState().page, size: "A3", watermark: { ...DEFAULT_WATERMARK, text: "当前水印" } }; context.store.getState().updatePage(updated); const revision = context.store.getState().revision; const previewHost = document.createElement("div"); host.append(previewHost); try { ReactDOM.render(<DocumentHistoryAction record={{ id: context.documentId, document: saved.document }} currentDocumentId={context.documentId} initialOpen onPrepare={() => true} />, previewHost); const history = await waitFor(() => dialog("历史版本")?.querySelector(`[data-version-id="${version.id}"]`) && dialog("历史版本"), "历史版本列表未显示"); button(history.querySelector(`[data-version-id="${version.id}"]`), "预览").click(); const preview = await waitFor(() => history.querySelector('[aria-label="历史版本正文"]') && history.querySelector('[aria-label="版本预览"] [data-mewoc-watermark]'), "历史版本水印未真实呈现"); assert(preview.getAttribute("viewBox") === "0 0 148 210" && preview.querySelector("text").textContent === "历史水印" && history.querySelector('[aria-label="版本预览"]').textContent.includes("A5竖向"), "历史预览使用当前A3或水印而非版本快照"); assert(context.store.getState().page.size === "A3" && context.store.getState().revision === revision, "浏览历史页面改变当前文档") } finally { ReactDOM.unmountComponentAtNode(previewHost); previewHost.remove(); await delay() }
    })
  } finally { await unmount(); host.remove(); await removeVerificationDocuments([...records.values()]); for (const [key, value] of preferences) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } }
}
