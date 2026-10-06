/**
 * M25-B3 使用完整 Workspace 与独立 DOMRange 字形几何检查段内分页。
 * 自动编辑与 composition 为模型命令/合成事件；真实键盘由专用示例另行补验。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import JSZip from "jszip"
import { closeHistory } from "@tiptap/pm/history"
import { TextSelection } from "@tiptap/pm/state"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { getPagePagination } from "../src/pages/editor/extensions/page-pagination.js"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { getPageDimensions } from "../src/pages/editor/tools/page-settings.js"
import { getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { createDocumentText } from "../src/pages/editor/tools/document-text.js"
import { TOOLBAR_MODE_KEY } from "../src/pages/editor/tools/toolbar-preferences.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (value, message) => { if (!value) throw new Error(message) }
const delay = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (read, message) => { const end = Date.now() + 18000; while (Date.now() < end) { const value = await read(); if (value) return value; await delay() } throw new Error(message) }
const json = value => JSON.stringify(value)
const mm = value => value * 96 / 25.4
const paragraph = (text, attrs = {}) => ({ type: "paragraph", attrs, content: [{ type: "text", text }] })
const content = nodes => ({ type: "doc", content: nodes })
const longText = "同一个长段落按真实行连续编辑，页间留白不会写入正文。".repeat(360)
const preferences = () => new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
const restorePreferences = saved => { for (const [key, value] of saved) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } }
const requirePort = () => assert(location.hostname === "127.0.0.1" && location.port === "4190", "段内分页验收仅允许在专用 127.0.0.1:4190 运行")

/** 只量用户文字，不读取生产测量 helper；按 grapheme 避免拆开代理对与 emoji 连接序列。 */
export function readParagraphGlyphs(editor, dom) {
  const ranges = []; const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT)
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" })
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.parentElement.closest("[data-mewoc-page-gap],[data-mewoc-format-mark]")) continue
    const range = document.createRange()
    for (const { segment, index } of segmenter.segment(node.data)) {
      range.setStart(node, index); range.setEnd(node, index + segment.length)
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue
        ranges.push({ rect, from: editor.view.posAtDOM(node, index), to: editor.view.posAtDOM(node, index + segment.length), text: segment })
      }
    }
  }
  return ranges
}

// 同行中的混合字号具有不同字形 top；用垂直相交归组，不以相同字体或 helper 行号自证。
const renderedLines = glyphs => {
  const lines = []
  for (const item of glyphs) {
    let line = lines.at(-1)
    if (!line || item.rect.top >= line.bottom - 1 || item.rect.bottom <= line.top + 1) { line = { top: item.rect.top, bottom: item.rect.bottom, left: item.rect.left, from: item.from, to: item.to, text: "" }; lines.push(line) }
    line.top = Math.min(line.top, item.rect.top); line.bottom = Math.max(line.bottom, item.rect.bottom)
    line.left = Math.min(line.left, item.rect.left)
    line.from = Math.min(line.from, item.from); line.to = Math.max(line.to, item.to); line.text += item.text
  }
  return lines
}
function Probe({ capture }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) capture(context) }, [context, capture])
  return <EditorWorkspace onDocumentChange={() => {}} />
}

