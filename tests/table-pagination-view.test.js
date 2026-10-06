/**
 * 真实 EditorView/TableView 的跨页表格装饰验收：视图可分段，正文、选格与撤销仍是一张完整表。
 * JSDOM 不提供真实排版；直接提交已规划的 layout，只在鼠标边界场景注入简单矩形。
 * 行组尺寸、纸面边界与缩放误差由分页纯几何和原生浏览器专项验证承担。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { undoDepth } from "@tiptap/pm/history"
import { PagePagination, PAGE_PAGINATION_KEY, getPagePagination } from "../src/pages/editor/extensions/page-pagination.js"
import { TableAppearance } from "../src/pages/editor/extensions/table-appearance.js"
import { TableColumnResize } from "../src/pages/editor/extensions/table-column-resize.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true })
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}

// 保留测量调度但不执行零尺寸 JSDOM 排版；每个 editor 销毁时必须取消它自己排队的帧。
let nextFrame = 0
const frames = new Map()
DOM.window.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id }
DOM.window.cancelAnimationFrame = id => frames.delete(id)
globalThis.requestAnimationFrame = DOM.window.requestAnimationFrame
globalThis.cancelAnimationFrame = DOM.window.cancelAnimationFrame
const observers = []
DOM.window.ResizeObserver = class {
  constructor() { this.targets = []; this.disconnected = false; observers.push(this) }
  observe(target) { this.targets.push(target) }
  disconnect() { this.disconnected = true; this.targets = [] }
}

const settings = { enabled: true, pageHeightPx: 500, marginTopPx: 50, marginBottomPx: 50, gapPx: 24 }
const content = "<p>表格之前</p><table><tbody>" +
  "<tr><th colwidth='100'><p>唯一表头 A</p></th><th colwidth='150'><p>唯一表头 B</p></th></tr>" +
  [1, 2, 3].map(index => `<tr><td colwidth='100'><p>第 ${index} 行 A</p></td><td colwidth='150'><p>第 ${index} 行 B</p></td></tr>`).join("") +
  "</tbody></table><p>表格之后</p>"
const tableState = editor => {
  let result
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name !== "table") return
    const rows = []
    node.forEach((row, offset) => rows.push({ node: row, pos: pos + 1 + offset }))
    result = { node, pos, rows, map: TableMap.get(node), dom: editor.view.nodeDOM(pos).querySelector("table") }
  })
  return result
}
const cellPos = (editor, row, column) => {
  const table = tableState(editor)
  return table.pos + 1 + table.map.map[row * table.map.width + column]
}
const widgets = editor => [...editor.view.dom.querySelectorAll("[data-mewoc-table-pagination]")]

// layout 的表头位置使用真实文档绝对位置；正文修改后重读，避免测试沿用旧位置掩盖映射问题。
const layout = (editor, headerHeight = 35) => {
  const table = tableState(editor)
  return {
    pages: [{ index: 0, top: 0, height: 500, overflow: false }, { index: 1, top: 524, height: 500, overflow: false }],
    pageCount: 2, overflowCount: 0, contentHeight: 750, status: "paginated", constraintCount: 0, placements: [],
    breaks: [{ pos: table.rows[2].pos, tablePos: table.pos, columns: table.map.width,
      headerRows: [table.rows[0].pos], headerHeight, height: 180, pageIndex: 1, reason: "automatic" }]
  }
}
const publish = (editor, headerHeight) => editor.view.dispatch(editor.state.tr
  .setMeta(PAGE_PAGINATION_KEY, { layout: layout(editor, headerHeight) }).setMeta("addToHistory", false))
function createEditor() {
  const host = document.body.appendChild(document.createElement("div"))
  const editor = new Editor({
    element: host, content, extensions: [StarterKit.configure({ trailingNode: false }),
      TableKit.configure({ table: { resizable: false } }), TableAppearance, PagePagination, TableColumnResize],
    editorProps: { handleScrollToSelection: () => true }
  })
  editor.commands.setPaginationSettings(settings)
  return { editor, host, destroy: () => { editor.destroy(); host.remove() } }
}

test("分页装饰是 tbody 内合法 TR，真实行格 DOM 与正文 JSON/HTML/历史保持不变", () => {
  const context = createEditor()
  const { editor } = context
  try {
    const table = tableState(editor)
    const rows = table.rows.map(row => editor.view.nodeDOM(row.pos))
    const cells = table.map.map.map(pos => editor.view.nodeDOM(table.pos + 1 + pos))
    const before = { json: editor.getJSON(), html: editor.getHTML(), selection: editor.state.selection.toJSON(), depth: undoDepth(editor.state) }
    publish(editor)
    const [gap, header] = widgets(editor)
    assert.equal(gap.tagName, "TR")
    assert.equal(header.tagName, "TR")
    assert.equal(gap.parentElement.tagName, "TBODY")
    assert.equal(header.parentElement, gap.parentElement)
    assert.equal(gap.dataset.mewocTablePagination, "gap")
    assert.equal(header.dataset.mewocTablePagination, "header")
    assert.equal(gap.nextElementSibling, header)
    assert.equal(header.nextElementSibling, rows[2])
    assert.equal(gap.firstElementChild.tagName, "TD")
    assert.equal(gap.firstElementChild.colSpan, 2)
    assert.equal(gap.firstElementChild.firstElementChild.style.height, "145px")
    assert.equal(header.hasAttribute("data-mewoc-repeat-header"), true)
    assert.equal(header.textContent, "唯一表头 A唯一表头 B")
    assert.equal(gap.getAttribute("aria-hidden"), "true")
    assert.equal(gap.contentEditable, "false")
    assert.equal(table.dom.querySelectorAll("tbody > tr").length, 6)
    table.rows.forEach((row, index) => assert.equal(editor.view.nodeDOM(row.pos), rows[index]))
    table.map.map.forEach((pos, index) => assert.equal(editor.view.nodeDOM(table.pos + 1 + pos), cells[index]))
    assert.deepEqual(editor.getJSON(), before.json)
    assert.equal(editor.getHTML(), before.html)
    assert.deepEqual(editor.state.selection.toJSON(), before.selection)
    assert.equal(undoDepth(editor.state), before.depth)
    assert.equal(getPagePagination(editor).pageCount, 2)
    assert.equal(editor.getHTML().includes("mewoc-table-pagination"), false)
    assert.equal(editor.getHTML().match(/唯一表头 A/g).length, 1)
  } finally { context.destroy() }
})

test("重复表头清除交互与焦点标记，保留静态摘要、外观和缩放还原后的原行高", () => {
  const context = createEditor()
  const { editor } = context
  try {
    const source = editor.view.nodeDOM(tableState(editor).rows[0].pos)
    const cell = source.firstElementChild
    // 注入 NodeView 可带来的交互标记，仅测试克隆净化；不将额外 DOM 写入 ProseMirror 正文。
    editor.view.domObserver.stop()
    for (const element of [source, cell, cell.firstElementChild]) {
      element.id = "source-only-id"
      element.setAttribute("data-navigation-id", "source-only-navigation")
      element.setAttribute("data-bookmark-name", "source-only-bookmark")
      element.setAttribute("tabindex", "0")
      element.setAttribute("autofocus", "")
      element.setAttribute("contenteditable", "true")
      element.classList.add("selectedCell", "ProseMirror-selectednode", "mewoc-focused-paragraph", "find-and-replace-result", "find-and-replace-result-current", "is-editor-empty")
    }
    cell.style.backgroundColor = "rgb(255, 243, 205)"
    const link = cell.appendChild(document.createElement("a"))
    link.href = "https://example.invalid/header"
    link.textContent = "链接说明"
    for (const tag of ["audio", "video", "button", "input", "select", "textarea"]) cell.appendChild(document.createElement(tag))
    for (const attr of ["data-resize-handle", "data-mewoc-format-mark", "data-media-actions", "data-media-error"]) {
      const element = cell.appendChild(document.createElement("span")); element.setAttribute(attr, "")
    }
    const print = cell.appendChild(document.createElement("span"))
    print.dataset.mediaPrint = ""
    print.style.display = "none"
    print.textContent = "仅用于打印的长提示，重复头不可展开这段内容。".repeat(4)
    const mediaInfo = cell.appendChild(document.createElement("span"))
    mediaInfo.dataset.mediaInfo = ""
    mediaInfo.textContent = "音频 · 示例.wav · 1 KB"
    const toggle = cell.appendChild(document.createElement("button"))
    toggle.dataset.detailsToggle = "true"
    toggle.className = "details-title"
    toggle.style.padding = "6px"
    const chevron = toggle.appendChild(document.createElement("span"))
    chevron.dataset.detailsChevron = ""
    chevron.textContent = "▾"
    const label = toggle.appendChild(document.createElement("span"))
    label.dataset.detailsLabel = ""
    label.textContent = "必须保留的详情摘要"
    // 这里只检验克隆高度的缩放换算；真实行布局与媒体撑高仍由浏览器专项验证。
    editor.view.dom.style.width = "600px"
    editor.view.dom.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 200, width: 300, height: 200 })
    let sourceHeight = 70
    source.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: sourceHeight, width: 300, height: sourceHeight })
    const sourceHTML = source.outerHTML
    const before = { json: editor.getJSON(), depth: undoDepth(editor.state) }
    publish(editor, 140)
    const header = editor.view.dom.querySelector("[data-mewoc-repeat-header]")
    assert.equal(header.getAttribute("aria-hidden"), "true")
    assert.equal(header.contentEditable, "false")
    for (const attr of ["id", "data-navigation-id", "data-bookmark-name", "tabindex", "autofocus"]) assert.equal(header.hasAttribute(attr), false)
    assert.equal(header.classList.contains("selectedCell"), false)
    assert.equal(header.classList.contains("mewoc-focused-paragraph"), false)
    assert.equal(header.querySelector("[id],[data-navigation-id],[data-bookmark-name],[tabindex],[autofocus],[contenteditable]"), null)
    assert.equal(header.querySelector(".selectedCell,.ProseMirror-selectednode,.mewoc-focused-paragraph,.find-and-replace-result,.find-and-replace-result-current,.is-editor-empty"), null)
    assert.equal(header.querySelector("audio,video,button,input,select,textarea,[data-resize-handle],[data-mewoc-format-mark],[data-media-actions],[data-media-error]"), null)
    assert.equal(header.querySelector("a").hasAttribute("href"), false)
    assert.equal(header.querySelector("[data-media-print]"), null)
    assert.equal(header.querySelector("[data-media-info]").textContent, "音频 · 示例.wav · 1 KB")
    assert.equal(header.firstElementChild.style.backgroundColor, "rgb(255, 243, 205)")
    assert.match(header.textContent, /链接说明.*音频 · 示例\.wav · 1 KB/)
    assert.equal(header.textContent.includes("仅用于打印的长提示"), false)
    assert.equal(header.style.height, "140px")
    assert.equal(header.querySelector("[data-details-toggle]").tagName, "DIV")
    assert.equal(header.querySelector("[data-details-toggle]").className, "details-title")
    assert.equal(header.querySelector("[data-details-toggle]").style.padding, "6px")
    assert.equal(header.querySelector("[data-details-label]").textContent, "必须保留的详情摘要")
    assert.equal(header.querySelector("[data-details-chevron]"), null)
    assert.equal(header.textContent.includes("▾"), false)
    assert.equal(source.id, "source-only-id")
    assert.equal(source.querySelector("button")?.tagName, "BUTTON")
    assert.equal(source.outerHTML, sourceHTML)
    sourceHeight = 80
    publish(editor, 160)
    const updated = editor.view.dom.querySelector("[data-mewoc-repeat-header]")
    assert.notEqual(updated, header)
    assert.equal(header.isConnected, false)
    assert.equal(updated.style.height, "160px")
    assert.equal(updated.querySelector("[data-details-label]").textContent, "必须保留的详情摘要")
    assert.equal(updated.querySelector("button,[data-details-chevron]"), null)
    assert.equal(updated.querySelector("[data-media-print]"), null)
    assert.equal(updated.querySelector("[data-media-info]").textContent, "音频 · 示例.wav · 1 KB")
    assert.equal(editor.view.dom.querySelector("[data-mewoc-table-pagination='gap'] td > div").style.height, "20px")
    assert.equal(source.outerHTML, sourceHTML)
    assert.equal(source.querySelector("[data-details-toggle]").tagName, "BUTTON")
    assert.equal(source.querySelector("[data-details-chevron]").textContent, "▾")
    assert.deepEqual(editor.getJSON(), before.json)
    assert.equal(undoDepth(editor.state), before.depth)
  } finally { context.destroy() }
})

test("真实表头文字与外观修改后重新提交 layout，会刷新静态表头且不添加视图撤销记录", () => {
  const context = createEditor()
  const { editor } = context
  try {
    publish(editor)
    const oldHeader = editor.view.dom.querySelector("[data-mewoc-repeat-header]")
    const pos = cellPos(editor, 0, 0)
    const node = editor.state.doc.nodeAt(pos)
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, backgroundColor: "#fff3cd", paddingY: 20 })
      .insertText("已更新 ", pos + 2))
    const json = editor.getJSON()
    const selection = editor.state.selection.toJSON()
    const depth = undoDepth(editor.state)
    publish(editor)
    const header = editor.view.dom.querySelector("[data-mewoc-repeat-header]")
    assert.notEqual(header, oldHeader)
    assert.match(header.textContent, /^已更新 唯一表头 A/)
    assert.equal(header.firstElementChild.style.backgroundColor, "rgb(255, 243, 205)")
    assert.equal(header.firstElementChild.style.paddingTop, "20px")
    assert.deepEqual(editor.getJSON(), json)
    assert.deepEqual(editor.state.selection.toJSON(), selection)
    assert.equal(undoDepth(editor.state), depth)
    assert.equal(depth, 1)
    editor.commands.undo()
    publish(editor)
    assert.equal(editor.view.dom.querySelector("[data-mewoc-repeat-header]").textContent, "唯一表头 A唯一表头 B")
    assert.equal(undoDepth(editor.state), 0)
  } finally { context.destroy() }
})

test("跨页 CellSelection 的复制和序列化只含真实行，重复表头与空隙不进入剪贴板", () => {
  const context = createEditor()
  const { editor } = context
  try {
    publish(editor)
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cellPos(editor, 0, 0), cellPos(editor, 3, 1))))
    assert.ok(editor.state.selection instanceof CellSelection)
    const copied = editor.view.serializeForClipboard(editor.state.selection.content())
    assert.equal(copied.dom.querySelectorAll("tr").length, 4)
    assert.equal(copied.dom.querySelectorAll("th,td").length, 8)
    assert.equal(copied.dom.querySelector("[data-mewoc-page-gap],[data-mewoc-repeat-header],[data-mewoc-table-pagination]"), null)
    for (const text of ["唯一表头 A", "唯一表头 B", "第 1 行 A", "第 2 行 A", "第 3 行 B"]) {
      assert.equal(copied.text.split(text).length - 1, 1)
    }
    assert.equal(editor.state.selection.content().content.firstChild.childCount, 4)
    assert.equal(widgets(editor).length, 2)
    assert.equal(editor.getHTML().match(/<tr>/g).length, 4)
  } finally { context.destroy() }
})

test("合并或增删行改变结构时立即撤下旧表内 TR，等待重新测量后再插入", () => {
  for (const action of ["merge", "insert", "delete"]) {
    const context = createEditor()
    const { editor } = context
    try {
      publish(editor)
      const table = tableState(editor)
      assert.equal(widgets(editor).length, 2)
      if (action === "merge") {
        editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cellPos(editor, 1, 0), cellPos(editor, 2, 1))))
        assert.equal(editor.commands.mergeCells(), true)
      } else {
        editor.commands.setTextSelection(cellPos(editor, 1, 0) + 2)
        assert.equal(action === "insert" ? editor.commands.addRowAfter() : editor.commands.deleteRow(), true)
      }
      assert.equal(widgets(editor).length, 0, `${action} 必须先移除旧分页装饰`)
      assert.equal(PAGE_PAGINATION_KEY.getState(editor.state).pending, true)
      assert.notEqual(tableState(editor).node, table.node)
      editor.commands.undo()
      publish(editor)
      assert.equal(widgets(editor).length, 2)
      assert.equal(tableState(editor).node.childCount, 4)
    } finally { context.destroy() }
  }
})

test("前置文字连续映射表格位置后，续页合并或增删行仍清理旧装饰并按当前位置重建", () => {
  for (const action of ["merge-horizontal", "merge-vertical", "insert", "delete"]) {
    const context = createEditor()
    const { editor } = context
    try {
      publish(editor)
      const initialPos = tableState(editor).pos
      let inserted = 0
      for (const text of ["首次前置。", "再次前置文字。"]) {
        editor.view.dispatch(editor.state.tr.insertText(text, 1))
        inserted += text.length
        const current = tableState(editor)
        assert.equal(current.pos, initialPos + inserted)
        assert.equal(widgets(editor).length, 2)
        assert.equal(editor.view.dom.querySelector("[data-mewoc-repeat-header]").textContent, "唯一表头 A唯一表头 B")
        // 不重新发布 layout，让旧装饰依靠 transaction.mapping 连续移动；断点必须落在当前的续页行。
        for (const decoration of PAGE_PAGINATION_KEY.getState(editor.state).decorations.find()) {
          assert.equal(decoration.from, current.rows[2].pos)
        }
      }
      const oldWidgets = widgets(editor)
      if (action.startsWith("merge")) {
        const firstRow = action === "merge-vertical" ? 1 : 2
        const lastColumn = action === "merge-vertical" ? 0 : 1
        editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc,
          cellPos(editor, firstRow, 0), cellPos(editor, 2, lastColumn))))
        assert.equal(editor.commands.mergeCells(), true)
      } else {
        editor.commands.setTextSelection(cellPos(editor, 2, 0) + 2)
        assert.equal(action === "insert" ? editor.commands.addRowAfter() : editor.commands.deleteRow(), true)
      }
      assert.equal(widgets(editor).length, 0, `${action} 必须识别映射后的父表并清除旧内部装饰`)
      assert.equal(oldWidgets.every(widget => !widget.isConnected), true)
      assert.equal(PAGE_PAGINATION_KEY.getState(editor.state).pending, true)
      const current = tableState(editor)
      assert.equal(current.map.problems, null)
      const realRows = current.rows.map(row => editor.view.nodeDOM(row.pos))
      const before = { json: editor.getJSON(), html: editor.getHTML(), depth: undoDepth(editor.state) }
      const nextLayout = layout(editor)
      // 纵向合并覆盖第 1、2 行，新的安全断点在第 3 行前；本例只验证结构与位置，未估算真实高度。
      if (action === "merge-vertical") nextLayout.breaks[0].pos = current.rows[3].pos
      assert.doesNotThrow(() => editor.view.dispatch(editor.state.tr
        .setMeta(PAGE_PAGINATION_KEY, { layout: nextLayout }).setMeta("addToHistory", false)))
      const [gap, header] = widgets(editor)
      assert.equal(header.textContent, "唯一表头 A唯一表头 B")
      assert.equal(header.nextElementSibling, editor.view.nodeDOM(nextLayout.breaks[0].pos))
      assert.equal(gap.parentElement, current.dom.querySelector("tbody"))
      assert.equal(current.dom.querySelectorAll("tbody > tr").length, current.rows.length + 2)
      current.rows.forEach((row, index) => {
        assert.equal(editor.view.nodeDOM(row.pos), realRows[index])
        assert.equal(realRows[index].textContent, row.node.textContent)
      })
      assert.deepEqual(editor.getJSON(), before.json)
      assert.equal(editor.getHTML(), before.html)
      assert.equal(undoDepth(editor.state), before.depth)
      assert.equal(editor.getHTML().match(/唯一表头 A/g).length, 1)
    } finally { context.destroy() }
  }
})

test("不重复表头时只插一条空隙行；关闭分页与销毁清理全部虚拟行和待执行测量", () => {
  const context = createEditor()
  const { editor } = context
  const observer = observers.at(-1)
  try {
    publish(editor, 0)
    assert.equal(widgets(editor).length, 1)
    assert.equal(editor.view.dom.querySelector("[data-mewoc-repeat-header]"), null)
    assert.equal(widgets(editor)[0].firstElementChild.firstElementChild.style.height, "180px")
    const before = editor.getJSON()
    editor.setEditable(false)
    publish(editor)
    assert.equal(widgets(editor).length, 2)
    editor.commands.setPaginationSettings({ enabled: false })
    assert.equal(widgets(editor).length, 0)
    assert.equal(editor.view.dom.hasAttribute("data-mewoc-pagination"), false)
    assert.equal(getPagePagination(editor).status, "disabled")
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(undoDepth(editor.state), 0)
    editor.commands.setPaginationSettings({ enabled: true })
    publish(editor)
    assert.equal(widgets(editor).length, 2)
    assert.ok(frames.size > 0)
  } finally { context.destroy() }
  assert.equal(observer.disconnected, true)
  assert.equal(observer.targets.length, 0)
  assert.equal(frames.size, 0)
  assert.equal(editor.isDestroyed, true)
  assert.equal(context.host.isConnected, false)
  assert.equal(getPagePagination(editor).status, "disabled")
  DOM.window.dispatchEvent(new DOM.window.Event("resize"))
  assert.equal(frames.size, 0)
})

test("虚拟表头和空隙格的边缘鼠标事件不启动列宽拖动或解析为真实单元格", () => {
  const context = createEditor()
  const { editor } = context
  try {
    publish(editor)
    const virtualCells = widgets(editor).flatMap(row => [...row.querySelectorAll("td,th")])
    const table = tableState(editor).dom
    const widths = [...table.querySelectorAll("col")].map(column => column.style.width)
    const json = editor.getJSON()
    const depth = undoDepth(editor.state)
    const originalPosAtDOM = editor.view.posAtDOM
    let resolvedVirtual = 0
    editor.view.posAtDOM = function (dom, offset, bias) {
      if (dom.closest?.("[data-mewoc-table-pagination]")) resolvedVirtual += 1
      return originalPosAtDOM.call(this, dom, offset, bias)
    }
    // 先证明真实格的热区监听仍生效；否则关闭所有列宽交互也可能让虚拟格拒绝测试误通过。
    const realCell = editor.view.nodeDOM(cellPos(editor, 0, 0))
    realCell.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 30, width: 100, height: 30 })
    realCell.dispatchEvent(new DOM.window.MouseEvent("mousemove", { bubbles: true, clientX: 99, buttons: 0 }))
    assert.equal(editor.view.dom.classList.contains("resize-cursor"), true)
    for (const cell of virtualCells) {
      // 仅制造 6px 热区边界，不以此证明真实列宽或跨页几何；应在 DOM 位置解析前拒绝虚拟格。
      cell.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 30, width: 100, height: 30 })
      cell.dispatchEvent(new DOM.window.MouseEvent("mousemove", { bubbles: true, clientX: 99, buttons: 0 }))
      assert.equal(editor.view.dom.classList.contains("resize-cursor"), false)
      const down = new DOM.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 99, button: 0, buttons: 1 })
      cell.dispatchEvent(down)
      assert.equal(down.defaultPrevented, false)
      DOM.window.dispatchEvent(new DOM.window.MouseEvent("mousemove", { clientX: 160, buttons: 1 }))
      DOM.window.dispatchEvent(new DOM.window.MouseEvent("mouseup", { clientX: 160, button: 0 }))
    }
    assert.equal(resolvedVirtual, 0)
    assert.deepEqual([...table.querySelectorAll("col")].map(column => column.style.width), widths)
    assert.deepEqual(editor.getJSON(), json)
    assert.equal(undoDepth(editor.state), depth)
    assert.equal(editor.view.dom.classList.contains("resize-cursor"), false)
  } finally { context.destroy() }
})
