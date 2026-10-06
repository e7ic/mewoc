/**
 * M25 第一批使用正式 Workspace 与真实 DOM 几何验收，自动分页只属于屏幕视图。
 * 选区、键盘和组合输入为合成事件；不将其称为系统输入法、物理键鼠或打印页数验收。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import { closeHistory } from "@tiptap/pm/history"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { DEFAULT_WATERMARK, getPageDimensions } from "../src/pages/editor/tools/page-settings.js"
import { getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { createDocumentText } from "../src/pages/editor/tools/document-text.js"
import { readImageFile } from "../src/pages/editor/tools/image-assets.js"
import { readMediaFile } from "../src/pages/editor/tools/media-assets.js"
import { TOOLBAR_MODE_KEY } from "../src/pages/editor/tools/toolbar-preferences.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { createWaveFile } from "./media-fixtures.js"
import { removeVerificationDocuments } from "./browser-checks.js"
import { readParagraphGlyphs } from "./paragraph-pagination-checks.jsx"

const assert = (value, message) => { if (!value) throw new Error(message) }
const delay = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (read, message) => {
  const end = Date.now() + 12000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay() }
  throw new Error(message)
}
const json = value => JSON.stringify(value)
const paragraph = (text, attrs = {}) => ({ type: "paragraph", attrs, content: [{ type: "text", text }] })
const paragraphs = (count = 40) => Array.from({ length: count }, (_, i) => paragraph(`${i + 1}. 分页正文：` + "每段保持连续编辑，页面装饰独立显示。".repeat(4)))
const documentContent = nodes => ({ type: "doc", content: nodes })
const mm = value => value * 96 / 25.4
const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance
function Probe({ capture }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) capture(context) }, [context, capture])
  return <EditorWorkspace onDocumentChange={() => {}} />
}

export async function runPagePaginationChecks(report = () => {}) {
  const preferences = new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
  const records = new Map()
  const host = document.createElement("section")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:900px;margin:24px 0"
  document.body.append(host)
  let current
  const capture = context => { current = context }
  const surface = () => host.querySelector("[data-mewoc-editor-surface]")
  const layout = () => current.store.getState().pagination
  const settle = async () => {
    await document.fonts.ready
    let previous = ""; let stable = 0
    return waitFor(() => {
      const state = layout()
      if (!state?.pages?.length) return false
      const signature = json({ pages: state.pages, breaks: state.breaks, height: current.editor.view.dom.offsetHeight })
      stable = signature === previous ? stable + 1 : 0
      previous = signature
      return stable >= 3 && state
    }, "分页布局未收敛")
  }
  const nodes = () => {
    const result = []
    current.editor.state.doc.forEach((node, pos) => {
      const dom = current.editor.view.nodeDOM(pos)
      if (dom instanceof HTMLElement) result.push({ node, pos, dom })
    })
    return result
  }
  const blockPage = dom => {
    const state = current.store.getState(); const top = surface().getBoundingClientRect().top
    const rect = dom.getBoundingClientRect()
    const y = (rect.top - top) / state.zoom
    return layout().pages.find(page => y >= page.top - 2 && y < page.top + page.height - 2)
  }
  const verifyGeometry = () => {
    const state = current.store.getState(); const top = surface().getBoundingClientRect().top
    const dimensions = getPageDimensions(state.page)
    const measured = nodes().flatMap(block => {
      if (block.node.type.name !== "table") return [block]
      const rows = []
      block.node.forEach((node, offset) => { const pos = block.pos + 1 + offset; rows.push({ node, pos, dom: current.editor.view.nodeDOM(pos) }) })
      return rows
    })
    for (const { node, dom } of measured) {
      if (node.type.name === "pageBreak") continue
      // 一个 p/h 可横跨多页；只量真实文字，不能把含页间 span 的整段 rect 当成越界正文。
      const rects = ["paragraph", "heading"].includes(node.type.name) ? readParagraphGlyphs(current.editor, dom).map(item => item.rect) : [dom.getBoundingClientRect()]
      for (const rect of rects) {
        const start = (rect.top - top) / state.zoom; const end = (rect.bottom - top) / state.zoom
        const page = layout().pages.find(item => start >= item.top - 2 && start < item.top + item.height - 2)
        assert(page, `正文块 ${node.type.name} 不在任何纸面`)
        assert(start >= page.top + mm(state.page.marginsMm.top) - 2 && end <= page.top + page.height - mm(state.page.marginsMm.bottom) + 2, `${node.type.name} 覆盖页边距：${start.toFixed(1)}–${end.toFixed(1)} / ${page.top.toFixed(1)}–${page.height.toFixed(1)}`)
      }
    }
    for (const page of layout().pages) if (!page.overflow) assert(near(page.height, mm(dimensions.heightMm)), "正常页未使用所选物理纸高")
  }
  const unmount = async () => {
    try {
      if (current?.editor && !current.editor.isDestroyed) {
        current.store.getState().updateView({ readOnly: false, switching: false })
        assert(await current.saveDocument(), `分页清理前保存未排空：${current.store.getState().saveError}`)
      }
    } finally { ReactDOM.unmountComponentAtNode(host); current = null }
  }
  const mount = async (content = documentContent(paragraphs()), assets = new Map(), record) => {
    await unmount()
    localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    if (!record) {
      const source = { ...createDocument(), title: `M25 分页验收-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, content }
      const saved = await saveLocalDocument(source, assets, 0)
      record = { document: source, assets, storageVersion: saved.storageVersion }
    }
    records.set(record.document.id, record)
    ReactDOM.render(<EditorProvider key={record.document.id} record={record}><Probe capture={capture} /></EditorProvider>, host)
    await waitFor(() => current?.documentId === record.document.id && surface(), "分页 Workspace 未就绪")
    current.store.getState().updateView({ outlineOpen: false, searchOpen: false, zoom: 1, fitWidth: false })
    await settle()
    return current
  }
  const replace = async content => { assert(current.editor.commands.setContent(content), "测试正文未能替换"); return settle() }
  const check = async (name, run) => {
    let metrics; let failure
    try { await mount(); metrics = await run(current) }
    catch (error) { failure = error }
    finally { try { await unmount() } catch (error) { failure ||= error } }
    report({ name, passed: !failure, ...(failure ? { error: failure.message } : metrics && { metrics }) })
  }
  try {
    await check("自动分页：短段落实测多页，正文不越上下边距，分页事务不制造修订", async ({ editor, store }) => {
      assert(layout().pageCount >= 3 && layout().overflowCount === 0, "短段落没有真实分页")
      verifyGeometry()
      const before = json(editor.getJSON()); const revision = store.getState().revision
      await delay(500)
      assert(before === json(editor.getJSON()) && revision === store.getState().revision, "分页写入正文或保存序号")
      assert(host.querySelector("[data-pagination-status]").textContent === `共 ${layout().pageCount} 页`, "状态栏页数不匹配布局")
      return { pageCount: layout().pageCount, blocks: editor.state.doc.childCount }
    })
    await check("分页装饰：每张纸面独立页眉页脚、水印及真实页码，布局与正文无关", async ({ editor, store }) => {
      const before = json(editor.getJSON()); const count = layout().pageCount
      store.getState().updatePage({ ...store.getState().page, header: { text: "M25 页眉", alignment: "left", pageNumber: "page" }, footer: { text: "分页资料", alignment: "right", pageNumber: "page-total" }, watermark: { ...DEFAULT_WATERMARK, text: "草稿" } })
      await settle()
      const layers = [...surface().querySelectorAll("[data-mewoc-page-index]")]
      assert(layers.length === count, "独立纸面层数量错误")
      layers.forEach((layer, index) => {
        const header = layer.querySelector('[data-mewoc-page-furniture="header"]'); const footer = layer.querySelector('[data-mewoc-page-furniture="footer"]')
        assert(header.querySelector("text").textContent === `M25 页眉 · 第 ${index + 1} 页` && footer.querySelector("text").textContent === `分页资料 · 第 ${index + 1} / ${count} 页`, "页码或总页数未按纸面编号")
        assert(layer.querySelectorAll("[data-mewoc-watermark]").length === 1 && getComputedStyle(header).pointerEvents === "none" && getComputedStyle(footer).userSelect === "none", "装饰重复或截获正文交互")
        assert(near(footer.getBoundingClientRect().bottom, layer.getBoundingClientRect().bottom), "页脚未贴当前页底部")
      })
      assert(before === json(editor.getJSON()), "装饰进入正文")
      verifyGeometry()
    })
    await check("分页编辑：增加与删除内容改变页数，单次撤销恢复内容和页面，重排不占撤销历史", async ({ editor, store }) => {
      const before = json(editor.getJSON()); const count = layout().pageCount
      editor.view.dispatch(closeHistory(editor.state.tr))
      editor.commands.insertContentAt(editor.state.doc.content.size, paragraphs(25))
      editor.view.dispatch(closeHistory(editor.state.tr)); await settle()
      assert(layout().pageCount > count, "新增正文没有增加页数")
      const revision = store.getState().revision
      store.getState().updateView({ zoom: 0.75 }); await settle()
      assert(store.getState().revision === revision, "缩放重排增加保存序号")
      assert(editor.commands.undo(), "正文撤销不可用"); await settle()
      assert(json(editor.getJSON()) === before && layout().pageCount === count, "分页装饰截走正文撤销或页数未恢复")
      assert(!editor.commands.undo(), "自动分页制造额外撤销步骤")
    })
    await check("分页选区：跨页选择、复制和合成退格只操作原正文，查找位置仍正确", async ({ editor }) => {
      const blocks = nodes(); const next = blocks.find(block => blockPage(block.dom).index > 0)
      const previous = blocks[blocks.indexOf(next) - 1]
      assert(previous && next, "未找到真实跨页边界")
      const from = previous.pos + 2; const to = next.pos + 4
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
      const copied = editor.view.serializeForClipboard(editor.state.selection.content())
      assert(!copied.dom.querySelector("[data-mewoc-page-gap],svg") && copied.text.includes("分页正文"), "页面间隙或装饰混入复制")
      editor.commands.setSearchTerm("分页正文"); await delay(220)
      assert(editor.view.dom.querySelectorAll(".find-and-replace-result").length === 40, "分页破坏查找位置")
      editor.commands.setSearchTerm("")
      const previousCount = editor.state.doc.childCount
      editor.commands.setTextSelection(next.pos + 1); editor.commands.focus()
      editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", bubbles: true, cancelable: true }))
      await settle()
      assert(editor.state.doc.childCount === previousCount - 1, "跨页退格没有合并原始段落")
      verifyGeometry()
    })
    await check("手动分页：首尾和连续分页符保留空页，自动边界不额外累加", async () => {
      await replace(documentContent([{ type: "pageBreak" }, paragraph("中间正文"), { type: "pageBreak" }, { type: "pageBreak" }]))
      assert(layout().pageCount === 4 && layout().overflowCount === 0, `首尾连续分页期望4页，实际${layout().pageCount}`)
      const body = nodes().find(block => block.node.type.name === "paragraph")
      assert(blockPage(body.dom).index === 1, "开头分页符没有保留空白第一页")
      verifyGeometry()
    })
    await check("手动分页编辑：合成删除选中分页符消除空页，撤销恢复原边界", async ({ editor }) => {
      await replace(documentContent([paragraph("第一段"), { type: "pageBreak" }, paragraph("第二段")]))
      assert(layout().pageCount === 2, "手动分页未生效")
      const target = nodes().find(block => block.node.type.name === "pageBreak")
      editor.view.dispatch(closeHistory(editor.state.tr).setSelection(NodeSelection.create(editor.state.doc, target.pos)))
      editor.commands.focus()
      editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", bubbles: true, cancelable: true }))
      await settle()
      assert(layout().pageCount === 1 && !nodes().some(block => block.node.type.name === "pageBreak"), "零高分页符不能删除或保留旧空页")
      assert(editor.commands.undo(), "分页符删除不能撤销"); await settle()
      assert(layout().pageCount === 2 && nodes().some(block => block.node.type.name === "pageBreak"), "撤销没有恢复手动边界")
    })
    await check("纸张与缩放：A4/A5横竖、非对称边距实时重排，50%–150%和适宽不改变分页", async ({ store }) => {
      for (const size of ["A4", "A5"]) for (const orientation of ["portrait", "landscape"]) {
        store.getState().updatePage({ ...store.getState().page, size, orientation, marginsMm: { top: 15, right: 18, bottom: 25, left: 22 } })
        await settle(); verifyGeometry()
        const signature = json(layout().pages)
        for (const zoom of [0.5, 1, 1.5]) { store.getState().updateView({ zoom, fitWidth: false }); await settle(); verifyGeometry(); assert(json(layout().pages) === signature, "缩放改变未缩放的分页布局") }
        store.getState().updateView({ fitWidth: true }); await settle(); verifyGeometry(); assert(json(layout().pages) === signature, "适宽改变分页布局")
      }
    })
    await check("排版重测：字号、行距和段前后间距改变页数，恢复格式后稳定返回", async () => {
      const initial = layout().pageCount
      const large = paragraphs().map(node => ({ ...node, attrs: { ...node.attrs, lineHeight: 2, spaceBefore: 18, spaceAfter: 18 }, content: node.content.map(text => ({ ...text, marks: [{ type: "textStyle", attrs: { fontSize: "22.5pt" } }] })) }))
      await replace(documentContent(large)); verifyGeometry()
      assert(layout().pageCount > initial, "字号行距间距改变后未重新测量")
      await replace(documentContent(paragraphs())); verifyGeometry()
      assert(layout().pageCount === initial, "恢复格式未返回初始布局")
    })
    await check("长文精度：400段小数段距和12.75pt字号逐页不漂移，末段不盖页脚", async ({ store }) => {
      const content = Array.from({ length: 400 }, (_, i) => ({ ...paragraph(`${i + 1} · 小数间距的长文排版精度。`, { spaceBefore: 0.5, spaceAfter: 0.5 }), content: [{ type: "text", text: `${i + 1} · 小数间距的长文排版精度。`, marks: [{ type: "textStyle", attrs: { fontSize: "12.75pt" } }] }] }))
      await replace(documentContent(content))
      store.getState().updatePage({ ...store.getState().page, footer: { text: "精度验收", alignment: "center", pageNumber: "page-total" } }); await settle()
      verifyGeometry()
      const state = store.getState(); const surfaceTop = surface().getBoundingClientRect().top
      const placements = layout().placements.filter(item => item.type !== "pageBreak")
      let maxDrift = 0
      nodes().forEach((block, i) => { const y = (block.dom.getBoundingClientRect().top - surfaceTop) / state.zoom; maxDrift = Math.max(maxDrift, Math.abs(y - placements[i].top)) })
      assert(maxDrift <= 1, `小数段距累计错位 ${maxDrift.toFixed(3)}px`)
      return { paragraphs: 400, pageCount: layout().pageCount, maxDriftPx: maxDrift }
    })
    await check("同页约束：标题与下一段相邻，显式与下段同页生效，过长链有限退化", async () => {
      const heading = { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题与下段同页" }] }
      await replace(documentContent([...paragraphs(10), heading, paragraph("相邻段落".repeat(40)), ...paragraphs(10)]))
      const blocks = nodes(); const title = blocks.find(block => block.node.type.name === "heading"); const body = blocks[blocks.indexOf(title) + 1]
      assert(blockPage(title.dom).index === blockPage(body.dom).index, "标题没有与下段同页")
      await replace(documentContent(paragraphs(40).map(node => ({ ...node, attrs: { keepWithNext: true } }))))
      verifyGeometry(); assert(layout().pageCount >= 3 && layout().overflowCount === 0, "过长同页链撑开无限页面或挂起")
    })
    await check("长内容：普通长段按行延续，表格逐行分页，真实文字与数据行均不遮页脚", async ({ store }) => {
      const table = { type: "table", content: Array.from({ length: 35 }, (_, i) => ({ type: "tableRow", content: Array.from({ length: 2 }, (_, col) => ({ type: i ? "tableCell" : "tableHeader", content: [paragraph(`表格 ${i + 1} / ${col + 1}`)] })) })) }
      await replace(documentContent([paragraph("长段落。".repeat(1600)), table, ...paragraphs(10)]))
      store.getState().updatePage({ ...store.getState().page, footer: { text: "页脚", alignment: "center", pageNumber: "page-total" } }); await settle()
      assert(layout().overflowCount === 0 && !layout().pages[0].overflow && current.editor.view.dom.querySelectorAll("[data-mewoc-paragraph-pagination]").length > 0, "普通长段仍完整展开或没有段内分页")
      assert(layout().pages.at(-1).overflow === false && host.querySelector("[data-pagination-status]").textContent === `共 ${layout().pageCount} 页`, "普通长内容纸高或状态页数错误")
      verifyGeometry()
      assert(current.editor.view.dom.querySelectorAll("table tr:not([data-mewoc-table-pagination])").length === 35, "跨页表格真实行丢失或重复")
      assert(current.editor.view.dom.querySelectorAll("[data-mewoc-repeat-header]").length > 0, "表格续页没有显示重复表头")
    })
    await check("图片与媒体：解码加载和尺寸变化触发重排，分页不重建正在播放的原生节点", async ({ editor, assets }) => {
      const canvas = document.createElement("canvas"); canvas.width = 200; canvas.height = 120
      canvas.getContext("2d").fillRect(0, 0, 200, 120)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
      const image = await readImageFile(new File([blob], "M25-image.png", { type: "image/png" }))
      const audio = await readMediaFile(createWaveFile("M25-audio.wav"), "audio")
      assets.set(image.id, image); assets.set(audio.id, audio)
      await replace(documentContent([...paragraphs(10), { type: "image", attrs: { assetId: image.id, width: 300, height: 180, alt: "M25 图片" } }, { type: "media", attrs: { assetId: audio.id, kind: "audio" } }, ...paragraphs(10)]))
      const img = editor.view.dom.querySelector("img"); await img.decode(); await settle(); verifyGeometry()
      const player = editor.view.dom.querySelector("audio"); await waitFor(() => player.readyState >= 1, "音频未解码")
      player.muted = true; await player.play(); await waitFor(() => player.currentTime > 0.1, "播放时钟未增加")
      const before = json(layout().pages)
      const target = nodes().find(block => block.node.type.name === "image")
      editor.view.dispatch(editor.state.tr.setNodeMarkup(target.pos, null, { ...target.node.attrs, height: 500 }))
      await settle(); verifyGeometry()
      assert(json(layout().pages) !== before, "图片高度变化未改变布局")
      assert(editor.view.dom.querySelector("audio") === player && !player.paused && player.currentTime > 0.1, "分页重建或暂停原生播放器")
      player.pause()
    })
    await check("组合输入：合成composing期间延迟重排，结束后更新，正文只读仍保持分页", async ({ editor, store }) => {
      const initial = json(layout().pages)
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
      await waitFor(() => editor.view.composing, "合成组合输入未开始")
      editor.commands.insertContentAt(editor.state.doc.content.size, paragraphs(20))
      await delay(180)
      assert(json(layout().pages) === initial, "组合输入期间改变页面装饰")
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
      await waitFor(() => !editor.view.composing, "合成组合输入未结束"); await settle()
      assert(json(layout().pages) !== initial, "组合输入结束后未重排")
      const signature = json(layout().pages); store.getState().updateView({ readOnly: true }); await settle()
      assert(!editor.isEditable && json(layout().pages) === signature, "只读切换破坏分页")
    })
    await check("保存与导出：重开和Mewoc备份重新测量，HTML/TXT不夹带自动间隙或视图页码", async context => {
      context.editor.commands.insertContentAt(2, "保存后的新内容"); await settle()
      const content = json(context.editor.getJSON()); const count = layout().pageCount
      assert(await context.saveDocument(), "分页正文未保存")
      const saved = await getLocalDocument(context.documentId)
      assert(!("pagination" in saved.document) && json(saved.document.content) === content, "自动分页进入保存文档")
      const portable = await createPortableFile(context.getSnapshot(), context.assets)
      const imported = await readPortableFile(new File([JSON.stringify(portable)], "m25.mewoc.json"))
      assert(json(imported.document.content) === content && !json(portable).includes("mewoc-page-gap"), "自动分页进入备份")
      const html = await createDocumentHtml(context.getSnapshot(), context.assets)
      const frame = document.createElement("iframe"); frame.srcdoc = html; host.append(frame)
      try { const article = await waitFor(() => frame.contentDocument?.querySelector("article"), "导出HTML未载入"); assert(!article.querySelector("[data-mewoc-page-gap],[data-mewoc-page-layer]") && frame.contentWindow.getComputedStyle(article).display !== "flex", "屏幕分页污染静态HTML/打印流") }
      finally { frame.remove() }
      assert(!createDocumentText(context.getSnapshot(), context.assets).includes("分页符") && json(context.editor.getJSON()) === content, "自动分页污染TXT或来源")
      await mount(undefined, new Map(), { ...saved, assets: new Map() })
      assert(layout().pageCount === count && json(current.editor.getJSON()) === content, "重开没有重新生成相同分页")
      verifyGeometry()
    })
    await check("会话清理：销毁后不再发布布局，新文档页数独立，短文与空正文均只有一页", async ({ editor }) => {
      let events = 0; const count = () => { events += 1 }; editor.on("paginationUpdate", count)
      await mount(documentContent([paragraph("另一份短文")]))
      const oldCount = events; await delay(350)
      assert(editor.isDestroyed && events === oldCount && layout().pageCount === 1, "旧会话观察器继续发布或新文档继承旧页数")
      await replace({ type: "doc", content: [{ type: "paragraph" }] })
      assert(layout().pageCount === 1 && layout().overflowCount === 0, "空文档出现额外空页")
      verifyGeometry()
    })
  } finally {
    let failure
    try { await unmount() } catch (error) { failure = error }
    try { await removeVerificationDocuments([...records.values()]) } catch (error) { failure ||= error }
    finally {
      host.remove()
      for (const [key, value] of preferences) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) }
    }
    if (failure) throw failure
  }
}