export async function runParagraphPaginationChecks(report = () => {}) {
  requirePort()
  const savedPreferences = preferences(); const records = new Map()
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
      const state = layout(); if (!state?.pages?.length) return false
      const signature = json({ pages: state.pages, breaks: state.breaks, height: current.editor.view.dom.offsetHeight })
      stable = signature === previous ? stable + 1 : 0; previous = signature
      return stable >= 3 && state
    }, "段内分页布局未收敛")
  }
  const blocks = () => {
    const found = []
    current.editor.state.doc.forEach((node, pos) => { const dom = current.editor.view.nodeDOM(pos); if (dom instanceof HTMLElement) found.push({ node, pos, dom }) })
    return found
  }
  const pageForY = y => layout().pages.find(page => y >= page.top - 1.5 && y < page.top + page.height - 1.5)
  const linesFor = block => renderedLines(readParagraphGlyphs(current.editor, block.dom))
  const verify = () => {
    const state = current.store.getState(); const origin = surface().getBoundingClientRect().top
    const dimensions = getPageDimensions(state.page)
    let glyphCount = 0
    for (const block of blocks()) {
      if (!["paragraph", "heading"].includes(block.node.type.name)) continue
      const glyphs = readParagraphGlyphs(current.editor, block.dom); glyphCount += glyphs.length
      for (const { rect } of glyphs) {
        const top = (rect.top - origin) / state.zoom; const bottom = (rect.bottom - origin) / state.zoom
        const page = pageForY(top)
        assert(page && top >= page.top + mm(state.page.marginsMm.top) - 2 && bottom <= page.top + page.height - mm(state.page.marginsMm.bottom) + 2, `真实文字覆盖页边距：${top.toFixed(2)}–${bottom.toFixed(2)}`)
      }
    }
    for (const page of layout().pages) if (!page.overflow) assert(Math.abs(page.height - mm(dimensions.heightMm)) < 0.1, "标准纸高被段落撑开")
    assert(glyphCount > 0 || !current.editor.state.doc.textContent, "非空段落没有可测量的原文字")
    return glyphCount
  }
  const internalBreaks = () => layout().breaks.filter(item => Number.isInteger(item.paragraphPos))
  const unmount = async () => {
    let failure
    try {
      if (current?.editor && !current.editor.isDestroyed) {
        current.store.getState().updateView({ readOnly: false, switching: false })
        assert(await current.saveDocument(), `段内分页清理前保存未排空：${current.store.getState().saveError || "保存队列未就绪"}`)
      }
    } catch (error) { failure = error }
    try { ReactDOM.unmountComponentAtNode(host) } catch (error) { failure ||= error }
    finally { current = null }
    return failure
  }
  const mount = async (body = content([paragraph(longText)]), record) => {
    const failure = await unmount(); if (failure) throw failure
    localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    if (!record) {
      const source = { ...createDocument(), title: `M25-B3 段落验收-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, content: body }
      source.page.header = { text: "M25 · 段内分页", alignment: "left", pageNumber: "page" }; source.page.footer = { text: "连续段落", alignment: "center", pageNumber: "page-total" }
      const assets = new Map(); const saved = await saveLocalDocument(source, assets, 0)
      record = { document: source, assets, storageVersion: saved.storageVersion }
    }
    records.set(record.document.id, record)
    ReactDOM.render(<EditorProvider key={record.document.id} record={record}><Probe capture={capture} /></EditorProvider>, host)
    await waitFor(() => current?.documentId === record.document.id && surface(), "段内分页 Workspace 未就绪")
    current.store.getState().updateView({ outlineOpen: false, searchOpen: false, zoom: 1, fitWidth: false }); await settle()
    return current
  }
  const replace = async body => { assert(current.editor.commands.setContent(body), "段落测试正文未替换"); return settle() }
  const check = async (name, run) => {
    let result
    try { await mount(); const metrics = await run(current); result = { name, passed: true, ...(metrics && { metrics }) } }
    catch (error) { result = { name, passed: false, error: error.message } }
    finally { const failure = await unmount(); if (failure) result = { ...result, passed: false, error: [result?.error, failure.message].filter(Boolean).join("；") } }
    report(result)
  }
  try {
    await check("单段多页：一个原始段落按真实行跨页，JSON、字符与保存修订保持不变", async ({ editor, store }) => {
      const before = json(editor.getJSON()); const revision = store.getState().revision; const glyphs = verify()
      assert(layout().pageCount >= 3 && layout().overflowCount === 0 && editor.state.doc.childCount === 1, "普通长段落仍完整展开或被拆成持久段落")
      assert(editor.state.doc.textContent === longText && internalBreaks().length >= 2, "原文字丢失或没有段内断点")
      await delay(300); assert(json(editor.getJSON()) === before && store.getState().revision === revision, "仅视图分页制造文档修订")
      return { pages: layout().pageCount, paragraphs: 1, glyphs, internalBreaks: internalBreaks().length }
    })
    await check("续行装饰：合法不可编辑span与页眉页脚独立，续页文字只落在正文预算", async ({ editor }) => {
      verify(); const gaps = [...editor.view.dom.querySelectorAll("[data-mewoc-paragraph-pagination][data-mewoc-page-gap]")]
      assert(gaps.length === internalBreaks().length && gaps.length > 1, "段内真实装饰与规划断点不一致")
      for (const gap of gaps) assert(gap.tagName === "SPAN" && gap.closest("p,h1,h2,h3,h4,h5,h6") && gap.contentEditable === "false" && gap.getAttribute("aria-hidden") === "true" && getComputedStyle(gap).pointerEvents === "none", "段内装饰结构或交互隔离错误")
      const layers = surface().querySelectorAll("[data-mewoc-page-index]")
      assert(layers.length === layout().pageCount && [...layers].every(layer => layer.querySelectorAll("[data-mewoc-page-furniture]").length === 2), "各页没有独立页眉页脚")
      assert(editor.view.dom.querySelectorAll(":scope > p").length === 1, "跨页生成第二份可编辑段落")
    })
    await check("长标题：h1至h6均按行延续，原始标题和标题后普通段落保留一份", async ({ editor }) => {
      for (const level of [1, 2, 3, 4, 5, 6]) {
        await replace(content([{ type: "heading", attrs: { level, keepWithNext: false }, content: [{ type: "text", text: longText.slice(0, 4200) }] }, paragraph("标题后正文")]))
        verify(); assert(layout().pageCount >= 2 && layout().overflowCount === 0 && editor.state.doc.childCount === 2 && editor.view.dom.querySelectorAll(`:scope > h${level}`).length === 1, `h${level} 未安全按行分页`)
        assert(internalBreaks().every(item => item.paragraphPos === 0), "标题分页定位到了后段正文")
      }
    })
    await check("混合文字：粗斜体、颜色、链接、hardBreak与emoji跨页后原标记和UTF16内容不变", async ({ editor }) => {
      const body = Array.from({ length: 90 }, (_item, index) => [
        { type: "text", text: `${index + 1} 粗体段内文字。`, marks: [{ type: "bold" }] },
        { type: "text", text: "彩色斜体👩🏽‍💻与家庭👨‍👩‍👧‍👦。", marks: [{ type: "italic" }, { type: "textStyle", attrs: { fontSize: "22.5pt", color: "#603fbb", backgroundColor: "#efeaff" } }] },
        { type: "text", text: "连续链接。", marks: [{ type: "link", attrs: { href: "https://example.com", target: "_blank", rel: "noopener noreferrer" } }] },
        { type: "hardBreak" }, ...(index % 10 === 0 ? [{ type: "hardBreak" }] : [])
      ]).flat()
      await replace(content([{ type: "paragraph", content: body }]))
      const before = json(editor.getJSON()); const original = editor.state.doc.textContent
      verify(); await delay(240); assert(layout().pageCount >= 3 && layout().overflowCount === 0 && json(editor.getJSON()) === before && editor.state.doc.textContent === original, "断点拆开标记、hardBreak或emoji")
      assert(editor.view.dom.querySelectorAll("strong,em,a").length >= 270 && editor.state.doc.firstChild.content.content.filter(node => node.type.name === "hardBreak").length === 99, "原始标记或硬换行数量改变")
    })
    await check("多个长段：段前后间距只作用于原段首尾，续页不复制段落或吞掉尾后正文", async ({ editor }) => {
      await replace(content([paragraph(longText, { spaceBefore: 18.5, spaceAfter: 24 }), paragraph(longText.slice(0, 4300), { spaceBefore: 12.5, spaceAfter: 10 }), paragraph("两个长段落之后的正文")]))
      verify(); assert(editor.state.doc.childCount === 3 && layout().overflowCount === 0 && new Set(internalBreaks().map(item => item.paragraphPos)).size === 2, "多个长段没有各自延续或重复生成模型段落")
      const last = blocks().at(-1); const y = (last.dom.getBoundingClientRect().top - surface().getBoundingClientRect().top) / current.store.getState().zoom
      assert(pageForY(y) && last.node.textContent === "两个长段落之后的正文", "尾后正文不在纸面")
    })
    await check("对齐与缩进：首行缩进、左缩进、居中与两端对齐在跨页后保留原格式", async ({ editor }) => {
      for (const textAlign of ["left", "center", "right", "justify"]) {
        await replace(content([paragraph(longText, { firstLineIndent: 2, leftIndent: 2, textAlign, lineHeight: 1.75 })]))
        verify(); assert(layout().overflowCount === 0 && editor.state.doc.firstChild.attrs.textAlign === textAlign && editor.state.doc.firstChild.attrs.firstLineIndent === 2 && editor.state.doc.firstChild.attrs.leftIndent === 2, "段内分页改变了对齐或缩进")
        if (["left", "justify"].includes(textAlign)) {
          const block = blocks()[0]; const lines = linesFor(block); const origin = surface().getBoundingClientRect().top
          const left = block.dom.getBoundingClientRect().left; const font = parseFloat(getComputedStyle(block.dom).fontSize)
          assert(Math.abs(lines[0].left - left - 2 * font) < 1.5, "原段首行缩进没有实现在真实字形位置")
          const seen = new Set([0])
          for (const line of lines) {
            const page = pageForY(line.top - origin)
            if (seen.has(page.index)) continue
            seen.add(page.index); assert(Math.abs(line.left - left) < 1.5, "续页首行重复首行缩进或丢失原段左缩进")
          }
          assert(seen.size === layout().pageCount, "未测到每个续页的真实首行左侧")
        }
      }
    })
    await check("整段同页：keepTogether显式保留展开页，关闭后恢复按行分页且普通后段恢复标准纸高", async ({ editor }) => {
      await replace(content([paragraph(longText, { keepTogether: true }), paragraph("完整长段之后")]))
      verify(); assert(layout().overflowCount === 1 && layout().pages[0].overflow && !internalBreaks().length && !layout().pages.at(-1).overflow, "整段同页没有保留完整展开布局")
      editor.view.dispatch(editor.state.tr.setNodeMarkup(0, null, { ...editor.state.doc.firstChild.attrs, keepTogether: false })); await settle(); verify()
      assert(layout().overflowCount === 0 && internalBreaks().length > 1 && editor.state.doc.childCount === 2, "关闭整段同页未恢复行级分页")
    })
    await check("跨页选区：复制与删除只操作原文字，页间留白不进入剪贴板，单次撤销恢复原段", async ({ editor }) => {
      const lines = linesFor(blocks()[0]); const origin = surface().getBoundingClientRect().top
      const index = lines.findIndex(line => pageForY(line.top - origin).index > 0); assert(index > 0, "没有跨页行选区")
      const from = lines[index - 1].from; const to = lines[index].to; const before = json(editor.getJSON())
      editor.view.dispatch(closeHistory(editor.state.tr).setSelection(TextSelection.create(editor.state.doc, from, to)))
      const expected = editor.state.doc.textBetween(from, to); const copied = editor.view.serializeForClipboard(editor.state.selection.content())
      assert(copied.text === expected && !copied.dom.querySelector("[data-mewoc-page-gap],svg"), "分页空隙污染跨页复制")
      assert(editor.commands.deleteSelection(), "跨页选区未删除"); editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify()
      assert(editor.state.doc.childCount === 1 && editor.state.doc.textContent.length === longText.length - expected.length, "删除跨页选区拆分或遗漏正文")
      assert(editor.commands.undo(), "跨页删除未能撤销"); await settle(); verify(); assert(json(editor.getJSON()) === before, "撤销未恢复完整原段")
    })
    await check("断点模型编辑：续页位置插入和向前删除不操作装饰，每次撤销只恢复正文一步", async ({ editor }) => {
      const position = internalBreaks()[0].pos; const before = json(editor.getJSON())
      editor.view.dispatch(closeHistory(editor.state.tr)); editor.commands.insertContentAt(position, "边界输入ABC")
      editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify()
      assert(editor.state.doc.childCount === 1 && editor.state.doc.textContent.includes("边界输入ABC"), "续页位置无法写入原段")
      assert(editor.commands.undo(), "边界插入不能撤销"); await settle(); assert(json(editor.getJSON()) === before, "插入撤销被分页事务截走")
      editor.view.dispatch(closeHistory(editor.state.tr)); assert(editor.commands.deleteRange({ from: position - 1, to: position }), "边界前向删除失败")
      editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify()
      assert(editor.state.doc.childCount === 1 && editor.state.doc.textContent.length === longText.length - 1, "边界前向删除删到了装饰或整个段落")
      assert(editor.commands.undo(), "边界删除不能撤销"); await settle(); assert(json(editor.getJSON()) === before, "边界删除撤销未恢复正文")
    })
    await check("续页分段：splitBlock在段内断点产生两个真实段落，撤销合回一个原始长段", async ({ editor }) => {
      const before = json(editor.getJSON()); const position = internalBreaks()[0].pos
      editor.view.dispatch(closeHistory(editor.state.tr).setSelection(TextSelection.create(editor.state.doc, position)))
      assert(editor.commands.splitBlock(), "续页位置不能分段"); editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify()
      assert(editor.state.doc.childCount === 2 && editor.state.doc.textContent === longText, "真实分段丢失文字或分页自行增段")
      assert(editor.commands.undo(), "续页真实分段不能撤销"); await settle(); verify(); assert(json(editor.getJSON()) === before, "分段撤销未恢复原始JSON")
    })
    await check("字号与行距：合法大字号与半磅段距重测，零上下边距和24px纸间距有限收敛", async ({ editor, store }) => {
      const count = layout().pageCount
      const large = paragraph(longText, { lineHeight: 2, spaceBefore: 18.5, spaceAfter: 18.5 }); large.content[0].marks = [{ type: "textStyle", attrs: { fontSize: "22.5pt" } }]
      await replace(content([large])); verify(); assert(layout().pageCount > count && layout().overflowCount === 0, "大字号/行距没有重新分页")
      await replace(content([paragraph(longText)])); verify(); assert(layout().pageCount === count, "恢复格式未返回相同页数")
      store.getState().updatePage({ ...store.getState().page, header: null, footer: null, marginsMm: { top: 0, right: 20, bottom: 0, left: 20 } })
      assert(editor.commands.setPaginationSettings({ gapPx: 24 }), "24px纸间距设置失败")
      await replace(content([large])); verify(); const signature = json(layout().breaks)
      await delay(420); assert(json(layout().breaks) === signature && layout().overflowCount === 0 && layout().pageCount >= 3, "零上下边距的大字号换页持续漂移或失去分页")
    })
    await check("纸型与缩放：A4/A5横竖及非对称边距按行重排，50%至150%与适宽保持未缩放断点", async ({ store }) => {
      for (const size of ["A4", "A5"]) for (const orientation of ["portrait", "landscape"]) {
        store.getState().updatePage({ ...store.getState().page, size, orientation, marginsMm: { top: 15, right: 18, bottom: 25, left: 22 } }); await settle(); verify()
        const count = layout().pageCount; const positions = json(internalBreaks().map(item => item.pos))
        for (const zoom of [0.5, 1, 1.5]) { store.getState().updateView({ zoom, fitWidth: false }); await settle(); verify(); assert(layout().pageCount === count && json(internalBreaks().map(item => item.pos)) === positions, "显示缩放改变段内真实断点") }
        store.getState().updateView({ fitWidth: true }); await settle(); verify(); assert(layout().pageCount === count && json(internalBreaks().map(item => item.pos)) === positions, "适应宽度改变段内断点")
      }
    })
    await check("400行精度：小数字号单段硬换行逐页不漂移，每个续页首字形对齐相同正文起点", async ({ store }) => {
      const body = Array.from({ length: 400 }, (_item, index) => [{ type: "text", text: `小数行 ${String(index + 1).padStart(3, "0")} 的排版精度。`, marks: [{ type: "textStyle", attrs: { fontSize: "12.75pt" } }] }, ...(index < 399 ? [{ type: "hardBreak" }] : [])]).flat()
      await replace(content([{ type: "paragraph", attrs: { lineHeight: 1.75, spaceBefore: 0.5, spaceAfter: 0.5 }, content: body }]))
      verify(); const lines = linesFor(blocks()[0]); assert(lines.length === 400 && layout().overflowCount === 0, `400真实行数量错误：${lines.length}`)
      const state = store.getState(); const origin = surface().getBoundingClientRect().top; const firstByPage = new Map()
      for (const line of lines) { const y = (line.top - origin) / state.zoom; const page = pageForY(y); if (!firstByPage.has(page.index)) firstByPage.set(page.index, y - page.top - mm(state.page.marginsMm.top)) }
      const offsets = [...firstByPage.values()].slice(1); const maxDrift = Math.max(...offsets) - Math.min(...offsets)
      assert(firstByPage.size === layout().pageCount && maxDrift <= 1, `续页首字形累计错位 ${maxDrift.toFixed(3)}px`)
      return { lines: 400, paragraphs: 1, pages: layout().pageCount, maxDriftPx: maxDrift }
    })
    await check("组合与只读：合成composition期间只映射旧装饰，结束后按行重排，只读保留完整原段", async ({ editor, store }) => {
      const before = json(layout().breaks); const gaps = [...editor.view.dom.querySelectorAll("[data-mewoc-paragraph-pagination]")]
      editor.commands.focus(); editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); await waitFor(() => editor.view.composing, "合成组合输入未开始")
      editor.commands.insertContentAt(internalBreaks()[0].pos, "候选插入的正文。".repeat(100)); await delay(180)
      assert(json(layout().breaks) === before && gaps.every(gap => gap.isConnected), "组合输入期间重建段内装饰")
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); await waitFor(() => !editor.view.composing, "合成组合输入未结束"); await settle(); verify()
      assert(json(layout().breaks) !== before, "组合结束后没有测量最终段落")
      const pages = json(layout().pages); const body = json(editor.getJSON()); store.getState().updateView({ readOnly: true }); await settle(); verify()
      assert(!editor.isEditable && json(layout().pages) === pages && json(editor.getJSON()) === body, "只读切换改变段内布局或正文")
    })
    await check("开关与历史：关闭删除全部段内装饰，重开恢复布局，不增加正文修订或撤销历史", async ({ editor, store }) => {
      const before = json(editor.getJSON()); const revision = store.getState().revision; const count = layout().pageCount
      assert(editor.commands.setPaginationSettings({ enabled: false }), "分页关闭命令失败")
      await waitFor(() => !editor.view.dom.querySelector("[data-mewoc-page-gap]"), "关闭后残留分页间隙")
      assert(layout().pageCount === 0 && editor.view.dom.querySelectorAll(":scope > p").length === 1, "关闭分页仍保留旧页数或拆分模型")
      assert(editor.commands.setPaginationSettings({ enabled: true }), "分页开启命令失败"); await settle(); verify()
      assert(layout().pageCount === count && json(editor.getJSON()) === before && store.getState().revision === revision && !editor.commands.undo(), "分页开关制造正文变化或撤销步骤")
    })
    await check("保存与备份：单段JSON原样保存，Mewoc不含屏幕断点，重开后重新测得同页数", async context => {
      context.editor.commands.insertContentAt(internalBreaks()[0].pos, "保存后的正文"); await settle(); verify()
      const before = json(context.editor.getJSON()); const count = layout().pageCount
      assert(await context.saveDocument(), "段内分页正文保存失败"); const saved = await getLocalDocument(context.documentId)
      const portable = await createPortableFile(context.getSnapshot(), context.assets); const imported = await readPortableFile(new File([json(portable)], "m25-b3.mewoc.json"))
      assert(json(saved.document.content) === before && json(imported.document.content) === before && !("pagination" in saved.document) && !json(portable).includes("mewoc-paragraph-pagination"), "持久化写入段内装饰或改变原段")
      await mount(undefined, { ...saved, assets: new Map() }); verify(); assert(json(current.editor.getJSON()) === before && layout().pageCount === count && current.editor.state.doc.childCount === 1, "重开没恢复原段或相同分页")
    })
    await check("HTML、TXT与Word：整段文字只导出一次，段内断点不变成硬换行或物理分页符", async context => {
      const before = json(context.editor.getJSON()); const html = await createDocumentHtml(context.getSnapshot(), context.assets)
      const parsed = new DOMParser().parseFromString(html, "text/html"); const article = parsed.querySelector("article")
      assert(article.querySelectorAll("p").length === 1 && article.textContent === longText && !article.querySelector("[data-mewoc-page-gap],[data-mewoc-paragraph-pagination]"), "HTML导出复制段落或屏幕分页装饰")
      assert(createDocumentText(context.getSnapshot(), context.assets).trim() === longText, "TXT插入自动换行或分页字符")
      const result = await createDocumentDocx(context.getSnapshot(), context.assets); const archive = await JSZip.loadAsync(await result.blob.arrayBuffer())
      const xml = new DOMParser().parseFromString(await archive.file("word/document.xml").async("string"), "application/xml")
      assert(xml.getElementsByTagName("w:p").length === 1 && xml.getElementsByTagName("w:br").length === 0 && xml.documentElement.textContent === longText && json(context.editor.getJSON()) === before, "Word把屏幕断点变成真实段落或分页符")
    })
    await check("嵌套范围与清理：列表、引用及代码块安全延续；旧会话销毁后短文和空文只有一页", async ({ editor }) => {
      await replace(content([{ type: "bulletList", content: [{ type: "listItem", content: [paragraph(longText)] }] }, { type: "blockquote", content: [paragraph(longText)] }, { type: "codeBlock", attrs: { language: "plaintext" }, content: [{ type: "text", text: "完整代码行\n".repeat(200) }] }, paragraph("安全容器之后")]))
      assert(editor.view.dom.querySelector("li [data-mewoc-paragraph-pagination]") && editor.view.dom.querySelector("blockquote [data-mewoc-paragraph-pagination]") && editor.view.dom.querySelector("pre [data-mewoc-code-pagination]") && layout().overflowCount === 0, "已支持的嵌套结构没有按安全原行延续")
      let events = 0; editor.on("paginationUpdate", () => { events += 1 })
      await mount(content([paragraph("另一份短文")]))
      const count = events; await delay(280); verify(); assert(editor.isDestroyed && events === count && layout().pageCount === 1, "旧会话仍发布布局或短文继承旧页数")
      await replace({ type: "doc", content: [{ type: "paragraph" }] }); assert(layout().pageCount === 1 && layout().overflowCount === 0 && !internalBreaks().length, "空文档残留段内断点")
    })
  } finally {
    const failures = []; const failure = await unmount(); if (failure) failures.push(failure.message)
    host.remove()
    try { await removeVerificationDocuments([...records.values()]) } catch (error) { failures.push(error.message) }
    finally { restorePreferences(savedPreferences) }
    if (failures.length) report({ name: "段内分页收尾清理", passed: false, error: failures.join("；") })
  }
}

/** 保留真实段落供原生左右键、ASCII、Backspace及Meta/Ctrl+Z补验；结束时只清理本轮ID。 */
export async function showParagraphPaginationExample() {
  requirePort(); const savedPreferences = preferences(); const source = createDocument()
  source.title = `M25-B3 段落验收-${Date.now()}`
  source.content = content([{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "M25 · 长段落按行分页" }] }, paragraph("请在页尾与下一页首行之间用左右键移动，在续页输入ASCII并退格，再用Meta/Ctrl+Z撤销。下面是一份保持单一段落的真实长正文。"), paragraph(longText), paragraph("长段落结束后的普通正文。")])
  source.page.header = { text: "Mewoc · 段内分页", alignment: "left", pageNumber: "page" }; source.page.footer = { text: "原生键盘补验", alignment: "center", pageNumber: "page-total" }
  const assets = new Map(); const saved = await saveLocalDocument(source, assets, 0); const record = { document: source, assets, storageVersion: saved.storageVersion }
  const host = document.createElement("section"); host.dataset.paragraphPaginationExample = ""; host.style.cssText = "position:relative;width:1280px;max-width:100%;height:950px;margin:24px 0"; document.body.append(host)
  let current; let closing = false; let resolveFinished; let rejectFinished; let refreshNativeState
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
  const finish = async () => {
    if (closing) return
    closing = true; let failure
    if (current?.editor && refreshNativeState) for (const event of ["transaction", "selectionUpdate", "paginationUpdate"]) current.editor.off(event, refreshNativeState)
    try { if (current?.editor && !current.editor.isDestroyed && !await current.saveDocument()) throw new Error("段内分页示例保存未排空") } catch (error) { failure = error }
    try { ReactDOM.unmountComponentAtNode(host) } catch (error) { failure ||= error }
    host.remove()
    try { await removeVerificationDocuments([record]) } catch (error) { failure ||= error }
    finally { restorePreferences(savedPreferences) }
    if (failure) rejectFinished(failure); else resolveFinished()
  }
  const capture = context => { current = context }
  const locateBoundary = () => {
    const boundary = getPagePagination(current?.editor).breaks.find(item => Number.isInteger(item.paragraphPos))
    if (!boundary) return
    current.editor.view.dispatch(current.editor.state.tr.setSelection(TextSelection.create(current.editor.state.doc, boundary.pos)).scrollIntoView())
    current.editor.commands.focus()
    refreshNativeState?.()
  }
  try {
    localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    ReactDOM.render(<><button type="button" aria-label="结束段内分页示例" onClick={finish}>结束段内分页示例</button><button type="button" onClick={locateBoundary}>定位首个续页行</button><p>原生补验标记：M25_NATIVE。下方状态只显示当前光标与文档计数。</p><pre aria-label="段内分页原生状态">等待编辑器就绪</pre><EditorProvider record={record}><Probe capture={capture} /></EditorProvider></>, host)
    await waitFor(() => current?.editor && host.querySelector("[data-mewoc-editor-surface]"), "段内分页示例未就绪")
    current.store.getState().updateView({ activeTab: "开始", outlineOpen: false, searchOpen: false, fitWidth: false, zoom: 1 })
    const originalText = current.editor.state.doc.textContent
    refreshNativeState = () => {
      if (!current?.editor || current.editor.isDestroyed) return
      const { doc, selection } = current.editor.state; const state = getPagePagination(current.editor)
      const boundary = state.breaks.find(item => Number.isInteger(item.paragraphPos)); let paragraphCount = 0
      doc.descendants(node => { if (node.type.name === "paragraph") paragraphCount += 1 })
      host.querySelector('[aria-label="段内分页原生状态"]').textContent = json({ selection: { from: selection.from, to: selection.to }, currentBoundary: boundary?.pos ?? null, currentBoundaryLine: boundary?.paragraphLine ?? null, textContentLength: doc.textContent.length, paragraphCount, pageCount: state.pageCount, originalMatches: doc.textContent === originalText, markerPosition: doc.textContent.indexOf("M25_NATIVE"), textAroundCaret: doc.textBetween(Math.max(0, selection.from - 24), Math.min(doc.content.size, selection.to + 24)) })
    }
    for (const event of ["transaction", "selectionUpdate", "paginationUpdate"]) current.editor.on(event, refreshNativeState)
    refreshNativeState()
    return await finished
  } catch (error) { await finish(); throw error }
}
