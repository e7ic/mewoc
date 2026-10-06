/**
 * M25-B2 正式 Workspace 跨页表格验收：真实排版、模型选格、仓库和最终 HTML/Word。
 * 鼠标拖动与 composition 为合成事件，不替代物理鼠标、系统输入法或原生系统打印。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import JSZip from "jszip"
import { closeHistory } from "@tiptap/pm/history"
import { TextSelection } from "@tiptap/pm/state"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { getPageDimensions } from "../src/pages/editor/tools/page-settings.js"
import { analyzeTablePagination } from "../src/pages/editor/tools/table-pagination.js"
import { getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { readMediaFile } from "../src/pages/editor/tools/media-assets.js"
import { TOOLBAR_MODE_KEY } from "../src/pages/editor/tools/toolbar-preferences.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { removeVerificationDocuments } from "./browser-checks.js"
import { createWaveFile } from "./media-fixtures.js"

const assert = (value, message) => { if (!value) throw new Error(message) }
const delay = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (read, message) => { const end = Date.now() + 15000; while (Date.now() < end) { const value = await read(); if (value) return value; await delay() } throw new Error(message) }
const json = value => JSON.stringify(value)
const mm = value => value * 96 / 25.4
const paragraph = (text, attrs = {}) => ({ type: "paragraph", attrs, content: [{ type: "text", text }] })
const cell = (text, header = false, attrs = {}, extra = []) => ({ type: header ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [180], ...attrs }, content: [paragraph(text), ...extra] })
const row = (cells, minHeight = null) => ({ type: "tableRow", attrs: { minHeight }, content: cells })
const makeTable = (count = 48, headers = 1) => ({ type: "table", content: Array.from({ length: count }, (_item, index) => row(Array.from({ length: 3 }, (_column, column) => cell(`${index < headers ? "表头" : "数据"} ${index + 1} / ${column + 1}`, index < headers)))) })
const content = nodes => ({ type: "doc", content: nodes })
const defaultContent = () => content([paragraph("跨页表格之前"), makeTable(), paragraph("跨页表格之后")])
const preferences = () => new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
const restorePreferences = saved => { for (const [key, value] of saved) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } }
const requirePort = () => assert(location.hostname === "127.0.0.1" && location.port === "4190", "跨页表格验收仅允许在专用 127.0.0.1:4190 运行")
function Probe({ capture }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) capture(context) }, [context, capture])
  return <EditorWorkspace onDocumentChange={() => {}} />
}

export async function runTablePaginationChecks(report = () => {}) {
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
      const state = layout()
      if (!state?.pages?.length) return false
      const signature = json({ pages: state.pages, breaks: state.breaks, height: current.editor.view.dom.offsetHeight })
      stable = signature === previous ? stable + 1 : 0; previous = signature
      return stable >= 3 && state
    }, "跨页表格布局未收敛")
  }
  const tables = () => {
    const found = []
    current.editor.state.doc.forEach((node, pos) => {
      if (node.type.name !== "table") return
      const wrapper = current.editor.view.nodeDOM(pos)
      const element = wrapper.tagName === "TABLE" ? wrapper : wrapper.querySelector("table")
      const rows = []
      node.forEach((item, offset, index) => { rows.push({ node: item, pos: pos + 1 + offset, index, dom: current.editor.view.nodeDOM(pos + 1 + offset) }) })
      found.push({ node, pos, start: pos + 1, element, rows, map: TableMap.get(node) })
    })
    return found
  }
  const pageFor = dom => {
    const y = (dom.getBoundingClientRect().top - surface().getBoundingClientRect().top) / current.store.getState().zoom
    return layout().pages.find(page => y >= page.top - 1.5 && y < page.top + page.height - 1.5)
  }
  const verify = () => {
    const state = current.store.getState(); const top = surface().getBoundingClientRect().top
    const dimensions = getPageDimensions(state.page)
    for (const table of tables()) {
      const originalRows = [...table.element.tBodies[0].children].filter(item => !item.hasAttribute("data-mewoc-table-pagination"))
      assert(originalRows.length === table.node.childCount && originalRows.every((element, index) => element === table.rows[index].dom), "原表格行被替换、遗漏或混入装饰")
      assert(table.element.querySelector(":scope > colgroup").children.length === table.map.width, "原 colgroup 与逻辑列数不一致")
      assert(!table.map.problems?.length, "分页后表格网格损坏")
      for (const item of table.rows) {
        const rect = item.dom.getBoundingClientRect(); const page = pageFor(item.dom)
        assert(page, `第 ${item.index + 1} 行未落在任何纸面`)
        const start = (rect.top - top) / state.zoom; const end = (rect.bottom - top) / state.zoom
        assert(start >= page.top + mm(state.page.marginsMm.top) - 2 && end <= page.top + page.height - mm(state.page.marginsMm.bottom) + 2, `表格第 ${item.index + 1} 行覆盖页边距：${start.toFixed(2)}–${end.toFixed(2)}`)
        item.node.forEach((entry, _offset, index) => {
          if (entry.attrs.rowspan <= 1) return
          const merged = item.dom.children[index].getBoundingClientRect(); const last = table.rows[item.index + entry.attrs.rowspan - 1].dom.getBoundingClientRect()
          assert(Math.abs(merged.bottom - last.bottom) / state.zoom < 2, "虚拟 TR 改变了浏览器纵向合并格的实际边界")
        })
      }
      const structure = analyzeTablePagination(table.node, table.pos)
      assert(structure, "有效表格未能分析行组")
      for (const group of structure.groups) assert(pageFor(table.rows[group.firstRow].dom).index === pageFor(table.rows[group.lastRow].dom).index, "分页切开了纵向合并行组")
      for (const header of table.element.querySelectorAll(":scope > tbody > [data-mewoc-repeat-header]")) {
        assert(header.tagName === "TR" && header.contentEditable === "false" && header.getAttribute("aria-hidden") === "true", "重复表头不是不可编辑且隐藏辅助行")
        assert(getComputedStyle(header).pointerEvents === "none" && getComputedStyle(header).userSelect === "none", "重复表头截获点击或文字选择")
      }
      for (const gap of table.element.querySelectorAll(":scope > tbody > [data-mewoc-table-pagination='gap']")) assert(gap.tagName === "TR" && gap.children.length === 1 && gap.children[0].colSpan === table.map.width, "间隙不是合法跨全列 TR")
    }
    for (const page of layout().pages) if (!page.overflow) assert(Math.abs(page.height - mm(dimensions.heightMm)) < 0.1, "标准纸面尺寸改变")
  }
  const select = (r, c, endRow = r, endColumn = c) => {
    const table = tables()[0]; const position = (a, b) => table.start + table.map.map[a * table.map.width + b]
    current.editor.view.dispatch(current.editor.state.tr.setSelection(CellSelection.create(current.editor.state.doc, position(r, c), position(endRow, endColumn))))
  }
  const caret = (r, c = 0) => { const table = tables()[0]; current.editor.view.dispatch(current.editor.state.tr.setSelection(TextSelection.create(current.editor.state.doc, table.start + table.map.map[r * table.map.width + c] + 2))) }
  const unmount = async () => {
    let failure
    try {
      if (current?.editor && !current.editor.isDestroyed) {
        current.store.getState().updateView({ readOnly: false, switching: false })
        assert(await current.saveDocument(), `跨页表格清理前保存未排空：${current.store.getState().saveError || "保存队列未就绪"}`)
      }
    } catch (error) { failure = error }
    // 保存失败也必须销毁会话与保存调度器，不能让下个案例继承 DOM 或迟到的写入。
    try { ReactDOM.unmountComponentAtNode(host) } catch (error) { failure ||= error }
    finally { current = null }
    return failure
  }
  const mount = async (body = defaultContent(), record) => {
    const failure = await unmount(); if (failure) throw failure
    localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    if (!record) { const document = { ...createDocument(), title: `M25-B2 表格验收-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, content: body }; const assets = new Map(); const saved = await saveLocalDocument(document, assets, 0); record = { document, assets, storageVersion: saved.storageVersion } }
    records.set(record.document.id, record)
    ReactDOM.render(<EditorProvider key={record.document.id} record={record}><Probe capture={capture} /></EditorProvider>, host)
    await waitFor(() => current?.documentId === record.document.id && surface(), "跨页表格 Workspace 未就绪")
    current.store.getState().updateView({ outlineOpen: false, searchOpen: false, zoom: 1, fitWidth: false }); await settle()
    return current
  }
  const replace = async body => { assert(current.editor.commands.setContent(body), "表格测试正文未替换"); return settle() }
  const check = async (name, run) => {
    let result
    try { await mount(); const metrics = await run(current); result = { name, passed: true, ...(metrics && { metrics }) } }
    catch (error) { result = { name, passed: false, error: error.message } }
    finally {
      const failure = await unmount()
      if (failure) result = { ...result, passed: false, error: [result?.error, failure.message].filter(Boolean).join("；") }
    }
    report(result)
  }
  const drag = (element, delta = 20) => {
    const rect = element.getBoundingClientRect(); const x = rect.right - 1; const y = rect.top + 5
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y }))
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: x + delta, clientY: y }))
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x + delta, clientY: y }))
  }
  try {
    await check("跨页表格：48 原行按行分页，页尾页首正文与表后段落均不覆盖边距", async ({ editor, store }) => {
      verify(); assert(layout().pageCount >= 3 && layout().overflowCount === 0, "长表格未按行分页")
      const internal = layout().breaks.filter(gap => gap.tablePos !== undefined)
      assert(internal.length >= 2 && editor.view.dom.querySelectorAll("[data-mewoc-table-pagination='gap']").length === internal.length, "没有真实表内分页间隙")
      const last = editor.view.nodeDOM(editor.state.doc.content.size - editor.state.doc.lastChild.nodeSize)
      assert(pageFor(last).index >= pageFor(tables()[0].rows.at(-1).dom).index, "表后段落没有随续页布局移动")
      const before = json(editor.getJSON()); const revision = store.getState().revision
      await delay(250); assert(before === json(editor.getJSON()) && revision === store.getState().revision, "表格视图重排制造文档修订")
      return { rows: 48, pages: layout().pageCount, internalBreaks: internal.length }
    })
    await check("重复表头：每个正常续页显示原表头一次，与真实列宽及数据行对齐", async () => {
      verify(); const table = tables()[0]; const original = table.rows[0].dom
      const headers = [...table.element.querySelectorAll("[data-mewoc-repeat-header]")]
      assert(headers.length === layout().breaks.filter(gap => gap.tablePos !== undefined && gap.headerHeight > 0).length && headers.length >= 2, "续页缺少或重复表头")
      for (const header of headers) {
        assert(header.textContent === original.textContent, "重复头与原文字不同")
        const cells = [...header.children]
        cells.forEach((clone, index) => { const real = original.children[index]; assert(Math.abs(clone.getBoundingClientRect().width - real.getBoundingClientRect().width) < 1, "重复头没有使用真实 colgroup") })
        const next = header.nextElementSibling
        assert(next && !next.hasAttribute("data-mewoc-table-pagination") && header.getBoundingClientRect().bottom <= next.getBoundingClientRect().top + 1, "表头盖住续页数据行")
      }
    })
    await check("多行与横向合并表头：完整起始头链与首数据行同页，续页两行原样重复", async () => {
      const table = makeTable(48, 2)
      table.content[0] = row([cell("合并分组", true, { colspan: 2, colwidth: [180, 180] }), cell("独立分组", true)])
      await replace(content([paragraph("表前内容。".repeat(120)), table, paragraph("表后内容")]))
      verify(); const currentTable = tables()[0]
      assert(pageFor(currentTable.rows[0].dom).index === pageFor(currentTable.rows[2].dom).index, "多行表头与首数据行分离")
      const internal = layout().breaks.filter(gap => gap.tablePos !== undefined && gap.headerHeight > 0)
      assert(internal.length && currentTable.element.querySelectorAll("[data-mewoc-repeat-header]").length === internal.length * 2, "多行表头未完整重复")
      assert([...currentTable.element.querySelectorAll("[data-mewoc-repeat-header]")].filter(item => item.firstElementChild.colSpan === 2).length === internal.length, "重复头丢失横向跨度")
    })
    await check("表头规则：无头、混合头、纵向头与中部头均不会启动伪重复", async () => {
      for (const kind of ["none", "mixed", "vertical", "middle"]) {
        const table = makeTable(48, kind === "none" || kind === "middle" ? 0 : 1)
        if (kind === "mixed") table.content[0].content[1].type = "tableCell"
        if (kind === "vertical") { table.content[0].content[0].attrs.rowspan = 2; table.content[1].content.shift() }
        if (kind === "middle") table.content[15].content.forEach(item => { item.type = "tableHeader" })
        await replace(content([table])); verify()
        assert(!current.editor.view.dom.querySelector("[data-mewoc-repeat-header]"), `${kind} 错误启动重复表头`)
      }
      await replace(content([makeTable(2, 2), paragraph("全部为表头的短表之后仍在同一页")]))
      verify()
      const table = tables()[0]; const tail = current.editor.view.nodeDOM(current.editor.state.doc.content.size - current.editor.state.doc.lastChild.nodeSize)
      assert(layout().pageCount === 1 && pageFor(table.rows[0].dom).index === pageFor(tail).index, "全TH表头链把表后段落额外推页")
    })
    await check("纵向合并：交错与连锁 rowspan 行组不被纸面间隙切断", async () => {
      const table = makeTable(48)
      table.content[15].content[0].attrs.rowspan = 3; table.content[16].content.shift(); table.content[17].content.shift()
      table.content[16].content[0].attrs.rowspan = 3; table.content[17].content.shift(); table.content[18].content.splice(1, 1)
      table.content[31].content[2].attrs.rowspan = 2; table.content[32].content.pop()
      await replace(content([table])); verify()
      const structure = analyzeTablePagination(tables()[0].node, tables()[0].pos)
      assert(structure.groups.some(group => group.firstRow === 15 && group.lastRow === 18), "连锁合并没有成为完整行组")
      for (const gap of layout().breaks.filter(item => item.tablePos !== undefined)) assert(!tables()[0].rows.slice(16, 19).some(item => item.pos === gap.pos), "分页插入了合并内部")
    })
    await check("超高单行：内容与格边框完整展开，后续数据页恢复标准纸高", async () => {
      const table = makeTable(35); table.content[12].content[0].content = [paragraph("超高格内正文。".repeat(1200))]
      await replace(content([table])); verify()
      const item = tables()[0].rows[12]; assert(pageFor(item.dom).overflow && layout().overflowCount === 1, "超高单行没有独占展开页")
      assert(!pageFor(tables()[0].rows[13].dom).overflow, "超高行后没有恢复正常纸面")
      assert(!item.dom.previousElementSibling?.hasAttribute("data-mewoc-repeat-header"), "展开页仍添加挤压正文的重复头")
    })
    await check("超高合并行组：超过一页的 rowspan 保留 DOM 与逻辑跨度，整组一张展开页", async () => {
      const table = makeTable(35)
      table.content[10].content[0].attrs.rowspan = 3
      for (const index of [10, 11, 12]) { table.content[index].attrs.minHeight = 420; if (index > 10) table.content[index].content.shift() }
      await replace(content([table])); verify()
      const rows = tables()[0].rows
      assert(pageFor(rows[10].dom).overflow && pageFor(rows[10].dom).index === pageFor(rows[12].dom).index && !pageFor(rows[13].dom).overflow, "超高合并组被切开或后续仍展开")
      assert(rows[10].dom.firstElementChild.rowSpan === 3, "合并跨度被修改")
    })
    await check("极大表头预算：头加完整数据行放不下时有限退化，不无限生成空页", async () => {
      const table = makeTable(8); table.content[0].attrs.minHeight = 550; table.content.slice(1).forEach(item => { item.attrs.minHeight = 650 })
      await replace(content([table])); verify()
      assert(layout().pageCount <= 9 && layout().overflowCount === 0, "不满足头加行预算时分页未有限收敛")
      assert(!current.editor.view.dom.querySelector("[data-mewoc-repeat-header]"), "无法容纳的重复表头仍挤入数据页")
      const before = json(layout().breaks); await delay(350); assert(json(layout().breaks) === before, "大表头预算导致持续翻页")
    })
    await check("重测：窄列换行、字号、行距及零内边距实时改变分页，恢复后回到初始布局", async () => {
      const initial = layout().pageCount; const table = makeTable(48)
      table.content.forEach(item => item.content.forEach(entry => { entry.attrs = { ...entry.attrs, colwidth: [100], paddingY: 0 }; entry.content[0].attrs.lineHeight = 2; entry.content[0].content[0] = { type: "text", text: "窄列内容重新换行。".repeat(8), marks: [{ type: "textStyle", attrs: { fontSize: "22.5pt" } }] } }))
      await replace(content([table])); verify(); assert(layout().pageCount > initial, "窄列与格式改变没有重新测量")
      await replace(defaultContent()); verify(); assert(layout().pageCount === initial, "格式恢复后分页没有还原")
    })
    await check("纸型缩放：A4/A5横竖、非对称边距与50%–150%缩放保持正确跨页几何", async ({ store }) => {
      for (const size of ["A4", "A5"]) for (const orientation of ["portrait", "landscape"]) {
        store.getState().updatePage({ ...store.getState().page, size, orientation, marginsMm: { top: 15, right: 18, bottom: 25, left: 22 } }); await settle(); verify()
        const signature = json(layout().pages)
        for (const zoom of [0.5, 1, 1.5]) { store.getState().updateView({ zoom, fitWidth: false }); await settle(); verify(); assert(json(layout().pages) === signature, "缩放改变表格未缩放页数") }
        store.getState().updateView({ fitWidth: true }); await settle(); verify(); assert(json(layout().pages) === signature, "适宽改变了表格物理布局")
      }
    })
    await check("小数精度：400 行12.75pt与小数段距逐页不累积漂移，最后原行不盖页脚", async ({ store }) => {
      const table = makeTable(400)
      table.content.forEach(item => { item.content = item.content.slice(0, 2); item.content.forEach(entry => { entry.content[0].attrs = { spaceBefore: 0.5, spaceAfter: 0.5 }; entry.content[0].content[0].marks = [{ type: "textStyle", attrs: { fontSize: "12.75pt" } }] }) })
      await replace(content([table])); verify(); let maxDrift = 0
      const currentTable = tables()[0]; const top = surface().getBoundingClientRect().top
      for (const placement of layout().placements.filter(item => item.type === "tableRow")) { const dom = current.editor.view.nodeDOM(placement.pos); maxDrift = Math.max(maxDrift, Math.abs((dom.getBoundingClientRect().top - top) / store.getState().zoom - placement.top)) }
      assert(maxDrift <= 1, `400 行小数布局偏移 ${maxDrift.toFixed(3)}px`)
      assert(currentTable.rows.length === 400 && currentTable.element.querySelectorAll("[data-mewoc-repeat-header]").length > 10, "400 行缺少实际续页头")
      return { rows: 400, columns: 2, cells: 800, pages: layout().pageCount, maxDriftPx: maxDrift }
    })
    await check("结构编辑：续页增删行、合并拆分保持网格完整，单次撤销恢复原行和纸面", async ({ editor }) => {
      caret(25); const before = json(editor.getJSON()); const pages = layout().pageCount
      editor.view.dispatch(closeHistory(editor.state.tr)); assert(editor.commands.addRowAfter(), "续页不能新增行"); editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify()
      assert(tables()[0].rows.length === 49, "新增行未进入原始模型")
      assert(editor.commands.undo(), "新增行不能撤销"); await settle(); assert(json(editor.getJSON()) === before && layout().pageCount === pages, "撤销没有恢复原表")
      caret(25); editor.view.dispatch(closeHistory(editor.state.tr)); assert(editor.commands.deleteRow(), "续页不能删除行"); editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify(); assert(tables()[0].rows.length === 47, "删除行没有重新分页")
      assert(editor.commands.undo(), "删除行不能撤销"); await settle(); assert(json(editor.getJSON()) === before, "删除撤销丢失原行")
      select(25, 0, 25, 1); assert(editor.commands.mergeCells(), "续页格不能合并"); await settle(); verify(); assert(tables()[0].node.child(25).firstChild.attrs.colspan === 2, "合并跨度未保留")
      assert(editor.commands.splitCell(), "续页合并格不能拆分"); await settle(); verify(); assert(tables()[0].node.child(25).childCount === 3, "拆分没有恢复逻辑列")
    })
    await check("跨页选格：CellSelection复制不含重复头或间隙，清空和撤销仅作用原格", async ({ editor }) => {
      const table = tables()[0]; const next = table.rows.find(item => pageFor(item.dom).index > pageFor(table.rows[0].dom).index); assert(next?.index > 1, "未找到实际续页数据行")
      select(next.index - 1, 0, next.index + 1, 2); const before = json(editor.getJSON()); const selected = []
      editor.state.selection.forEachCell(node => { selected.push(node.textContent) })
      const copied = editor.view.serializeForClipboard(editor.state.selection.content())
      assert(editor.state.selection instanceof CellSelection && selected.length === 9 && selected.every(text => copied.text.includes(text)), "跨页复制没有保留全部原格")
      assert(!copied.dom.querySelector("[data-mewoc-table-pagination], [data-mewoc-repeat-header], [data-mewoc-page-gap]") && !copied.text.includes("表头"), "虚拟头或间隙混入复制")
      editor.view.dispatch(closeHistory(editor.state.tr)); assert(editor.commands.deleteSelection(), "跨页选格不能清空"); editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify()
      // 官方 CellSelection.replace 清空后恢复文字光标；按原逻辑坐标读取最新 TableMap，不依赖选区类型。
      const updated = tables()[0]; const cleared = []
      for (let r = next.index - 1; r <= next.index + 1; r += 1) for (let c = 0; c < 3; c += 1) cleared.push(updated.node.nodeAt(updated.map.map[r * updated.map.width + c]).textContent)
      assert(cleared.length === 9 && cleared.every(text => !text) && updated.rows.length === 48, "清空误删原行或漏格")
      assert(editor.commands.undo(), "清空不能撤销"); await settle(); assert(json(editor.getJSON()) === before, "清空撤销没有恢复原格正文")
    })
    await check("列宽拖动：合成续页真实列边拖动更新全列及重复头，可独立撤销", async ({ editor, store }) => {
      store.getState().updateView({ zoom: 0.75 }); await settle()
      const table = tables()[0]; const item = table.rows.find(entry => pageFor(entry.dom).index > 0); const element = item.dom.children[0]
      const before = json(editor.getJSON()); const width = element.getBoundingClientRect().width / store.getState().zoom
      editor.view.dispatch(closeHistory(editor.state.tr)); drag(element, 30); editor.view.dispatch(closeHistory(editor.state.tr)); await settle(); verify()
      const next = tables()[0].node.firstChild.firstChild.attrs.colwidth[0]
      assert(Math.abs(next - width - 40) < 3, `续页列宽屏幕换算错误 ${width} → ${next}`)
      assert(tables()[0].node.content.content.every(entry => entry.firstChild.attrs.colwidth[0] === next), "拖动没有同步原全列")
      assert(editor.commands.undo(), "续页拖动无法撤销"); await settle(); assert(json(editor.getJSON()) === before, "列宽撤销污染原格")
    })
    await check("虚拟格保护：重复头和分页间隙上的合成拖动与点击不修改正文或选格", async ({ editor, store }) => {
      caret(20); const before = json(editor.getJSON()); const selected = editor.state.selection.toJSON(); const revision = store.getState().revision
      const virtual = [...editor.view.dom.querySelectorAll("[data-mewoc-repeat-header], [data-mewoc-table-pagination='gap']")]
      assert(virtual.length, "没有虚拟格保护目标")
      for (const item of virtual) { drag(item.children[0]); item.children[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); item.children[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true })); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })) }
      await settle(); assert(json(editor.getJSON()) === before && json(editor.state.selection.toJSON()) === json(selected) && store.getState().revision === revision, "虚拟格响应拖动、选格或点击")
    })
    await check("富表头同步：原音频与详情只保留一份，续页净化控件并保留摘要、文件名和真实高度", async ({ editor, assets, store }) => {
      const audio = await readMediaFile(createWaveFile("M25-B2-表头音频.wav"), "audio"); assets.set(audio.id, audio)
      const table = makeTable(); const header = table.content[0].content[0]
      header.content[0].attrs.navigationId = "nav-33333333-3333-4333-8333-333333333333"
      header.content[0].content[0].marks = [{ type: "link", attrs: { href: "https://example.com/" } }]
      header.content.push({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph("表头任务")] }] })
      header.content.push({ type: "media", attrs: { assetId: audio.id } }, { type: "details", attrs: { summary: "表头详情摘要，必须保留" }, content: [paragraph("详情正文用于展开和收起。")] })
      await replace(content([table])); verify()
      const player = editor.view.dom.querySelector("audio"); await waitFor(() => player.readyState >= 1 && !player.error, "原表头音频未解码")
      const target = tables()[0].start + tables()[0].map.map[0]; const node = editor.state.doc.nodeAt(target)
      editor.view.dispatch(editor.state.tr.setNodeMarkup(target, null, { ...node.attrs, backgroundColor: "#ddeeff" }))
      editor.commands.insertContentAt(target + 2, "新表头"); await settle(); verify()
      const assertRichHeaders = () => {
        const source = tables()[0].rows[0].dom; const sourceHeight = source.getBoundingClientRect().height / store.getState().zoom
        const repeats = [...editor.view.dom.querySelectorAll("[data-mewoc-repeat-header]")]
        assert(repeats.length && repeats.every(item => item.textContent.includes("新表头") && getComputedStyle(item.children[0]).backgroundColor === "rgb(221, 238, 255)"), "原表头文字/外观未更新续页")
        assert(repeats.every(item => !item.querySelector("[id], [data-navigation-id], input, button, audio, video, [data-resize-handle], [tabindex], a[href]")), "重复头留下导航身份或活动控件")
        assert(repeats.every(item => item.textContent.includes(audio.fileName) && item.querySelector("[data-details-toggle]")?.textContent === "表头详情摘要，必须保留"), "净化控件时丢失媒体文件名或详情摘要")
        for (const item of repeats) {
          const rect = item.getBoundingClientRect(); const page = pageFor(item)
          const top = (rect.top - surface().getBoundingClientRect().top) / store.getState().zoom
          assert(Math.abs(rect.height / store.getState().zoom - sourceHeight) < 1, "净化富表头后未保留源TR实测高度")
          assert(page && Math.abs(top - page.top - mm(store.getState().page.marginsMm.top)) < 1, "富表头被校准推离续页正文顶部")
        }
        assert(editor.view.dom.querySelectorAll("audio").length === 1 && editor.view.dom.querySelector("audio") === player, "分页重建原音频或创建第二份播放器")
      }
      assertRichHeaders()
      const toggle = tables()[0].rows[0].dom.querySelector("[data-details-toggle]")
      toggle.click(); await settle(); verify(); assert(toggle.getAttribute("aria-expanded") === "false", "原详情未收起"); assertRichHeaders()
      toggle.click(); await settle(); verify(); assert(toggle.getAttribute("aria-expanded") === "true", "原详情未展开"); assertRichHeaders()
      // 单独使用窄列纯媒体表头，不能让详情/任务净化减少的高度抵消额外打印提示的增长。
      const narrow = makeTable()
      narrow.content.forEach(item => { item.content[0].attrs.colwidth = [160] })
      narrow.content[0].content[0].content = [{ type: "media", attrs: { assetId: audio.id } }]
      await replace(content([narrow])); verify()
      const narrowPlayer = editor.view.dom.querySelector("audio"); await waitFor(() => narrowPlayer.readyState >= 1 && !narrowPlayer.error, "窄列表头原音频未解码")
      const assertNarrowHeaders = () => {
        const source = tables()[0].rows[0].dom; const originalInfo = source.querySelector("[data-media-info]")
        const sourceHeight = source.getBoundingClientRect().height / store.getState().zoom
        const repeats = [...editor.view.dom.querySelectorAll("[data-mewoc-repeat-header]")]
        assert(repeats.length > 0, "窄列纯媒体表头没有真实续页")
        for (const item of repeats) {
          const rect = item.getBoundingClientRect(); const page = pageFor(item)
          const top = (rect.top - surface().getBoundingClientRect().top) / store.getState().zoom
          assert(Math.abs(rect.height / store.getState().zoom - sourceHeight) < 1 && page && Math.abs(top - page.top - mm(store.getState().page.marginsMm.top)) < 1, "窄列媒体净化后改变了头高或页顶位置")
          assert(item.querySelector("[data-media-info]")?.textContent === originalInfo.textContent && item.textContent.includes(audio.fileName), "窄列续页头遗漏类型、文件名或大小")
          assert(!item.querySelector("[data-media-print], [data-media-player], [data-media-actions], audio, video, button, input"), "窄列续页头添加打印提示或复制媒体控件")
        }
        assert(editor.view.dom.querySelectorAll("audio").length === 1 && editor.view.dom.querySelector("audio") === narrowPlayer, "窄列重排生成第二份原生播放器")
      }
      assertNarrowHeaders(); store.getState().updateView({ zoom: 0.75 }); await settle(); verify(); assertNarrowHeaders()
    })
    await check("组合与只读：合成composition期间保留旧表格装饰，结束后更新；只读保持分页", async ({ editor, store }) => {
      const before = json(layout().breaks); const decorations = [...editor.view.dom.querySelectorAll("[data-mewoc-table-pagination]")]
      editor.commands.focus(); editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); await waitFor(() => editor.view.composing, "合成组合输入未开始")
      caret(20); editor.commands.insertContent("候选输入使单元格变高。".repeat(120)); await delay(180)
      assert(json(layout().breaks) === before && decorations.every(item => item.isConnected), "组合输入期间重建跨页表格装饰")
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); await waitFor(() => !editor.view.composing, "合成组合输入未结束"); await settle(); verify()
      assert(json(layout().breaks) !== before, "组合结束后没有重新测量")
      const pages = json(layout().pages); const document = json(editor.getJSON()); store.getState().updateView({ readOnly: true }); await settle(); verify()
      const real = tables()[0].rows[20].dom.children[0]; drag(real); assert(!editor.isEditable && json(editor.getJSON()) === document && json(layout().pages) === pages, "只读拖动改变文档或分页")
    })
    await check("嵌套表：只按外表完整行组分页，内表原节点保留且没有插入错误的外表间隙", async () => {
      const table = makeTable(); const nested = makeTable(4, 2)
      table.content[15].content[1].content.push(nested)
      await replace(content([table])); verify()
      const nestedDom = tables()[0].rows[15].dom.querySelector("table")
      assert(nestedDom && nestedDom.querySelectorAll("tr").length === 4 && !nestedDom.querySelector("[data-mewoc-table-pagination]"), "外表分页装饰进入嵌套表或原行丢失")
    })
    await check("保存重开：原行、合并与JSON保持完整，Mewoc不存虚拟头或屏幕分页状态", async context => {
      caret(20); context.editor.commands.insertContent("保存后的正文"); await settle()
      const before = json(context.editor.getJSON()); const count = layout().pageCount
      assert(await context.saveDocument(), "表格保存失败"); const saved = await getLocalDocument(context.documentId)
      const portable = await createPortableFile(context.getSnapshot(), context.assets); const imported = await readPortableFile(new File([json(portable)], "m25-b2.mewoc.json"))
      assert(json(saved.document.content) === before && json(imported.document.content) === before && !("pagination" in saved.document) && !json(portable).includes("mewoc-table-pagination"), "持久化存入虚拟行或分页状态")
      await mount(undefined, { ...saved, assets: new Map() }); verify(); assert(json(current.editor.getJSON()) === before && layout().pageCount === count && tables()[0].rows.length === 48, "重开没有重建相同分页与原格")
    })
    await check("HTML与Word导出：真实行与正文各一次，静态thead与OOXML重复头独立于屏幕装饰", async context => {
      const before = json(context.editor.getJSON()); const html = await createDocumentHtml(context.getSnapshot(), context.assets)
      const parsed = new DOMParser().parseFromString(html, "text/html"); const table = parsed.querySelector("article table")
      assert(table.rows.length === 48 && table.tHead.rows.length === 1 && table.tBodies[0].rows.length === 47, "HTML复制虚拟行或未提取真实起始表头")
      assert(!table.querySelector("[data-mewoc-table-pagination], [data-mewoc-repeat-header], [data-mewoc-page-gap], [contenteditable]"), "HTML混入屏幕表格装饰")
      const result = await createDocumentDocx(context.getSnapshot(), context.assets); const archive = await JSZip.loadAsync(await result.blob.arrayBuffer())
      const xml = new DOMParser().parseFromString(await archive.file("word/document.xml").async("string"), "application/xml")
      const rows = [...xml.getElementsByTagName("w:tr")]
      assert(rows.length === 48 && rows[0].getElementsByTagName("w:tblHeader").length === 1 && rows.slice(1).every(item => item.getElementsByTagName("w:tblHeader")[0].getAttribute("w:val") === "false"), "Word原行数或重复表头规则改变")
      assert(xml.documentElement.textContent.split("表头 1 / 1").length === 2 && !xml.documentElement.textContent.includes("mewoc-table-pagination") && json(context.editor.getJSON()) === before, "Word复制重复头正文或改写原来源")
    })
  } finally {
    const failures = []; const failure = await unmount(); if (failure) failures.push(failure.message)
    // 无论保存还是记录删除失败，都移除现场并恢复偏好；只删除确实登记过的本轮ID。
    host.remove()
    try { await removeVerificationDocuments([...records.values()]) } catch (error) { failures.push(error.message) }
    finally { restorePreferences(savedPreferences) }
    if (failures.length) report({ name: "跨页表格收尾清理", passed: false, error: failures.join("；") })
  }
}

/** 展示专用真实文档供实点与截图；结束按钮排空保存后精确清理本轮记录。 */
export async function showTablePaginationExample() {
  requirePort(); const savedPreferences = preferences(); const source = createDocument()
  source.title = `M25-B2 表格验收-${Date.now()}`
  source.content = content([{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "M25 · 跨页表格与重复表头" }] }, paragraph("这是一张可连续编辑的表格。续页自动重复起始表头，合并行组保持完整。"), makeTable(72, 2), paragraph("表格结束后继续普通正文。")])
  source.page.header = { text: "Mewoc · 跨页表格", alignment: "left", pageNumber: "page" }; source.page.footer = { text: "M25 编辑验收", alignment: "center", pageNumber: "page-total" }
  const assets = new Map(); const saved = await saveLocalDocument(source, assets, 0); const record = { document: source, assets, storageVersion: saved.storageVersion }
  const host = document.createElement("section"); host.dataset.tablePaginationExample = ""; host.style.cssText = "position:relative;width:1280px;max-width:100%;height:950px;margin:24px 0"; document.body.append(host)
  let current; let closing = false; let resolveFinished; let rejectFinished
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
  const finish = async () => {
    if (closing) return
    closing = true; let failure
    try { if (current?.editor && !current.editor.isDestroyed && !await current.saveDocument()) throw new Error("跨页表格示例保存未排空") } catch (error) { failure = error }
    try { ReactDOM.unmountComponentAtNode(host); await removeVerificationDocuments([record]) } catch (error) { failure ||= error }
    finally { host.remove(); restorePreferences(savedPreferences) }
    if (failure) rejectFinished(failure); else resolveFinished()
  }
  const capture = context => { current = context }
  try {
    localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    ReactDOM.render(<><button type="button" aria-label="结束跨页表格示例" onClick={finish}>结束跨页表格示例</button><EditorProvider record={record}><Probe capture={capture} /></EditorProvider></>, host)
    await waitFor(() => current?.editor && host.querySelector("[data-mewoc-editor-surface]"), "跨页表格示例未就绪")
    current.store.getState().updateView({ activeTab: "表格", outlineOpen: false, searchOpen: false, fitWidth: false, zoom: 1 })
    return await finished
  } catch (error) { await finish(); throw error }
}
