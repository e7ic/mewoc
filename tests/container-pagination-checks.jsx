/**
 * M25-B4 正式 Workspace 长列表与嵌套容器验收；独立量原始模型节点的可见字形。
 * 列表快捷键、勾选与 composition 为明确的合成操作，浏览器与原生补验由根任务执行。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import JSZip from "jszip"
import { closeHistory } from "@tiptap/pm/history"
import { TextSelection } from "@tiptap/pm/state"
import { TableMap } from "@tiptap/pm/tables"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { getPagePagination } from "../src/pages/editor/extensions/page-pagination.js"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { getPageDimensions } from "../src/pages/editor/tools/page-settings.js"
import { TEXT_BOX_DEFAULTS } from "../src/pages/editor/tools/block-containers.js"
import { getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { createDocumentText } from "../src/pages/editor/tools/document-text.js"
import { readMediaFile } from "../src/pages/editor/tools/media-assets.js"
import { TOOLBAR_MODE_KEY } from "../src/pages/editor/tools/toolbar-preferences.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { readParagraphGlyphs } from "./paragraph-pagination-checks.jsx"
import { createWaveFile } from "./media-fixtures.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (value, message) => { if (!value) throw new Error(message) }
const delay = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (read, message) => { const end = Date.now() + 20000; while (Date.now() < end) { const value = await read(); if (value) return value; await delay() } throw new Error(message) }
const json = value => JSON.stringify(value)
const mm = value => value * 96 / 25.4
const paragraph = (text, attrs = {}) => ({ type: "paragraph", attrs, content: [{ type: "text", text }] })
const content = nodes => ({ type: "doc", content: nodes })
const longText = "嵌套结构的原始文字保持连续编辑，分页装饰不成为新的文档内容。".repeat(300)
const list = (type = "bulletList", count = 64, attrs = {}) => ({ type, attrs, content: Array.from({ length: count }, (_item, index) => ({ type: type === "taskList" ? "taskItem" : "listItem", ...(type === "taskList" ? { attrs: { checked: index % 3 === 0 } } : {}), content: [paragraph(`${index + 1} · 原始列表项跨页之后继续保留编号和正文。`.repeat(2))] })) })
const box = (body, attrs = {}) => ({ type: "textBox", attrs: { ...TEXT_BOX_DEFAULTS, ...attrs }, content: body })
const details = (body, summary = "嵌套详情") => ({ type: "details", attrs: { summary }, content: body })
const quote = body => ({ type: "blockquote", content: body })
const table = (count = 28) => ({ type: "table", content: Array.from({ length: count }, (_item, row) => ({ type: "tableRow", content: [0, 1].map(column => ({ type: row ? "tableCell" : "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: [220] }, content: [paragraph(`表格真实行 ${row + 1} / ${column + 1}`)] })) })) })
const preferences = () => new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
const restorePreferences = saved => { for (const [key, value] of saved) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } }
const requirePort = () => assert(location.hostname === "127.0.0.1" && location.port === "4190", "容器分页验收仅允许在专用 127.0.0.1:4190 运行")
function Probe({ capture }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) capture(context) }, [context, capture])
  return <EditorWorkspace onDocumentChange={() => {}} />
}

export async function runContainerPaginationChecks(report = () => {}) {
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
    }, "容器分页布局未收敛")
  }
  const nodes = type => {
    const found = []
    current.editor.state.doc.descendants((node, pos) => {
      if (!type || node.type.name === type) { const dom = current.editor.view.nodeDOM(pos); if (dom instanceof HTMLElement) found.push({ node, pos, dom }) }
    })
    return found
  }
  const visible = dom => !!dom?.getClientRects().length && !dom.closest("[hidden]") && getComputedStyle(dom).display !== "none"
  const pageForY = y => layout().pages.find(page => y >= page.top - 1.5 && y < page.top + page.height - 1.5)
  const glyphs = () => nodes().filter(item => ["paragraph", "heading", "codeBlock"].includes(item.node.type.name) && visible(item.dom)).flatMap(item => readParagraphGlyphs(current.editor, item.dom))
  const verifyRect = (rect, label) => {
    const state = current.store.getState(); const origin = surface().getBoundingClientRect().top
    const top = (rect.top - origin) / state.zoom; const bottom = (rect.bottom - origin) / state.zoom; const page = pageForY(top)
    assert(page && top >= page.top + mm(state.page.marginsMm.top) - 2 && bottom <= page.top + page.height - mm(state.page.marginsMm.bottom) + 2, `${label} 覆盖页边距：${top.toFixed(2)}–${bottom.toFixed(2)}`)
    return page
  }
  const verify = () => {
    const state = current.store.getState(); const dimensions = getPageDimensions(state.page)
    const measured = glyphs(); measured.forEach(item => verifyRect(item.rect, "原始文字"))
    for (const item of nodes()) {
      if (!visible(item.dom)) continue
      if (["tableRow", "image", "media", "attachment"].includes(item.node.type.name)) verifyRect(item.dom.getBoundingClientRect(), item.node.type.name)
      if (item.node.type.name === "taskItem") {
        const labelPage = verifyRect(item.dom.querySelector(":scope > label").getBoundingClientRect(), "原任务勾选框")
        const first = readParagraphGlyphs(current.editor, current.editor.view.nodeDOM(item.pos + 1))[0]
        if (first) assert(verifyRect(first.rect, "任务首行").index === labelPage.index, "原checkbox与任务首行分居不同页面")
      }
      if (item.node.type.name === "details") verifyRect(item.dom.querySelector(":scope > [data-details-toggle]").getBoundingClientRect(), "原详情摘要")
      if (item.node.type.name === "table") assert(!TableMap.get(item.node).problems?.length, "嵌套原表格逻辑网格损坏")
    }
    for (const page of layout().pages) if (!page.overflow) assert(Math.abs(page.height - mm(dimensions.heightMm)) < 0.1, "正常页被整个容器撑开")
    return measured.length
  }
  const unmount = async () => {
    let failure
    try {
      if (current?.editor && !current.editor.isDestroyed) {
        current.store.getState().updateView({ readOnly: false, switching: false })
        assert(await current.saveDocument(), `容器分页清理前保存未排空：${current.store.getState().saveError || "保存队列未就绪"}`)
      }
    } catch (error) { failure = error }
    try { ReactDOM.unmountComponentAtNode(host) } catch (error) { failure ||= error }
    finally { current = null }
    return failure
  }
  const mount = async (body = content([list()]), record) => {
    const failure = await unmount(); if (failure) throw failure
    localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    if (!record) {
      const source = { ...createDocument(), title: `M25-B4 容器验收-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, content: body }
      source.page.header = { text: "M25 · 长列表与容器", alignment: "left", pageNumber: "page" }; source.page.footer = { text: "原始嵌套结构", alignment: "center", pageNumber: "page-total" }
      const assets = new Map(); const saved = await saveLocalDocument(source, assets, 0)
      record = { document: source, assets, storageVersion: saved.storageVersion }
    }
    records.set(record.document.id, record)
    ReactDOM.render(<EditorProvider key={record.document.id} record={record}><Probe capture={capture} /></EditorProvider>, host)
    await waitFor(() => current?.documentId === record.document.id && surface(), "容器分页 Workspace 未就绪")
    current.store.getState().updateView({ outlineOpen: false, searchOpen: false, zoom: 1, fitWidth: false }); await settle()
    return current
  }
  const replace = async body => { assert(current.editor.commands.setContent(body), "容器测试正文未替换"); return settle() }
  const select = pos => current.editor.view.dispatch(current.editor.state.tr.setSelection(TextSelection.create(current.editor.state.doc, pos)))
  const check = async (name, run) => {
    let result
    try { await mount(); const metrics = await run(current); result = { name, passed: true, ...(metrics && { metrics }) } }
    catch (error) { result = { name, passed: false, error: error.message } }
    finally { const failure = await unmount(); if (failure) result = { ...result, passed: false, error: [result?.error, failure.message].filter(Boolean).join("；") } }
    report(result)
  }
  try {
    await check("无序列表：64原项目分布多张标准页，列表、li和模型只保留一份", async ({ editor, store }) => {
      const before = json(editor.getJSON()); const revision = store.getState().revision; const items = nodes("listItem"); const count = verify()
      assert(layout().pageCount >= 3 && layout().overflowCount === 0 && items.length === 64 && nodes("bulletList").length === 1, "长UL没有安全分页或被拆成多份模型列表")
      const gaps = [...editor.view.dom.querySelectorAll("[data-mewoc-page-gap]")].filter(item => ["UL", "OL"].includes(item.parentElement.tagName))
      assert(gaps.length > 0 && gaps.every(item => item.tagName === "LI" && item.contentEditable === "false" && item.getAttribute("aria-hidden") === "true" && !item.textContent && getComputedStyle(item).listStyleType === "none"), "列表边界不是合法且无额外编号的空LI")
      assert([...items, ...nodes("bulletList")].every(item => getComputedStyle(item.dom).clipPath === "none" && !item.dom.hasAttribute("data-mewoc-container-fragment")), "列表或原li被容器裁剪而遮住编号/控件")
      await delay(250); assert(json(editor.getJSON()) === before && revision === store.getState().revision && items.every(item => editor.state.doc.nodeAt(item.pos) === item.node && editor.view.nodeDOM(item.pos) === item.dom), "仅分页替换了原项目或制造修订")
      return { items: 64, pages: layout().pageCount, glyphs: count }
    })
    await check("有序列表：原start和五种编号外观跨页保留，原始li数量与顺序不变", async () => {
      for (const type of ["1", "a", "A", "i", "I"]) {
        await replace(content([list("orderedList", 64, { start: 7, type })])); verify()
        const item = nodes("orderedList")[0]
        assert(layout().pageCount >= 3 && layout().overflowCount === 0 && nodes("orderedList").length === 1 && nodes("listItem").length === 64 && item.dom.start === 7 && (item.dom.type || "1") === type && item.node.attrs.start === 7, "跨页重建或重置原有序列表编号")
        assert(nodes("listItem").every((entry, index) => entry.node.textContent.startsWith(`${index + 1} ·`)), "原项目被重排或重复")
      }
    })
    await check("任务列表：跨页checked与唯一原checkbox保留，勾选真实项目可一次撤销", async ({ editor }) => {
      await replace(content([list("taskList")]))
      const before = json(editor.getJSON()); const items = nodes("taskItem"); const controls = items.map(item => item.dom.querySelector(":scope > label > input"))
      verify(); assert(layout().pageCount >= 3 && layout().overflowCount === 0 && controls.length === 64 && editor.view.dom.querySelectorAll('li[data-type="taskItem"] > label > input').length === 64, "分页复制或遗漏任务勾选框")
      controls.forEach((control, index) => assert(control.checked === (index % 3 === 0) && control === editor.view.nodeDOM(items[index].pos).querySelector(":scope > label > input"), "续页任务状态或控件身份改变"))
      editor.view.dispatch(closeHistory(editor.state.tr)); controls[40].click(); editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify()
      assert(nodes("taskItem")[40].node.attrs.checked === true && controls[40] === nodes("taskItem")[40].dom.querySelector(":scope > label > input"), "续页checkbox没有写入原任务")
      assert(editor.commands.undo(), "任务勾选不能撤销"); await settle(); assert(json(editor.getJSON()) === before, "勾选撤销被分页历史截走")
    })
    await check("单个长列表项：原li内一段按行延续，不复制编号、checkbox或持久段落", async ({ editor }) => {
      for (const type of ["bulletList", "orderedList", "taskList"]) {
        const source = list(type, 1, type === "orderedList" ? { start: 9, type: "a" } : {}); source.content[0].content = [paragraph(longText)]
        await replace(content([source])); verify(); const itemType = type === "taskList" ? "taskItem" : "listItem"
        assert(layout().pageCount >= 3 && layout().overflowCount === 0 && nodes(itemType).length === 1 && editor.state.doc.firstChild.firstChild.childCount === 1, "长项目被完整展开或拆成多份原模型项")
      }
    })
    await check("混合嵌套列表：UL、带起始号OL与task递归跨页，原层级、顺序与checked不变", async ({ editor }) => {
      const outer = list("bulletList", 3)
      outer.content.forEach((item, index) => { const inner = list("orderedList", 24, { start: 5 + index, type: "i" }); inner.content[8].content.push(list("taskList", 8)); item.content.push(inner) })
      await replace(content([outer])); const before = json(editor.getJSON()); verify()
      assert(layout().pageCount >= 4 && layout().overflowCount === 0 && nodes("orderedList").length === 3 && nodes("taskItem").length === 24, "嵌套列表仍整体展开或层级丢失")
      await delay(250); assert(json(editor.getJSON()) === before && nodes("orderedList").every((item, index) => item.dom.start === index + 5), "嵌套分页改变原编号或模型")
    })
    await check("递归富容器：textBox、details和blockquote内长段与列表共同分页，原外壳不复制", async ({ editor }) => {
      const body = content([box([paragraph("文本框开始"), details([quote([paragraph(longText), list("orderedList", 24, { start: 11, type: "A" })])], "保留的原始摘要"), paragraph("文本框结尾")]), paragraph("所有容器之后")])
      await replace(body); const before = json(editor.getJSON()); const shells = [nodes("textBox")[0], nodes("details")[0], nodes("blockquote")[0]]
      verify(); assert(layout().pageCount >= 4 && layout().overflowCount === 0 && shells.every(item => editor.view.nodeDOM(item.pos) === item.dom), "递归容器没有安全分页或原壳被替换")
      assert(nodes("textBox").length === 1 && nodes("details").length === 1 && nodes("blockquote").length === 1 && json(editor.getJSON()) === before, "跨页复制外壳或正文")
      const state = current.store.getState(); const origin = surface().getBoundingClientRect().top
      for (const item of shells) {
        const fragment = layout().containers?.find(entry => entry.pos === item.pos); const rect = item.dom.getBoundingClientRect()
        assert(fragment && Math.abs(fragment.top - (rect.top - origin) / state.zoom) < 1 && Math.abs(fragment.height - rect.height / state.zoom) < 1, "容器origin/height没有反映当前真实DOM")
        assert(item.dom.hasAttribute("data-mewoc-container-fragment") && item.dom.style.getPropertyValue("--mewoc-container-clip").startsWith("polygon(evenodd,") && getComputedStyle(item.dom).clipPath !== "none" && !item.dom.style.clipPath, "背景分片没有通过可清理CSS变量生效")
      }
    })
    await check("详情视图：收起只隐藏原内容并减少页数，展开重新分页，不写正文修订或更换NodeView", async ({ editor, store }) => {
      await replace(content([details([paragraph(longText), list("taskList", 32)], "可以收起的长详情"), paragraph("详情之后")]))
      const before = json(editor.getJSON()); const revision = store.getState().revision; const item = nodes("details")[0]; const body = item.dom.querySelector(":scope > [data-details-content]"); const toggle = item.dom.querySelector(":scope > [data-details-toggle]"); const count = layout().pageCount
      verify(); toggle.click(); await settle(); verify()
      assert(body.hidden && layout().pageCount < count && layout().overflowCount === 0 && json(editor.getJSON()) === before && store.getState().revision === revision, "收起详情仍计算隐藏正文或制造文档变化")
      toggle.click(); await settle(); verify(); assert(!body.hidden && layout().pageCount === count && nodes("details")[0].dom === item.dom && json(editor.getJSON()) === before, "展开没有恢复分页或重建原详情")
    })
    await check("嵌套混合字形：marks、hardBreak和emoji完整跨页，不拆代理对或修改原文字", async ({ editor }) => {
      const body = Array.from({ length: 120 }, (_item, index) => [{ type: "text", text: `${index + 1} 粗斜体👩🏽‍💻家庭👨‍👩‍👧‍👦继续排版。`, marks: [{ type: "bold" }, { type: "italic" }, { type: "textStyle", attrs: { fontSize: "22.5pt", color: "#603fbb" } }] }, { type: "hardBreak" }]).flat()
      await replace(content([quote([box([{ type: "paragraph", content: body }])])]))
      const before = json(editor.getJSON()); verify(); await delay(240)
      assert(layout().pageCount >= 3 && layout().overflowCount === 0 && json(editor.getJSON()) === before, "嵌套marks/emoji/hardBreak被拆分或仍展开")
    })
    await check("文本框外观：0与40px内边距、0与6px边框实时重测，原样式和尾段均保留", async ({ editor }) => {
      await replace(content([box([paragraph(longText)]), paragraph("文本框之外的尾段")]))
      for (const padding of [0, 40]) for (const borderWidth of [0, 6]) {
        const item = nodes("textBox")[0]; editor.view.dispatch(editor.state.tr.setNodeMarkup(item.pos, null, { ...item.node.attrs, padding, borderWidth })); await settle(); verify()
        const currentBox = nodes("textBox")[0]; const style = getComputedStyle(currentBox.dom)
        assert(layout().overflowCount === 0 && style.paddingTop === `${padding}px` && style.borderTopWidth === `${borderWidth}px` && nodes("textBox").length === 1, "分页丢失文本框实测外观或重建原壳")
      }
    })
    await check("列表快捷键：续页Enter真实分项、项首Backspace合并，UL/OL/task各一次撤销恢复", async ({ editor }) => {
      for (const type of ["bulletList", "orderedList", "taskList"]) {
        await replace(content([list(type)])); const before = json(editor.getJSON()); const itemType = type === "taskList" ? "taskItem" : "listItem"
        const target = nodes(itemType)[40]; const originalText = editor.state.doc.textContent
        select(target.pos + 2 + 8); editor.view.dispatch(closeHistory(editor.state.tr)); assert(editor.commands.keyboardShortcut("Enter"), "列表Enter快捷键未执行")
        editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify(); assert(nodes(itemType).length === 65 && editor.state.doc.textContent === originalText, "Enter没有分出真实项目或丢字")
        assert(editor.commands.undo(), "列表Enter不能撤销"); await settle(); assert(json(editor.getJSON()) === before, "Enter撤销没有恢复原列表")
        select(nodes(itemType)[40].pos + 2); editor.view.dispatch(closeHistory(editor.state.tr)); assert(editor.commands.keyboardShortcut("Backspace"), "项目首Backspace快捷键未执行")
        editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify(); assert(nodes(itemType).length === 63 && editor.state.doc.textContent === originalText, "项首退格没有合并原项目或删掉内容")
        assert(editor.commands.undo(), "列表退格不能撤销"); await settle(); assert(json(editor.getJSON()) === before, "退格撤销未恢复原列表")
      }
    })
    await check("跨页模型选区：复制和删除只触及原嵌套正文，撤销恢复完整结构", async ({ editor }) => {
      const measured = glyphs(); const origin = surface().getBoundingClientRect().top; const index = measured.findIndex(item => pageForY(item.rect.top - origin).index > 0)
      assert(index > 0, "没有可选的真实跨页字形")
      const from = measured[index - 1].from; const to = measured[index].to; const before = json(editor.getJSON())
      editor.view.dispatch(closeHistory(editor.state.tr).setSelection(TextSelection.create(editor.state.doc, from, to)))
      const copied = editor.view.serializeForClipboard(editor.state.selection.content()); const expected = editor.state.doc.textBetween(from, to)
      assert(copied.text && copied.dom.textContent === expected && !copied.dom.querySelector("[data-mewoc-page-gap],[data-mewoc-repeat-header]"), "复制混入容器分页装饰或丢失原选字")
      assert(editor.commands.deleteSelection(), "跨页模型选区无法删除"); editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify()
      assert(editor.commands.undo(), "跨页模型删除无法撤销"); await settle(); verify(); assert(json(editor.getJSON()) === before, "撤销没有恢复原列表结构")
    })
    await check("表格与媒体：嵌套原行和TableView保留，播放中audio不因容器重排被复制或暂停", async ({ editor, assets, store }) => {
      const audio = await readMediaFile(createWaveFile("M25-B4-audio.wav"), "audio"); assets.set(audio.id, audio)
      await replace(content([box([list("orderedList", 20, { start: 3, type: "a" }), table(), { type: "media", attrs: { assetId: audio.id } }, paragraph(longText.slice(0, 3000))])]))
      const player = await waitFor(() => editor.view.dom.querySelector("audio"), "嵌套原生播放器未创建"); await waitFor(() => player.readyState >= 1, "原生音频没有解码")
      const tableNode = nodes("table")[0]; const rows = nodes("tableRow"); verify(); player.muted = true; await player.play(); await waitFor(() => player.currentTime > 0.1, "原生播放器没有推进")
      try {
        store.getState().updateView({ zoom: 0.75 }); await settle(); verify()
        assert(editor.view.dom.querySelectorAll("audio").length === 1 && editor.view.dom.querySelector("audio") === player && !player.paused && rows.every(item => editor.view.nodeDOM(item.pos) === item.dom) && editor.view.nodeDOM(tableNode.pos) === tableNode.dom, "容器重排复制或更换了原资源/表格节点")
        assert(nodes("tableRow").length === 28 && !TableMap.get(nodes("table")[0].node).problems?.length, "容器分页损坏原表格行与格网")
      } finally { player.pause() }
    })
    await check("安全回退：嵌套keepTogether与RTL保留完整展开，后续普通正文恢复标准页", async () => {
      await replace(content([box([paragraph(longText, { keepTogether: true }), paragraph("完整块之后")]), quote([paragraph("مرحبا" + longText)]), paragraph("所有完整块之后")]))
      verify(); assert(layout().overflowCount >= 2 && !layout().pages.at(-1).overflow, "不支持的超高原块被切开或后续没有恢复标准页")
    })
    await check("嵌套边界与代码：手动分页保留，200原代码行跨页保持newline和高亮，可Enter撤销", async ({ editor, store }) => {
      const body = list("bulletList", 18); body.content[10].content.push({ type: "heading", attrs: { level: 3, keepWithNext: true }, content: [{ type: "text", text: "项目内部标题" }] }, paragraph("与标题相邻正文"), { type: "pageBreak" }, paragraph("手动边界之后"))
      await replace(content([box([body]), paragraph("容器末尾")]))
      verify(); const heading = nodes("heading")[0]; const next = nodes("paragraph").find(item => item.node.textContent === "与标题相邻正文")
      assert(verifyRect(readParagraphGlyphs(editor, heading.dom)[0].rect, "标题").index === verifyRect(readParagraphGlyphs(editor, next.dom)[0].rect, "相邻正文").index, "嵌套标题没有连下段")
      assert(nodes("pageBreak").length === 1 && nodes("textBox").length === 1 && nodes("bulletList").length === 1, "手动换页复制容器或删除了真实分页符")
      const original = Array.from({ length: 200 }, (_item, index) => `const value${index + 1} = "原代码行";`).join("\n")
      await replace(content([details([quote([{ type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: original }] }])], "长代码详情")]))
      verify(); const before = json(editor.getJSON()); const code = nodes("codeBlock")[0]; const highlight = code.dom.querySelector(".hljs-keyword")
      assert(layout().overflowCount === 0 && layout().pageCount >= 3 && layout().breaks.some(item => Number.isInteger(item.codePos)) && highlight, "长代码仍整体展开或没有真实行断点/高亮")
      store.getState().updateView({ zoom: 0.75 }); await settle(); verify()
      assert(nodes("codeBlock")[0].dom === code.dom && code.dom.querySelector(".hljs-keyword") === highlight && code.node.textContent === original && json(editor.getJSON()) === before, "仅缩放重排更换原pre/highlight或插入newline")
      const offset = original.indexOf("const value101"); select(code.pos + 1 + offset); editor.view.dispatch(closeHistory(editor.state.tr))
      assert(editor.commands.keyboardShortcut("Enter"), "跨页代码Enter未执行"); editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify()
      assert(nodes("codeBlock")[0].node.textContent === original.slice(0, offset) + "\n" + original.slice(offset), "代码Enter误操作装饰或多插换行")
      assert(editor.commands.undo(), "代码换行不能撤销"); await settle(); verify(); assert(json(editor.getJSON()) === before, "代码换行撤销未恢复原newline内容")
    })
    await check("格式重测：嵌套合法字号、行距和半磅段距改变页数，恢复后返回原布局", async () => {
      const count = layout().pageCount; const large = list()
      large.content.forEach(item => { item.content[0].attrs = { lineHeight: 2, spaceBefore: 0.5, spaceAfter: 0.5 }; item.content[0].content[0].marks = [{ type: "textStyle", attrs: { fontSize: "22.5pt" } }] })
      await replace(content([large])); verify(); assert(layout().pageCount > count && layout().overflowCount === 0, "嵌套字号行距未触发重测")
      await replace(content([list()])); verify(); assert(layout().pageCount === count, "恢复原格式没有返回相同分页")
    })
    await check("纸型与400项精度：小数字号列表在A4/A5与50%至150%缩放保持稳定正文预算", async ({ store }) => {
      const source = list("orderedList", 400, { start: 7, type: "a" })
      source.content.forEach((item, index) => { item.content[0] = { ...paragraph(`小数间距项目 ${index + 1}。`, { spaceBefore: 0.5, spaceAfter: 0.5 }), content: [{ type: "text", text: `小数间距项目 ${index + 1}。`, marks: [{ type: "textStyle", attrs: { fontSize: "12.75pt" } }] }] } })
      await replace(content([source])); verify(); const origin = surface().getBoundingClientRect().top; const firstByPage = new Map()
      for (const item of nodes("paragraph").filter(item => item.node.textContent)) { const rect = readParagraphGlyphs(current.editor, item.dom)[0].rect; const y = rect.top - origin; const page = pageForY(y); if (!firstByPage.has(page.index)) firstByPage.set(page.index, y - page.top - mm(store.getState().page.marginsMm.top)) }
      const offsets = [...firstByPage.values()].slice(1); const maxDriftPx = Math.max(...offsets) - Math.min(...offsets); assert(maxDriftPx <= 1 && nodes("listItem").length === 400, `400项续页首字形偏差 ${maxDriftPx.toFixed(3)}px`)
      const metrics = { items: 400, pages: layout().pageCount, maxDriftPx }
      for (const size of ["A4", "A5"]) for (const orientation of ["portrait", "landscape"]) {
        store.getState().updatePage({ ...store.getState().page, size, orientation }); await settle(); verify(); const count = layout().pageCount; const positions = json(layout().breaks.map(item => item.pos))
        for (const zoom of [0.5, 1, 1.5]) { store.getState().updateView({ zoom, fitWidth: false }); await settle(); verify(); assert(layout().pageCount === count && json(layout().breaks.map(item => item.pos)) === positions, "显示缩放改变嵌套分页位置") }
      }
      return metrics
    })
    await check("组合与只读：composition期间保留原容器装饰，只读勾选被拒绝且原节点状态恢复", async ({ editor, store }) => {
      await replace(content([details([list("taskList")])]))
      const before = json(layout().breaks); const gaps = [...editor.view.dom.querySelectorAll("[data-mewoc-page-gap]")]; const target = nodes("paragraph")[40]
      editor.commands.focus(); editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); await waitFor(() => editor.view.composing, "合成组合输入未开始")
      editor.commands.insertContentAt(target.pos + 1, "候选中的嵌套内容。".repeat(100)); await delay(180)
      assert(json(layout().breaks) === before && gaps.every(item => item.isConnected), "组合输入期间更换原容器装饰")
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); await waitFor(() => !editor.view.composing, "合成组合输入未结束"); await settle(); verify()
      assert(json(layout().breaks) !== before, "组合结束后没测量最终嵌套正文")
      store.getState().updateView({ readOnly: true }); await settle(); const document = json(editor.getJSON()); const pages = json(layout().pages); const item = nodes("taskItem")[40]; const control = item.dom.querySelector(":scope > label > input")
      control.checked = !control.checked; control.dispatchEvent(new Event("change", { bubbles: true })); await delay(); verify()
      assert(!editor.isEditable && control.disabled && control.checked === item.node.attrs.checked && json(editor.getJSON()) === document && json(layout().pages) === pages, "只读勾选改变模型或没有撤回临时UI状态")
    })
    await check("保存与备份：原嵌套JSON和checked保存，Mewoc不含视图空隙，重开重新测得相同布局", async context => {
      await replace(content([box([details([list("orderedList", 32, { start: 17, type: "a" }), list("taskList", 32)])])]))
      const before = json(context.editor.getJSON()); const count = layout().pageCount; verify()
      assert(await context.saveDocument(), "嵌套正文保存失败"); const saved = await getLocalDocument(context.documentId)
      const portable = await createPortableFile(context.getSnapshot(), context.assets); const imported = await readPortableFile(new File([json(portable)], "m25-b4.mewoc.json"))
      assert(json(saved.document.content) === before && json(imported.document.content) === before && !("pagination" in saved.document) && !json(portable).includes("mewoc-page-gap") && !json(portable).includes("mewoc-container-fragment"), "备份持久化分页空隙/容器裁剪或丢失原嵌套结构")
      await mount(undefined, { ...saved, assets: new Map() }); verify(); assert(json(current.editor.getJSON()) === before && layout().pageCount === count && nodes("taskItem").filter(item => item.node.attrs.checked).length === 11, "重开未恢复编号、checked或相同布局")
    })
    await check("HTML、TXT与Word：嵌套壳与真实项目只导出一次，不导出屏幕断点、克隆控件或自动分页符", async context => {
      const source = list("orderedList", 64, { start: 7, type: "a" }); source.content.forEach((item, index) => { item.content[0] = paragraph(`B4唯一正文-${index + 1}`) })
      await replace(content([box([details([source, list("taskList", 3)], "B4唯一摘要")])]))
      const before = json(context.editor.getJSON()); const html = new DOMParser().parseFromString(await createDocumentHtml(context.getSnapshot(), context.assets), "text/html"); const article = html.querySelector("article")
      assert(article.querySelectorAll("ol").length === 1 && article.querySelector("ol").start === 7 && article.querySelector("ol").type === "a" && article.querySelectorAll("ol > li").length === 64 && article.querySelectorAll('li[data-type="taskItem"]').length === 3 && article.querySelectorAll('input[type="checkbox"]:checked').length === 1, "HTML复制壳/项目或改变编号checked")
      assert(article.querySelector("details[open] > summary").textContent === "B4唯一摘要" && !article.querySelector("[data-mewoc-page-gap],[data-details-toggle],[data-mewoc-repeat-header],[data-mewoc-container-fragment],[style*='--mewoc-container-clip']"), "HTML混入NodeView操作、屏幕间隙或容器裁剪")
      const text = createDocumentText(context.getSnapshot(), context.assets); const result = await createDocumentDocx(context.getSnapshot(), context.assets); const archive = await JSZip.loadAsync(await result.blob.arrayBuffer())
      const xml = new DOMParser().parseFromString(await archive.file("word/document.xml").async("string"), "application/xml"); const word = [...xml.getElementsByTagName("w:t")].map(item => item.textContent).join("")
      for (let index = 1; index <= 64; index += 1) { const marker = `B4唯一正文-${index}`; assert(text.split(marker + "\n").length > 1 || text.endsWith(marker), "TXT遗漏真实项目"); assert([...xml.getElementsByTagName("w:t")].filter(item => item.textContent === marker).length === 1, "Word复制或遗漏真实项目") }
      assert(word.includes("B4唯一摘要") && ![...xml.getElementsByTagName("w:br")].some(item => item.getAttribute("w:type") === "page") && json(context.editor.getJSON()) === before, "Word丢摘要、导出屏幕分页符或改变原来源")
    })
    await check("开关与会话清理：关闭清全部内层间隙，销毁后停止发布，新短文空文只有一页", async ({ editor, store }) => {
      const before = json(editor.getJSON()); const revision = store.getState().revision; const count = layout().pageCount
      assert(editor.commands.setPaginationSettings({ enabled: false }), "关闭分页失败"); await waitFor(() => !editor.view.dom.querySelector("[data-mewoc-page-gap]"), "关闭后有内层空隙残留")
      assert(editor.commands.setPaginationSettings({ enabled: true }), "开启分页失败"); await settle(); verify(); assert(layout().pageCount === count && json(editor.getJSON()) === before && store.getState().revision === revision, "分页开关改变文档或布局")
      let events = 0; editor.on("paginationUpdate", () => { events += 1 }); await mount(content([paragraph("新的短正文")]))
      const previous = events; await delay(280); verify(); assert(editor.isDestroyed && events === previous && layout().pageCount === 1, "旧容器会话继续发布或新文档继承旧页数")
      await replace({ type: "doc", content: [{ type: "paragraph" }] }); assert(layout().pageCount === 1 && layout().overflowCount === 0, "空文档残留容器分页")
    })
    await check("长前缀容器精度：400项列表后的长文本框在75%与100%保持真实origin、height和正文裁剪", async ({ editor, store }) => {
      const prefix = list("orderedList", 400, { start: 17, type: "a" })
      prefix.content.forEach((item, index) => { item.content[0] = { ...paragraph(`前置 ${index + 1}：小数字号与间距。`, { spaceBefore: 0.5, spaceAfter: 0.5 }), content: [{ type: "text", text: `前置 ${index + 1}：小数字号与间距。`, marks: [{ type: "textStyle", attrs: { fontSize: "12.75pt" } }] }] } })
      await replace(content([prefix, box([paragraph(longText, { spaceBefore: 0.5, spaceAfter: 0.5 })], { padding: 40, borderWidth: 6, backgroundColor: "#eef6ff" }), paragraph("长前缀与文本框之后")]))
      const before = json(editor.getJSON()); const measurements = []
      for (const zoom of [0.75, 1]) {
        store.getState().updateView({ zoom, fitWidth: false }); await settle(); verify()
        const item = nodes("textBox")[0]; const fragment = layout().containers?.find(entry => entry.pos === item.pos); const rect = item.dom.getBoundingClientRect(); const origin = surface().getBoundingClientRect().top
        assert(fragment?.type === "textBox", "长前缀后的原文本框没有容器几何记录")
        const originDriftPx = Math.abs(fragment.top - (rect.top - origin) / zoom); const heightDriftPx = Math.abs(fragment.height - rect.height / zoom)
        assert(originDriftPx < 1 && heightDriftPx < 1, `前置间隙累积导致容器origin/height漂移：${originDriftPx.toFixed(4)}/${heightDriftPx.toFixed(4)}px`)
        assert(layout().overflowCount === 0 && nodes("listItem").length === 400 && json(editor.getJSON()) === before, "长前缀重排改变原模型或造成完整容器展开")
        assert(item.dom.hasAttribute("data-mewoc-container-fragment") && item.dom.style.getPropertyValue("--mewoc-container-clip").startsWith("polygon(evenodd,") && getComputedStyle(item.dom).clipPath !== "none" && !item.dom.style.clipPath, "长前缀容器的真实背景裁剪没有生效")
        measurements.push({ zoom, pages: layout().pageCount, originDriftPx, heightDriftPx })
      }
      return { precedingItems: 400, measurements }
    })
    await check("代码空行与换行契约：200行空白、仅newline、尾换行和CRLF保持真实PRE/CODE与完整源码", async ({ editor }) => {
      const sources = [
        { name: "mixed-blank", text: "const head = 1;\n" + "\n".repeat(200) + "const tail = 2;" },
        { name: "newline-only", text: "\n".repeat(200) },
        { name: "trailing-newline", text: "const tail = 1;\n".repeat(200) },
        { name: "crlf", text: "const crlf = 1;\r\n".repeat(200) },
        { name: "whitespace-only", text: " \t\n".repeat(200) }
      ]
      const metrics = []; const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" })
      for (const source of sources) {
        await replace(content([details([quote([{ type: "codeBlock", attrs: { language: "plaintext" }, content: [{ type: "text", text: source.text }] }])], `代码换行-${source.name}`), paragraph("代码完整结束后的正文")]))
        verify(); const before = json(editor.getJSON()); const item = nodes("codeBlock")[0]; const code = item.dom.querySelector("code")
        assert(item.dom.tagName === "PRE" && code && code.textContent === source.text && item.node.textContent === source.text && layout().overflowCount === 0 && layout().pageCount >= 3, `${source.name} 源码被归一化、丢空行或错误回退整块展开`)
        const placements = layout().placements.filter(entry => entry.type === "codeBlock"); const lineBreaks = (source.text.match(/\r\n|\r|\n/g) || []).length
        assert(placements.length >= lineBreaks && layout().breaks.some(entry => entry.codePos === item.pos), `${source.name} 未按真实源码行分组`)
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT); const range = document.createRange(); let measured = 0
        while (walker.nextNode()) {
          const node = walker.currentNode; if (node.parentElement.closest("[data-mewoc-page-gap]")) continue
          // 空白/换行的矩形可以零宽但仍有真实行高，不能像普通字形验收一样略过它们。
          for (const { index, segment } of segmenter.segment(node.data)) {
            range.setStart(node, index); range.setEnd(node, index + segment.length)
            for (const rect of range.getClientRects()) if (rect.height > 0) { verifyRect(rect, `${source.name} 原代码字符/空行`); measured += 1 }
          }
        }
        assert(measured >= lineBreaks, `${source.name} 未测到足够真实空行矩形`)
        verifyRect(editor.view.coordsAtPos(item.pos + item.node.nodeSize - 1, 1), `${source.name} 源码尾光标行`)
        for (const gap of layout().breaks.filter(entry => entry.codePos === item.pos)) {
          const offset = gap.pos - item.pos - 1
          assert(!(source.text[offset - 1] === "\r" && source.text[offset] === "\n"), "代码断点切开CRLF对")
        }
        await delay(240); assert(json(editor.getJSON()) === before && nodes("codeBlock")[0].dom === item.dom, `${source.name} 重排改写源码或更换原PRE`)
        metrics.push({ variant: source.name, sourceLength: source.text.length, lineBreaks, placements: placements.length, pages: layout().pageCount, measuredRects: measured })
      }
      return { variants: metrics }
    })
  } finally {
    const failures = []; const failure = await unmount(); if (failure) failures.push(failure.message)
    host.remove()
    try { await removeVerificationDocuments([...records.values()]) } catch (error) { failures.push(error.message) }
    finally { restorePreferences(savedPreferences) }
    if (failures.length) report({ name: "容器分页收尾清理", passed: false, error: failures.join("；") })
  }
}

/** 只在专用端口展示原始长列表，允许根任务用原生Enter、项首Backspace与Meta/Ctrl+Z补验。 */
export async function showContainerPaginationExample() {
  requirePort(); const savedPreferences = preferences(); const source = createDocument()
  source.title = `M25-B4 容器验收-${Date.now()}`
  source.content = content([{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "M25 · 长列表与嵌套容器" }] }, list("orderedList", 64, { start: 7, type: "a" }), box([details([list("taskList", 24)], "原任务列表与文本框")]), paragraph("全部容器之后")])
  source.page.header = { text: "Mewoc · 容器分页", alignment: "left", pageNumber: "page" }; source.page.footer = { text: "原生列表编辑补验", alignment: "center", pageNumber: "page-total" }
  const assets = new Map(); const saved = await saveLocalDocument(source, assets, 0); const record = { document: source, assets, storageVersion: saved.storageVersion }
  const host = document.createElement("section"); host.dataset.containerPaginationExample = ""; host.style.cssText = "position:relative;width:1280px;max-width:100%;height:950px;margin:24px 0"; document.body.append(host)
  let current; let closing = false; let resolveFinished; let rejectFinished; let refresh
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
  const finish = async () => {
    if (closing) return
    closing = true; let failure
    if (current?.editor && refresh) for (const event of ["transaction", "selectionUpdate", "paginationUpdate"]) current.editor.off(event, refresh)
    try { if (current?.editor && !current.editor.isDestroyed && !await current.saveDocument()) throw new Error("容器分页示例保存未排空") } catch (error) { failure = error }
    try { ReactDOM.unmountComponentAtNode(host) } catch (error) { failure ||= error }
    host.remove()
    try { await removeVerificationDocuments([record]) } catch (error) { failure ||= error }
    finally { restorePreferences(savedPreferences) }
    if (failure) rejectFinished(failure); else resolveFinished()
  }
  const locate = () => {
    if (!current?.editor) return
    const editor = current.editor; const state = getPagePagination(editor); const paper = host.querySelector("[data-mewoc-editor-surface]"); const origin = paper.getBoundingClientRect().top
    let target
    editor.state.doc.descendants((node, pos) => {
      if (target || node.type.name !== "listItem") return
      const first = readParagraphGlyphs(editor, editor.view.nodeDOM(pos + 1))[0]
      if (!first) return
      const y = (first.rect.top - origin) / current.store.getState().zoom
      if (state.pages.some(page => page.index > 0 && y >= page.top && y < page.top + page.height)) target = pos + 2
    })
    if (target === undefined) return
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target)).scrollIntoView()); editor.commands.focus(); refresh?.()
  }
  try {
    localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    ReactDOM.render(<><button type="button" aria-label="结束容器分页示例" onClick={finish}>结束容器分页示例</button><button type="button" onClick={locate}>定位续页项目首行</button><p>在续页项目用Enter分项、项首Backspace合并，再用Meta/Ctrl+Z撤销。ASCII标记：M25_CONTAINER。</p><pre aria-label="容器分页原生状态">等待编辑器就绪</pre><EditorProvider record={record}><Probe capture={context => { current = context }} /></EditorProvider></>, host)
    await waitFor(() => current?.editor && host.querySelector("[data-mewoc-editor-surface]"), "容器分页示例未就绪")
    current.store.getState().updateView({ activeTab: "开始", outlineOpen: false, searchOpen: false, fitWidth: false, zoom: 1 })
    const original = json(current.editor.getJSON())
    refresh = () => {
      if (!current?.editor || current.editor.isDestroyed) return
      const { doc, selection } = current.editor.state; const state = getPagePagination(current.editor); const counts = { listItem: 0, taskItem: 0, checked: 0 }
      doc.descendants(node => { if (node.type.name === "listItem") counts.listItem += 1; if (node.type.name === "taskItem") { counts.taskItem += 1; if (node.attrs.checked) counts.checked += 1 } })
      host.querySelector('[aria-label="容器分页原生状态"]').textContent = json({ selection: { from: selection.from, to: selection.to }, currentBoundary: state.breaks[0]?.pos ?? null, textContentLength: doc.textContent.length, counts, pageCount: state.pageCount, originalMatches: json(current.editor.getJSON()) === original, markerPosition: doc.textContent.indexOf("M25_CONTAINER"), textAroundCaret: doc.textBetween(Math.max(0, selection.from - 24), Math.min(doc.content.size, selection.to + 24)) })
    }
    for (const event of ["transaction", "selectionUpdate", "paginationUpdate"]) current.editor.on(event, refresh)
    refresh(); return await finished
  } catch (error) { await finish(); throw error }
}
