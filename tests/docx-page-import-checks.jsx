/**
 * M22 浏览器专项走真实 DOCX Worker、导入预览、保存后切换与完整 EditorProvider。
 * 文件输入使用合成 files/change；此项不替代原生选择器和系统打印的手动验收。
 * 随机文档 ID、精确清理和 finally 全局还原保证本轮不影响用户文档或后续专项。
 */
import { useEffect, useState } from "react"
import ReactDOM from "react-dom"
import JSZip from "jszip"
import { EditorContext, EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { FileActions } from "../src/pages/editor/components/FileActions.jsx"
import { DocxImportAction } from "../src/pages/editor/components/DocxImportAction.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { PAGE_SIZES } from "../src/pages/editor/tools/page-settings.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { readDocxDocument } from "../src/pages/editor/tools/docx-import-file.js"
import { runDocxImportWorker } from "../src/pages/editor/tools/docx-import-session.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { TOOLBAR_MODE_KEY } from "../src/pages/editor/tools/toolbar-preferences.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (value, message) => { if (!value) throw new Error(message) }
const delay = (milliseconds = 30) => new Promise(resolve => setTimeout(resolve, milliseconds))
const waitFor = async (read, message) => { const end = Date.now() + 12000; while (Date.now() < end) { const value = await read(); if (value) return value; await delay() } throw new Error(message) }
const visible = node => !!node?.getClientRects().length && getComputedStyle(node).visibility !== "hidden"
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(node => visible(node) && (node.getAttribute("aria-label") || node.textContent).replace(/\s/g, "") === name.replace(/\s/g, ""))
const dialog = () => [...document.querySelectorAll('[role="dialog"]')].find(node => visible(node) && node.querySelector(".ant-modal-title")?.textContent === "导入 Word 文档")
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const fixture = (size = "A5", orientation = "landscape", text = "导入页面正文，水印不属于正文。") => ({ ...createDocument(), title: `M22 页面往返-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  page: { size, orientation, marginsMm: { top: 12.345, right: 17.125, bottom: 19.675, left: 23.875 }, watermark: { text: "内部资料 M22", color: "#6554C0", opacity: 0.18, angle: -35 } },
  content: { type: "doc", content: [paragraph(text), paragraph("第二段继续完整保留。") ] } })
const json = value => JSON.stringify(value)
// getSnapshot 每次更新时间；会话隔离断言只比较实际可编辑文档字段和修订号。
const snapshotContent = context => json({ id: context.documentId, page: context.getSnapshot().page, content: context.editor.getJSON(), title: context.store.getState().title, revision: context.store.getState().revision })
const assertPage = (actual, expected) => {
  assert(actual.size === expected.size && actual.orientation === expected.orientation, "纸型或方向未恢复")
  for (const side of ["top", "right", "bottom", "left"]) assert(Math.abs(actual.marginsMm[side] - expected.marginsMm[side]) <= 0.02, `${side} 边距未恢复`)
  for (const key of ["text", "color", "opacity", "angle"]) assert(actual.watermark?.[key] === expected.watermark?.[key], `水印 ${key} 未完整恢复`)
}
const toFile = async (document, name = "页面往返.docx") => new File([(await createDocumentDocx(document, new Map())).blob], name)
// 只以 DOM 输入触发生产导入流程；File 字节、后台解压、记录校验均执行真实实现。
const choose = file => {
  const input = dialog()?.querySelector('input[aria-label="选择 Word 文件"]')
  assert(input, "Word 文件控件不存在")
  Object.defineProperty(input, "files", { configurable: true, value: [file] })
  input.dispatchEvent(new Event("change", { bubbles: true }))
}
const ready = () => waitFor(() => dialog()?.querySelector('textarea[aria-label="Word 导入正文预览"]'), "Word 页面预览未生成")
function Probe({ onReady, onChange }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onReady(context) }, [context, onReady])
  return <EditorWorkspace onDocumentChange={onChange} />
}

export async function runDocxPageImportChecks(report = () => {}) {
  const preferences = new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
  const nativeWorker = window.Worker
  let workers = 0
  let started = 0
  let ended = 0
  // 包装只观察真实线程，不替换转换结果；每个 Worker 的 terminate 仅累计一次。
  window.Worker = class extends nativeWorker {
    constructor(...args) { super(...args); workers += 1; started += 1 }
    terminate() { if (!this.m22Ended) { this.m22Ended = true; workers -= 1; ended += 1 } super.terminate() }
  }
  const records = new Map()
  const host = document.createElement("div")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:900px;margin:24px 0"
  document.body.append(host)
  let current
  let activeRecord
  const capture = context => { current = context }
  function SessionHost({ record }) {
    const [selected, setSelected] = useState(record)
    const change = next => { activeRecord = next; records.set(next.document.id, next); setSelected(next) }
    return <EditorProvider key={selected.document.id} record={selected}><Probe onReady={capture} onChange={change} /></EditorProvider>
  }
  const unmount = async () => {
    // 排空真正 Provider 的保存队列后再卸载，否则迟到保存可能复活已删除的专项文档。
    if (current?.editor && !current.editor.isDestroyed) await current.saveDocument()
    ReactDOM.unmountComponentAtNode(host)
    current = null
    activeRecord = null
    await waitFor(() => !dialog(), "导入弹窗未随宿主卸载")
  }
  const mount = async record => {
    await unmount()
    localStorage.removeItem(TOOLBAR_MODE_KEY)
    localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    if (!record) {
      const document = fixture("A4", "portrait", "必须保留的原会话正文。")
      document.page.watermark = null
      const assets = new Map()
      const saved = await saveLocalDocument(document, assets, 0)
      record = { document, assets, storageVersion: saved.storageVersion }
    }
    activeRecord = record
    records.set(record.document.id, record)
    ReactDOM.render(<SessionHost record={record} />, host)
    await waitFor(() => current?.documentId === record.document.id && current.editor && host.querySelector("[data-mewoc-editor-surface]"), "导入验收 Provider 未就绪")
    current.store.getState().updateView({ outlineOpen: false, fitWidth: false, zoom: 1 })
    return current
  }
  const open = async () => { button(host, "导入 Word").click(); return waitFor(dialog, "Word 导入弹窗未打开") }
  const cancel = async () => { button(dialog(), "取消").click(); await waitFor(() => !dialog(), "Word 导入取消未关闭") }
  const check = async (name, action) => {
    try { await action(); assert(workers === 0, "本项完成后仍有转换 Worker"); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
    finally { await unmount() }
  }
  try {
    await check("Word 页面：真实 Worker 恢复四种纸型横竖方向和非对称边距", async () => {
      const before = started
      for (const size of Object.keys(PAGE_SIZES)) for (const orientation of ["portrait", "landscape"]) {
        const source = fixture(size, orientation)
        const { record, preview } = await readDocxDocument(await toFile(source))
        assertPage(record.document.page, source.page)
        assert(preview.includes("导入页面正文") && !preview.includes(source.page.watermark.text), "装饰混入正文或正文丢失")
      }
      assert(started === before + 8 && ended === started, "矩阵未执行八个真实 Worker 或未释放")
    })
    await check("Word 页面：80 emoji 与正负 90 度完整往返，取消 Worker 后可重新导入", async () => {
      for (const angle of [-90, 90]) {
        const source = fixture()
        source.page.watermark = { ...source.page.watermark, text: "😀".repeat(80), angle }
        const file = await toFile(source)
        const controller = new AbortController()
        const pending = runDocxImportWorker(await file.arrayBuffer(), controller.signal)
        controller.abort()
        let aborted = false
        try { await pending } catch (error) { aborted = error.name === "AbortError" }
        assert(aborted && workers === 0, "取消未收口线程")
        const { record } = await readDocxDocument(file)
        assertPage(record.document.page, source.page)
        assert([...record.document.page.watermark.text].length === 80, "emoji 被截断")
      }
    })
    await check("Word 页面：预览显示纸张摘要和独立水印，取消保持原会话页面与正文", async () => {
      const source = fixture()
      const context = await mount()
      const before = snapshotContent(context)
      const id = context.documentId
      await open()
      choose(await toFile(source))
      const body = await ready()
      const preview = dialog().querySelector("[data-docx-import-page-preview]")
      const summary = dialog().querySelector('[aria-label="Word 导入页面设置"]')
      assert(summary?.textContent.includes("A5横向") && summary.textContent.includes("页边距") && summary.textContent.includes(source.page.watermark.text), "预览页面摘要缺失")
      const layer = preview?.querySelector("[data-mewoc-watermark]")
      assert(layer?.querySelector("text")?.textContent === source.page.watermark.text, "预览水印图层缺失")
      assert(getComputedStyle(layer).pointerEvents === "none", "水印阻挡预览交互")
      assert(body.value.includes("导入页面正文") && !body.value.includes(source.page.watermark.text), "纯文本预览混入水印")
      assert(context.documentId === id && snapshotContent(context) === before, "确认前改写原会话")
      await cancel()
      assert(current === context && snapshotContent(context) === before, "取消后仍更改原文档")
    })
    await check("Word 页面：读取中更换文件中止旧 Worker，旧纸张和水印不能覆盖新预览", async () => {
      await mount()
      const first = fixture("A3", "landscape", "旧文件正文。")
      const second = fixture("Letter", "portrait", "新文件正文。")
      first.page.watermark.text = "旧文件水印"
      second.page.watermark.text = "新文件水印"
      const firstFile = await toFile(first, "旧页面.docx")
      const secondFile = await toFile(second, "新页面.docx")
      await open()
      choose(firstFile)
      await waitFor(() => workers === 1, "旧文件未进入 Worker")
      choose(secondFile)
      const preview = await ready()
      await delay(150)
      const summary = dialog().querySelector('[aria-label="Word 导入页面设置"]')?.textContent
      assert(summary?.includes("Letter竖向") && summary.includes("新文件水印") && !summary.includes("旧文件水印"), "陈旧页面回写预览")
      assert(preview.value.includes("新文件正文") && !preview.value.includes("旧文件正文"), "陈旧正文回写预览")
      await cancel()
    })
    await check("Word 页面：未知 VML 失败可换好文件，保存失败保留预览并只确认一次", async () => {
      const source = fixture()
      const file = await toFile(source)
      const zip = await JSZip.loadAsync(await file.arrayBuffer())
      const header = zip.file(/^word\/header\d+\.xml$/)[0]
      zip.file(header.name, (await header.async("string")).replace("</w:hdr>", "<w:p><w:r><w:pict><v:rect/></w:pict></w:r></w:p></w:hdr>"))
      const bad = new File([await zip.generateAsync({ type: "arraybuffer" })], "未知图形.docx")
      let saved = false
      let saves = 0
      let changed
      const state = { readOnly: false, updateView: () => {} }
      // 仅控制父级保存是否成功；转换、FileActions 同步锁和后续新记录仍采用真实实现。
      ReactDOM.render(<EditorContext.Provider value={{ editor: { setEditable: () => {} }, store: { getState: () => state }, uploading: false,
        saveDocument: async () => { saves += 1; return saved } }}><FileActions onDocumentChange={record => { changed = record }} /></EditorContext.Provider>, host)
      await open()
      choose(bad)
      await waitFor(() => dialog()?.querySelector('[role="alert"]')?.textContent.match(/旧式|图形|水印/), "未知 VML 未提示失败")
      assert(!dialog().querySelector('textarea[aria-label="Word 导入正文预览"]'), "失败文件仍有部分预览")
      choose(file)
      await ready()
      button(dialog(), "导入为新文档").click()
      await waitFor(() => dialog()?.textContent.includes("当前文档未能保存"), "保存失败未回显")
      assert(!changed && saves === 1 && dialog().querySelector("[data-docx-import-page-preview]"), "失败丢失预览或仍切换")
      saved = true
      const confirm = button(dialog(), "导入为新文档")
      confirm.click()
      confirm.click()
      await waitFor(() => changed && !dialog(), "重试后未切换")
      assert(saves === 2, "重复提交多次保存")
      assertPage(changed.document.page, source.page)
    })
    await check("Word 页面：确认重建真实 Provider，保存重开与 Mewoc 备份均保留导入页面", async () => {
      const source = fixture()
      const old = await mount()
      const oldId = old.documentId
      await open()
      choose(await toFile(source))
      await ready()
      button(dialog(), "导入为新文档").click()
      await waitFor(() => current?.documentId !== oldId && !dialog(), "确认没有重建新 Provider")
      assertPage(current.getSnapshot().page, source.page)
      assert(current.editor.getText().includes("导入页面正文"), "确认后正文丢失")
      const layer = host.querySelector("[data-mewoc-editor-surface] [data-mewoc-watermark]")
      assert(layer?.querySelector("text")?.textContent === source.page.watermark.text, "编辑区未绘制导入水印")
      await current.saveDocument()
      const importedId = activeRecord.document.id
      const saved = await getLocalDocument(importedId)
      const page = structuredClone(saved.document.page)
      await mount({ ...saved, assets: new Map() })
      assert(json(current.getSnapshot().page) === json(page), "保存重开改变导入页面")
      const portable = await createPortableFile(current.getSnapshot(), current.assets)
      const reopened = await readPortableFile(new File([json(portable)], "导入页面.mewoc.json"))
      assert(reopened.document.id !== importedId && json(reopened.document.page) === json(page), "Mewoc 页面备份不能独立恢复")
      await mount(reopened)
      assertPage(current.getSnapshot().page, source.page)
      assert(current.editor.getText().includes("导入页面正文"), "Mewoc 重开正文丢失")
    })
    await check("Word 页面：导入后 HTML 展示实际纸面和水印，再导出 DOCX 仍能完整恢复", async () => {
      const source = fixture("Letter", "landscape")
      const { record } = await readDocxDocument(await toFile(source))
      await mount(record)
      const snapshot = current.getSnapshot()
      const html = await createDocumentHtml(snapshot, current.assets)
      const parsed = new DOMParser().parseFromString(html, "text/html")
      assert(parsed.querySelector("style").textContent.includes("size: 279.4mm 215.9mm"), "HTML 未使用导入纸张")
      assert(parsed.querySelectorAll(".mewoc-export-watermark").length === 1 && parsed.querySelector("svg text")?.textContent === source.page.watermark.text, "HTML 水印丢失或重复")
      assert(!parsed.querySelector("article").textContent.includes(source.page.watermark.text), "HTML 正文混入水印")
      const { record: roundtrip } = await readDocxDocument(await toFile(snapshot))
      assertPage(roundtrip.document.page, source.page)
      assert(roundtrip.document.content.content.length === record.document.content.content.length, "DOCX 再导入制造重复正文")
    })
    await check("Word 页面：取消读取与卸载中止真实 Worker，迟到结果不复活弹窗和页面", async () => {
      const file = await toFile(fixture())
      let imports = 0
      ReactDOM.render(<DocxImportAction onImport={() => { imports += 1 }} />, host)
      await open()
      choose(file)
      await waitFor(() => workers === 1, "取消测试未启动 Worker")
      await cancel()
      await delay(150)
      assert(workers === 0 && !dialog() && imports === 0, "取消仍保留旧转换")
      await open()
      choose(file)
      await waitFor(() => workers === 1, "卸载测试未启动 Worker")
      await unmount()
      await delay(150)
      assert(workers === 0 && !dialog() && imports === 0, "卸载后复活旧页面")
    })
  } finally {
    await unmount()
    // 只删除本轮确切文档 ID；不清空 IndexedDB，也不撤销其他会话的 URL。
    await removeVerificationDocuments([...records.values()])
    host.remove()
    window.Worker = nativeWorker
    for (const [key, value] of preferences) {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    }
  }
}

/**
 * 开发验收示例只代替扩展受限的选文件动作，之后的 Tab、取消、确认、编辑与打印交由真实 UI。
 * 此函数不会产生 passed 结果；只有点击结束按钮才排空保存并删除它独占创建的临时文档。
 */
export async function showDocxPageImportPreview() {
  const source = { ...createDocument(), title: "M22 · Word 页面补验",
    page: { size: "A5", orientation: "landscape", marginsMm: { top: 12.7, right: 17, bottom: 19, left: 23 },
      watermark: { text: "内部资料 M22", color: "#6554C0", opacity: 0.18, angle: -35 } },
    content: { type: "doc", content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "M22 · 页面与水印往返" }] },
      ...Array.from({ length: 12 }, (_, index) => paragraph(`${String(index + 1).padStart(2, "0")} · 页面补验正文。` + "本段用于检查横向 A5 纸张、四边非对称边距和跨页打印的文字水印。文字始终属于正文，装饰单独绘制；确认导入前原会话保持不变。".repeat(4)))
    ] } }
  const file = await toFile(source, "M22 页面补验.docx")
  const original = { ...createDocument(), title: `M22 补验原会话-${Date.now()}`,
    content: { type: "doc", content: [paragraph("这是补验专用原会话，取消 Word 预览后应仍保留这段文字。") ] } }
  const saved = await saveLocalDocument(original, new Map(), 0)
  const first = { document: original, assets: new Map(), storageVersion: saved.storageVersion }
  const records = new Map([[original.id, first]])
  const preferences = new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
  const host = document.createElement("section")
  host.dataset.docxPagePreviewExample = ""
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:950px;margin:24px 0"
  document.body.append(host)
  let current
  let closing = false
  let resolveFinished
  let rejectFinished
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
  // 结束按钮和初始化失败共用幂等清理；只删除本例自己新建的记录，不删除从文档库打开的已有文件。
  const finish = async () => {
    if (closing) return
    closing = true
    let failure
    try {
      if (current?.editor && !current.editor.isDestroyed && !await current.saveDocument()) throw new Error("页面补验会话未能完成保存")
    } catch (error) { failure = error }
    try {
      ReactDOM.unmountComponentAtNode(host)
      await waitFor(() => !dialog(), "页面补验的导入弹窗没有卸载")
      await removeVerificationDocuments([...records.values()])
    } catch (error) { failure ||= error }
    finally {
      host.remove()
      for (const [key, value] of preferences) {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
      }
    }
    if (failure) rejectFinished(failure)
    else resolveFinished()
  }
  const capture = context => { current = context }
  function PreviewHost() {
    const [record, setRecord] = useState(first)
    const change = next => {
      // 新 Word/Mewoc 文档的 storageVersion 为 0；已有库记录不属于本例清理范围。
      if (!next.storageVersion && !next.id) records.set(next.document.id, next)
      setRecord(next)
    }
    return <>
      <div>
        <p>此示例已用合成文件输入打开正式 Word 导入预览。可真实操作取消、确认、键盘焦点、编辑与打印；结束时只清理本例创建的文档。</p>
        <button type="button" aria-label="结束页面补验" onClick={finish}>结束页面补验</button>
      </div>
      <EditorProvider key={record.document.id} record={record}><Probe onReady={capture} onChange={change} /></EditorProvider>
    </>
  }
  try {
    localStorage.removeItem(TOOLBAR_MODE_KEY)
    localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    ReactDOM.render(<PreviewHost />, host)
    await waitFor(() => current?.editor && current.documentId === first.document.id && host.querySelector("[data-mewoc-editor-surface]"), "页面补验会话未就绪")
    current.store.getState().updateView({ outlineOpen: false, fitWidth: false, zoom: 1 })
    button(host, "导入 Word").click()
    await waitFor(dialog, "页面补验的导入弹窗未打开")
    choose(file)
    await ready()
    await finished
  } catch (error) {
    if (!closing) {
      // 初始化中断也要中止 DocxImportAction 的真实 Worker；不会把半份预览留到下一次打开。
      await finish()
      await finished.catch(() => {})
    }
    throw error
  }
}
