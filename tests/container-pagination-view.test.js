/**
 * 递归分页的真实 EditorView 合同：空隙使用合法容器，真实 LI/checkbox/NodeView 始终只有一份。
 * JSDOM 不排字；直接提交 layout，并加载生产分页 CSS 验证列表计数声明与容器绘制隔离。
 * 自然行高、编号的可见结果和跨页鼠标操作仍由浏览器专项负责。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { compile } from "sass"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { undoDepth } from "@tiptap/pm/history"
import { DocumentTaskList, DocumentTaskItem } from "../src/pages/editor/extensions/document-task-list.js"
import { DocumentTextBox, DocumentDetails } from "../src/pages/editor/extensions/block-containers.js"
import { DocumentCodeBlock } from "../src/pages/editor/extensions/code-block.js"
import { DocumentMedia } from "../src/pages/editor/extensions/document-media.js"
import { TableAppearance } from "../src/pages/editor/extensions/table-appearance.js"
import { PagePagination, PAGE_PAGINATION_KEY, getPagePagination } from "../src/pages/editor/extensions/page-pagination.js"

const DOM = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true })
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
const stylesheet = document.head.appendChild(document.createElement("style"))
stylesheet.textContent = compile(fileURLToPath(new URL("../src/pages/editor/sass/page-pagination.scss", import.meta.url))).css
let nextFrame = 0
const frames = new Map()
DOM.window.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id }
DOM.window.cancelAnimationFrame = id => frames.delete(id)
globalThis.requestAnimationFrame = DOM.window.requestAnimationFrame
globalThis.cancelAnimationFrame = DOM.window.cancelAnimationFrame
let nextTimer = 0
const timers = new Map()
DOM.window.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id }
DOM.window.clearTimeout = id => timers.delete(id)
const observers = []
DOM.window.ResizeObserver = class {
  constructor() { this.disconnected = false; observers.push(this) }
  observe() {}
  disconnect() { this.disconnected = true }
}
const flush = queue => { const entries = [...queue.values()]; queue.clear(); entries.forEach(entry => typeof entry === "function" ? entry() : entry.callback()) }
const pauses = new WeakMap()
const loads = new WeakMap()
DOM.window.HTMLMediaElement.prototype.pause = function () { pauses.set(this, (pauses.get(this) || 0) + 1) }
DOM.window.HTMLMediaElement.prototype.load = function () { loads.set(this, (loads.get(this) || 0) + 1) }

const settings = { enabled: true, pageHeightPx: 500, marginTopPx: 50, marginBottomPx: 50, gapPx: 24 }
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const listItem = text => ({ type: "listItem", content: [paragraph(text)] })
const taskItem = (text, checked = false) => ({ type: "taskItem", attrs: { checked }, content: [paragraph(text)] })
const ordered = (items = [listItem("第一项保留编号"), listItem("第二项跨页"), listItem("第三项接续")]) =>
  ({ type: "orderedList", attrs: { start: 4, type: "i" }, content: items })
const body = nodes => ({ type: "doc", content: [paragraph("前文"), ...nodes] })
const find = (editor, type) => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === type) result.push({ node, pos, dom: editor.view.nodeDOM(pos) }) })
  return result
}
const gaps = editor => [...editor.view.dom.querySelectorAll("[data-mewoc-page-gap]")]
const flowDecorations = editor => PAGE_PAGINATION_KEY.getState(editor.state).decorations.find()
  .filter(item => item.spec.containerPagination || item.spec.paragraphPagination || item.spec.codePagination)
const layout = (breaks, placements = [], containers = []) => ({
  pages: [{ index: 0, top: 0, height: 500, overflow: false }, { index: 1, top: 524, height: 500, overflow: false }],
  pageCount: 2, overflowCount: 0, contentHeight: 800, status: "paginated", constraintCount: 0, breaks, placements, containers
})
const gap = (pos, extra = {}) => ({ pos, height: 180, pageIndex: 1, reason: "automatic", ...extra })
const publish = (editor, value) => editor.view.dispatch(editor.state.tr
  .setMeta(PAGE_PAGINATION_KEY, { layout: value }).setMeta("addToHistory", false))
const listLayout = editor => {
  const items = find(editor, "listItem").length ? find(editor, "listItem") : find(editor, "taskItem")
  return layout([gap(items[1].pos, { listPagination: true })])
}
const snapshot = editor => ({ json: editor.getJSON(), html: editor.getHTML(), selection: editor.state.selection.toJSON(), depth: undoDepth(editor.state) })
const assertSnapshot = (editor, before) => {
  assert.deepEqual(editor.getJSON(), before.json)
  assert.equal(editor.getHTML(), before.html)
  assert.deepEqual(editor.state.selection.toJSON(), before.selection)
  assert.equal(undoDepth(editor.state), before.depth)
}
function createEditor(content = body([ordered()])) {
  const host = document.body.appendChild(document.createElement("div"))
  const assets = new Map([["audio-test", { id: "audio-test", kind: "audio", fileName: "验收.wav", byteLength: 128 }],
    ["video-test", { id: "video-test", kind: "video", fileName: "验收.mp4", byteLength: 256 }]])
  const editor = new Editor({ element: host, content,
    extensions: [StarterKit.configure({ trailingNode: false, codeBlock: false }), DocumentTaskList, DocumentTaskItem,
      DocumentTextBox, DocumentDetails, DocumentCodeBlock, TableKit.configure({ table: { resizable: false } }),
      TableAppearance, DocumentMedia.configure({ getAsset: id => assets.get(id), getAssetUrl: id => `blob:mewoc-${id}` }), PagePagination],
    editorProps: { handleScrollToSelection: () => true }
  })
  editor.commands.setPaginationSettings(settings)
  return { editor, host, destroy: () => { editor.destroy(); host.remove() } }
}

test("OL/UL 间隙是合法空 LI 且不递增计数，原 start/type、真实项与 JSON/HTML 保持不变", () => {
  for (const type of ["orderedList", "bulletList"]) {
    const list = ordered(); list.type = type
    if (type === "bulletList") delete list.attrs
    const context = createEditor(body([list]))
    const { editor } = context
    try {
      const original = find(editor, "listItem").map(item => item.dom)
      const listDOM = find(editor, type)[0].dom
      const before = snapshot(editor)
      publish(editor, listLayout(editor))
      const [spacer] = gaps(editor)
      assert.equal(spacer.tagName, "LI")
      assert.equal(spacer.parentElement, listDOM)
      assert.equal(spacer.nextElementSibling, original[1])
      assert.equal(spacer.textContent, "")
      assert.equal(spacer.getAttribute("aria-hidden"), "true")
      assert.equal(spacer.contentEditable, "false")
      const style = getComputedStyle(spacer)
      assert.equal(style.display, "block")
      assert.equal(style.listStyleType || style.listStyle, "none", "JSDOM 可保留未展开的生产 list-style shorthand")
      assert.equal(style.counterIncrement, "list-item 0", "counter-increment:none 不能阻止隐式列表编号")
      assert.ok([...listDOM.children].every(child => child.tagName === "LI"))
      assert.equal(listDOM.children.length, original.length + 1)
      find(editor, "listItem").forEach((item, index) => assert.equal(item.dom, original[index]))
      if (type === "orderedList") { assert.equal(listDOM.start, 4); assert.equal(listDOM.type, "i") }
      assertSnapshot(editor, before)
      assert.equal(editor.getHTML().includes("mewoc-page-gap"), false)
      assert.equal(editor.getHTML().match(/<li/g).length, original.length)
    } finally { context.destroy() }
  }
})

test("嵌套列表只在命中层插空 LI，父项和子项的编号及内容都保留一份", () => {
  const nested = ordered([listItem("子项一"), listItem("子项二")])
  const context = createEditor(body([ordered([{ type: "listItem", content: [paragraph("父项"), nested] }, listItem("父项二")])]))
  const { editor } = context
  try {
    const lists = find(editor, "orderedList")
    const nestedItems = find(editor, "listItem").filter(item => item.dom.parentElement === lists[1].dom)
    const before = snapshot(editor)
    publish(editor, layout([gap(nestedItems[1].pos, { listPagination: true })]))
    assert.equal(gaps(editor)[0].parentElement, lists[1].dom)
    assert.equal(lists[0].dom.children.length, 2)
    assert.equal(lists[1].dom.children.length, 3)
    assert.equal(gaps(editor)[0].querySelector("li,ol,ul,p,input"), null)
    assert.equal(lists[0].dom.start, 4)
    assert.equal(lists[1].dom.start, 4)
    assertSnapshot(editor, before)
  } finally { context.destroy() }
})

test("任务项跨页保留同一 checkbox/label 与 checked，勾选只产生一个真实正文撤销步骤", () => {
  const context = createEditor(body([{ type: "taskList", content: [taskItem("第一项"), taskItem("第二项", true), taskItem("第三项")] }]))
  const { editor } = context
  try {
    const item = find(editor, "taskItem")[1]
    const input = item.dom.querySelector("input")
    const label = input.parentElement
    const before = snapshot(editor)
    publish(editor, listLayout(editor))
    assert.equal(gaps(editor)[0].nextElementSibling, item.dom)
    assert.equal(gaps(editor)[0].querySelector("input,label"), null)
    assert.equal(item.dom.querySelector("input"), input)
    assert.equal(input.parentElement, label)
    assert.equal(input.checked, true)
    assertSnapshot(editor, before)
    input.checked = false
    input.dispatchEvent(new DOM.window.Event("change", { bubbles: true }))
    assert.equal(find(editor, "taskItem")[1].node.attrs.checked, false)
    assert.equal(undoDepth(editor.state), 1)
    assert.equal(gaps(editor).length, 0)
    publish(editor, listLayout(editor))
    assert.equal(find(editor, "taskItem")[1].dom.querySelector("input"), input)
    assert.equal(undoDepth(editor.state), 1)
    assert.equal(editor.commands.undo(), true)
    assert.equal(find(editor, "taskItem")[1].node.attrs.checked, true)
  } finally { context.destroy() }
})

test("列表项内部后段使用合法 DIV，当前项的原 marker/checkbox 不被复制成续项", () => {
  const context = createEditor(body([ordered([{ type: "listItem", content: [paragraph("同项前段"), paragraph("同项后段")] }, listItem("下一项")])]))
  const { editor } = context
  try {
    const item = find(editor, "listItem")[0]
    const second = find(editor, "paragraph").find(value => value.node.textContent === "同项后段")
    const before = snapshot(editor)
    publish(editor, layout([gap(second.pos, { containerPagination: true })]))
    assert.equal(gaps(editor)[0].tagName, "DIV")
    assert.equal(gaps(editor)[0].parentElement, item.dom)
    assert.equal(gaps(editor)[0].nextElementSibling, second.dom)
    assert.equal(find(editor, "orderedList")[0].dom.children.length, 2)
    assert.equal(item.dom.querySelector("li,input"), null)
    assertSnapshot(editor, before)
  } finally { context.destroy() }
})

test("同一长列表项的段内分页保留合法 SPAN，直属 LI 数量和复制的列表项数量均不增加", () => {
  const text = "同一个长列表项保持原文和编号，换页只插入不参与文档内容的留白。"
  const context = createEditor(body([ordered([listItem(text), listItem("之后")])]))
  const { editor } = context
  try {
    const item = find(editor, "listItem")[0]
    const paragraphNode = find(editor, "paragraph").find(value => value.node.textContent === text)
    const position = paragraphNode.pos + 9
    const before = snapshot(editor)
    publish(editor, layout([gap(position, { paragraphPos: paragraphNode.pos, paragraphLine: 1 })], [
      { pos: paragraphNode.pos, top: 50, height: 80, pageIndex: 0, type: "paragraph" },
      { pos: position, top: 574, height: 80, pageIndex: 1, type: "paragraph" }
    ]))
    assert.equal(gaps(editor)[0].tagName, "SPAN")
    assert.equal(gaps(editor)[0].parentElement, paragraphNode.dom)
    assert.equal(item.dom.parentElement.children.length, 2)
    assertSnapshot(editor, before)
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, paragraphNode.pos + 1,
      paragraphNode.pos + paragraphNode.node.nodeSize - 1)))
    const copied = editor.view.serializeForClipboard(editor.state.selection.content())
    assert.equal(copied.text, text)
    assert.equal(copied.dom.querySelector("[data-mewoc-page-gap]"), null)
    // 普通文字选区只复制段落；整个真实 LI 的 NodeSelection 才应包含一份列表项。
    const wholeItem = editor.view.serializeForClipboard(NodeSelection.create(editor.state.doc, item.pos).content())
    assert.equal(wholeItem.dom.querySelectorAll("li").length, 1)
    assert.equal(wholeItem.dom.querySelector("[data-mewoc-page-gap]"), null)
  } finally { context.destroy() }
})

test("彩色容器绘制按纸面裁剪，原外壳和子资源 DOM 不重建且列表 marker 不被裁剪", () => {
  const context = createEditor(body([{ type: "textBox", content: [{ type: "blockquote", content: [paragraph("框内前段"), paragraph("框内后段")] }] }, ordered()]))
  const { editor } = context
  try {
    const box = find(editor, "textBox")[0]
    const quote = find(editor, "blockquote")[0]
    const second = find(editor, "paragraph").find(value => value.node.textContent === "框内后段")
    const before = snapshot(editor)
    publish(editor, layout([gap(second.pos, { containerPagination: true })], [
      { pos: second.pos - 10, top: 70, height: 80, pageIndex: 0, type: "paragraph" },
      { pos: second.pos, top: 594, height: 80, pageIndex: 1, type: "paragraph" }
    ], [box, quote].map(container => ({ pos: container.pos, nodeSize: container.node.nodeSize, type: container.node.type.name, top: 50, height: 700 }))))
    for (const container of [box, quote]) {
      assert.equal(editor.view.nodeDOM(container.pos), container.dom)
      assert.ok(container.dom.style.getPropertyValue("--mewoc-container-clip"))
      assert.match(getComputedStyle(container.dom).clipPath, /mewoc-container-clip/)
    }
    assert.equal(gaps(editor)[0].parentElement, quote.dom)
    assert.ok(["", "none"].includes(getComputedStyle(find(editor, "orderedList")[0].dom).clipPath))
    assertSnapshot(editor, before)
    assert.equal(editor.getHTML().includes("mewoc-container-clip"), false)
  } finally { context.destroy() }
})

test("详情正文 DIV 间隙位于 contentDOM，折叠与重排保留原按钮、摘要和视图状态", () => {
  const context = createEditor(body([{ type: "details", attrs: { summary: "只出现一次的摘要" }, content: [paragraph("前段"), paragraph("后段")] }]))
  const { editor } = context
  try {
    const details = find(editor, "details")[0]
    const button = details.dom.querySelector("[data-details-toggle]")
    const contentDOM = details.dom.querySelector("[data-details-content]")
    const second = find(editor, "paragraph").find(value => value.node.textContent === "后段")
    const before = snapshot(editor)
    publish(editor, layout([gap(second.pos, { containerPagination: true })], [],
      [{ pos: details.pos, nodeSize: details.node.nodeSize, type: "details", top: 50, height: 700 }]))
    assert.equal(gaps(editor)[0].parentElement, contentDOM)
    assert.equal(details.dom.querySelectorAll("[data-details-toggle]").length, 1)
    assert.equal(details.dom.querySelector("[data-details-toggle]"), button)
    assertSnapshot(editor, before)
    button.dispatchEvent(new DOM.window.Event("click", { bubbles: true }))
    assert.equal(contentDOM.hidden, true)
    const collapsed = { ...layout([]), containers: [], pageCount: 1, pages: [{ index: 0, top: 0, height: 500, overflow: false }] }
    publish(editor, collapsed)
    assert.equal(gaps(editor).length, 0)
    assert.equal(details.dom.querySelector("[data-details-toggle]"), button)
    assert.equal(contentDOM.hidden, true)
    assert.equal(button.getAttribute("aria-expanded"), "false")
    assert.deepEqual(editor.getJSON(), before.json)
    assert.equal(editor.getHTML(), before.html, "静态详情仍须包含完整正文")
    button.dispatchEvent(new DOM.window.Event("click", { bubbles: true }))
    assert.equal(contentDOM.hidden, false)
    assert.equal(editor.view.nodeDOM(details.pos), details.dom)
  } finally { context.destroy() }
})

test("容器内表格续页仍使用合法 TR，原 TableView、行格与重复表头只有一份持久内容", () => {
  const table = { type: "table", content: ["表头", "数据一", "数据二"].map((text, index) => ({ type: "tableRow", content: [
    { type: index === 0 ? "tableHeader" : "tableCell", content: [paragraph(text)] }
  ] })) }
  const context = createEditor(body([{ type: "textBox", content: [table] }]))
  const { editor } = context
  try {
    const original = find(editor, "table")[0]
    const rows = find(editor, "tableRow")
    const before = snapshot(editor)
    publish(editor, layout([gap(rows[2].pos, { tablePos: original.pos, columns: 1, headerRows: [rows[0].pos], headerHeight: 40 })]))
    assert.equal(gaps(editor)[0].tagName, "TR")
    assert.equal(gaps(editor)[0].parentElement.tagName, "TBODY")
    assert.equal(editor.view.nodeDOM(original.pos), original.dom)
    rows.forEach(row => assert.equal(editor.view.nodeDOM(row.pos), row.dom))
    assert.equal(editor.view.dom.querySelectorAll("[data-mewoc-repeat-header]").length, 1)
    assertSnapshot(editor, before)
    assert.equal(editor.getHTML().match(/表头/g).length, 1)
  } finally { context.destroy() }
})

test("代码续行使用 CODE 内合法 SPAN，原 newline、高亮、完整复制和历史保持不变", async () => {
  const source = "const alpha = 1;\n\nconst beta = alpha + 2;\nconsole.log(beta);\n"
  const context = createEditor(body([{ type: "textBox", content: [{ type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: source }] }] }]))
  const { editor } = context
  try {
    const code = find(editor, "codeBlock")[0]
    const codeDOM = code.dom.querySelector("code")
    const position = code.pos + 1 + source.indexOf("const beta")
    // 高亮有自己的 150ms 防抖与动态加载；先等待真实装饰完成，再证明分页保留它。
    for (let attempt = 0; attempt < 100 && !codeDOM.querySelector("[class^='hljs-'],[class*=' hljs-']"); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(codeDOM.querySelectorAll("[class^='hljs-'],[class*=' hljs-']").length > 0)
    const before = snapshot(editor)
    publish(editor, layout([gap(position, { codePos: code.pos, codeLine: 2 })], [],
      [{ pos: code.pos, nodeSize: code.node.nodeSize, type: "codeBlock", top: 50, height: 700 }]))
    const spacer = gaps(editor)[0]
    assert.equal(spacer.tagName, "SPAN")
    assert.equal(spacer.closest("code"), codeDOM)
    assert.equal(spacer.hasAttribute("data-mewoc-code-pagination"), true)
    assert.equal(getComputedStyle(spacer).display, "block")
    assert.equal(spacer.querySelector("br,div,p"), null)
    assert.equal(codeDOM.textContent, source)
    assert.ok(codeDOM.querySelectorAll("[class^='hljs-'],[class*=' hljs-']").length > 0)
    assert.equal(editor.view.nodeDOM(code.pos), code.dom)
    assertSnapshot(editor, before)
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, code.pos + 1, code.pos + code.node.nodeSize - 1)))
    const copied = editor.view.serializeForClipboard(editor.state.selection.content())
    assert.equal(copied.text, source)
    assert.equal(copied.dom.querySelector("[data-mewoc-code-pagination],[data-mewoc-page-gap]"), null)
  } finally { context.destroy() }
})

test("媒体嵌套在跨页容器中仍保持播放器 identity/currentTime/src，视图重排不暂停或重载", () => {
  const context = createEditor(body([{ type: "textBox", content: [paragraph("媒体前"),
    { type: "media", attrs: { assetId: "audio-test" } }, { type: "media", attrs: { assetId: "video-test" } }, paragraph("媒体后")] }]))
  const { editor } = context
  let players
  try {
    players = [...editor.view.dom.querySelectorAll("audio,video")]
    players.forEach(player => { player.currentTime = 12.5 })
    const srcs = players.map(player => player.getAttribute("src"))
    const media = find(editor, "media")
    const before = snapshot(editor)
    for (const height of [180, 200]) publish(editor, layout([gap(media[1].pos, { containerPagination: true, height })], [],
      [{ pos: find(editor, "textBox")[0].pos, nodeSize: find(editor, "textBox")[0].node.nodeSize, type: "textBox", top: 50, height: 800 }]))
    assert.deepEqual([...editor.view.dom.querySelectorAll("audio,video")], players)
    players.forEach((player, index) => {
      assert.equal(player.currentTime, 12.5)
      assert.equal(player.getAttribute("src"), srcs[index])
      assert.equal(pauses.get(player) || 0, 0)
      assert.equal(loads.get(player) || 0, 0)
    })
    media.forEach(item => assert.equal(editor.view.nodeDOM(item.pos), item.dom))
    assertSnapshot(editor, before)
  } finally { context.destroy() }
  players.forEach(player => { assert.equal(pauses.get(player), 1); assert.equal(loads.get(player), 1) })
})

test("缩进和列表类型替换先移除旧递归断点，原列表结构变化后重新发布使用新父容器", () => {
  for (const action of ["sink", "convert"]) {
    const context = createEditor()
    const { editor } = context
    try {
      publish(editor, listLayout(editor))
      const old = gaps(editor)
      const item = find(editor, "listItem")[1]
      editor.commands.setTextSelection(item.pos + 2)
      assert.equal(action === "sink" ? editor.commands.sinkListItem("listItem") : editor.commands.toggleDocumentList("taskList"), true)
      assert.equal(flowDecorations(editor).length, 0)
      assert.equal(gaps(editor).length, 0)
      assert.ok(old.every(spacer => !spacer.isConnected))
      assert.equal(PAGE_PAGINATION_KEY.getState(editor.state).pending, true)
      const before = snapshot(editor)
      const items = find(editor, action === "sink" ? "listItem" : "taskItem")
      publish(editor, layout([gap(items[1].pos, { listPagination: true })]))
      assert.equal(gaps(editor)[0].parentElement, items[1].dom.parentElement)
      assertSnapshot(editor, before)
    } finally { context.destroy() }
  }
})

test("递归断点在 IME 中只映射并保留 LI DOM，结束后恢复自然流再等待重测", () => {
  const context = createEditor()
  const { editor } = context
  try {
    publish(editor, listLayout(editor))
    const spacer = gaps(editor)[0]
    const oldPosition = PAGE_PAGINATION_KEY.getState(editor.state).decorations.find().find(item => item.spec.key)?.from
    const paragraphNode = find(editor, "paragraph")[1]
    editor.commands.setTextSelection(paragraphNode.pos + 2)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionstart", { bubbles: true }))
    assert.equal(editor.view.composing, true)
    editor.view.dispatch(editor.state.tr.insertText("你好", paragraphNode.pos + 2))
    assert.equal(gaps(editor)[0], spacer)
    assert.ok(PAGE_PAGINATION_KEY.getState(editor.state).decorations.find().some(item => item.from === oldPosition + 2))
    const before = snapshot(editor)
    flush(frames)
    assert.equal(gaps(editor)[0], spacer)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionend", { bubbles: true }))
    flush(timers)
    flush(frames)
    assert.equal(flowDecorations(editor).length, 0)
    assert.equal(spacer.isConnected, false)
    assertSnapshot(editor, before)
  } finally { context.destroy() }
})

test("只读仍能显示递归分页，关闭与销毁清理间隙和裁剪，并释放测量资源", () => {
  const context = createEditor()
  const { editor } = context
  const observer = observers.at(-1)
  try {
    publish(editor, listLayout(editor))
    editor.setEditable(false)
    publish(editor, listLayout(editor))
    assert.equal(gaps(editor).length, 1)
    const before = snapshot(editor)
    editor.commands.setPaginationSettings({ enabled: false })
    assert.equal(flowDecorations(editor).length, 0)
    assert.equal(gaps(editor).length, 0)
    assert.equal(getPagePagination(editor).status, "disabled")
    assertSnapshot(editor, before)
    editor.commands.setPaginationSettings({ enabled: true })
    publish(editor, listLayout(editor))
    assert.ok(frames.size > 0)
  } finally { context.destroy() }
  assert.equal(observer.disconnected, true)
  assert.equal(frames.size, 0)
  assert.equal(editor.isDestroyed, true)
  DOM.window.dispatchEvent(new DOM.window.Event("resize"))
  assert.equal(frames.size, 0)
})
