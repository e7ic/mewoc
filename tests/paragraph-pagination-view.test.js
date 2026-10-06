/**
 * 真实 EditorView 的段内分页装饰验收：同一段可以跨纸面，正文、标记与历史仍是一段。
 * JSDOM 不排字，直接发布已规划的 layout；这里验证 DOM 合法性和 ProseMirror 数据边界，
 * 真实行高、字号混排、首行缩进和光标的屏幕坐标由浏览器专项验证。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TextSelection } from "@tiptap/pm/state"
import { undoDepth } from "@tiptap/pm/history"
import { PagePagination, PAGE_PAGINATION_KEY, getPagePagination } from "../src/pages/editor/extensions/page-pagination.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true })
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}

// 测量帧与扩展的 compositionend 延时由测试明确推进；不把 JSDOM 的零高矩形当作排版结果。
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
const flush = queue => {
  const pending = [...queue.values()]
  queue.clear()
  pending.forEach(entry => typeof entry === "function" ? entry() : entry.callback())
}

const settings = { enabled: true, pageHeightPx: 500, marginTopPx: 50, marginBottomPx: 50, gapPx: 24 }
const content = "<p>前文</p><p><a href='https://example.invalid/source'><strong>这是保留全部文字与原始链接的长段落，分页只改变纸面上的排列位置。</strong></a></p><p>下一段仍是正文。</p>"
const paragraphs = editor => {
  const result = []
  editor.state.doc.forEach((node, pos) => { if (node.isTextblock) result.push({ node, pos }) })
  return result
}
const widgets = editor => [...editor.view.dom.querySelectorAll("[data-mewoc-paragraph-pagination]")]
const paragraphDecorations = editor => PAGE_PAGINATION_KEY.getState(editor.state).decorations.find().filter(item => item.spec.paragraphPagination)
const widgetDecoration = editor => paragraphDecorations(editor).find(item => typeof item.spec.key === "string")

// 与实际规划器一样，续行断点指向原段内部字符位置，焦点背景装饰和 span 都只属于视图。
const layout = (editor, { paragraphIndex = 1, offset = 8, height = 180 } = {}) => {
  const paragraph = paragraphs(editor)[paragraphIndex]
  const pos = paragraph.pos + 1 + offset
  assert.ok(offset > 0 && offset < paragraph.node.content.size, "续行断点不能落在段首或段尾")
  return {
    pages: [{ index: 0, top: 0, height: 500, overflow: false }, { index: 1, top: 524, height: 500, overflow: false }],
    pageCount: 2, overflowCount: 0, contentHeight: 750, status: "paginated", constraintCount: 0,
    placements: [{ pos: paragraph.pos, top: 50, height: 80, pageIndex: 0, type: paragraph.node.type.name },
      { pos, top: 574, height: 80, pageIndex: 1, type: paragraph.node.type.name }],
    breaks: [{ pos, paragraphPos: paragraph.pos, paragraphLine: 1, height, pageIndex: 1, reason: "automatic" }]
  }
}
const publish = (editor, options) => editor.view.dispatch(editor.state.tr
  .setMeta(PAGE_PAGINATION_KEY, { layout: layout(editor, options) }).setMeta("addToHistory", false))
function createEditor(initialContent = content) {
  const host = document.body.appendChild(document.createElement("div"))
  const editor = new Editor({ element: host, content: initialContent,
    extensions: [StarterKit.configure({ trailingNode: false }), PagePagination],
    editorProps: { handleScrollToSelection: () => true }
  })
  editor.commands.setPaginationSettings(settings)
  return { editor, host, destroy: () => { editor.destroy(); host.remove() } }
}
const snapshot = editor => ({ json: editor.getJSON(), html: editor.getHTML(), text: editor.getText(),
  selection: editor.state.selection.toJSON(), depth: undoDepth(editor.state) })
const assertSnapshot = (editor, before) => {
  assert.deepEqual(editor.getJSON(), before.json)
  assert.equal(editor.getHTML(), before.html)
  assert.equal(editor.getText(), before.text)
  assert.deepEqual(editor.state.selection.toJSON(), before.selection)
  assert.equal(undoDepth(editor.state), before.depth)
}

test("段内空隙使用合法 SPAN 且 marks 为空，原链接和正文 JSON/HTML/历史保持不变", () => {
  const context = createEditor()
  const { editor } = context
  try {
    const before = snapshot(editor)
    const paragraph = paragraphs(editor)[1]
    const originalDOM = editor.view.nodeDOM(paragraph.pos)
    publish(editor)
    const [gap] = widgets(editor)
    const decoration = widgetDecoration(editor)
    assert.equal(gap.tagName, "SPAN")
    assert.equal(gap.parentElement, originalDOM)
    assert.equal(originalDOM.tagName, "P")
    assert.equal(gap.closest("a,strong"), null, "空隙不能继承链接、加粗或字体包装")
    assert.deepEqual(decoration.spec.marks, [])
    assert.equal(decoration.spec.ignoreSelection, true)
    assert.equal(decoration.spec.stopEvent(new DOM.window.Event("mousedown")), true)
    assert.equal(gap.contentEditable, "false")
    assert.equal(gap.getAttribute("aria-hidden"), "true")
    assert.equal(gap.style.height, "180px")
    assert.equal(gap.textContent, "")
    assert.equal(editor.view.nodeDOM(paragraph.pos), originalDOM)
    assert.equal(paragraphs(editor)[1].node.childCount, 1, "装饰不能切分原文 text node")
    assert.equal(originalDOM.textContent, paragraph.node.textContent)
    assertSnapshot(editor, before)
    assert.equal(editor.getHTML().includes("mewoc-paragraph-pagination"), false)
    assert.equal(editor.getHTML().includes("mewoc-paragraph-focus-clip"), false)
  } finally { context.destroy() }
})

test("跨续行 TextSelection 的复制只含真实文字与标记，不含空隙和焦点背景", () => {
  const context = createEditor()
  const { editor } = context
  try {
    publish(editor)
    const paragraph = paragraphs(editor)[1]
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,
      paragraph.pos + 1, paragraph.pos + paragraph.node.nodeSize - 1)))
    const before = snapshot(editor)
    const copied = editor.view.serializeForClipboard(editor.state.selection.content())
    assert.equal(copied.text, paragraph.node.textContent)
    assert.equal(copied.dom.querySelectorAll("p").length, 1)
    assert.equal(copied.dom.querySelectorAll("a,strong").length, 2)
    assert.equal(copied.dom.querySelector("a").getAttribute("href"), "https://example.invalid/source")
    assert.equal(copied.dom.querySelector("[data-mewoc-page-gap],[data-mewoc-paragraph-pagination]"), null)
    assert.equal(copied.dom.innerHTML.includes("mewoc-paragraph-focus-clip"), false)
    publish(editor, { height: 200 })
    assertSnapshot(editor, before)
    assert.equal(widgets(editor).length, 1)
  } finally { context.destroy() }
})

test("标题续行也使用 H1 内合法 SPAN，视图裁剪属性不进入原始标题节点", () => {
  const context = createEditor("<p>前文</p><h1><strong>一份仍是完整标题的长文本，续行分页不能创建新标题或段落。</strong></h1><p>后文</p>")
  const { editor } = context
  try {
    const before = snapshot(editor)
    const heading = paragraphs(editor)[1]
    const originalDOM = editor.view.nodeDOM(heading.pos)
    publish(editor)
    assert.equal(widgets(editor)[0].tagName, "SPAN")
    assert.equal(widgets(editor)[0].parentElement, originalDOM)
    assert.equal(originalDOM.tagName, "H1")
    assert.equal(originalDOM.querySelector("div,p,h1"), null)
    assert.ok(originalDOM.style.getPropertyValue("--mewoc-paragraph-focus-clip"))
    assert.deepEqual(widgetDecoration(editor).spec.marks, [])
    assertSnapshot(editor, before)
    assert.equal(editor.getJSON().content[1].type, "heading")
    assert.equal(editor.getJSON().content[1].attrs.level, 1)
    assert.equal(editor.getHTML().includes("mewoc-paragraph-focus-clip"), false)
  } finally { context.destroy() }
})

test("断点前后及跨断点的选区不被视图事务改写，模型位置仍能从 DOM 往返", () => {
  const context = createEditor()
  const { editor } = context
  try {
    const pos = layout(editor).breaks[0].pos
    for (const [from, to] of [[pos - 1, pos - 1], [pos, pos], [pos + 1, pos + 1], [pos - 2, pos + 3]]) {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
      const before = snapshot(editor)
      publish(editor)
      assertSnapshot(editor, before)
      for (const position of [from, to]) {
        for (const side of [-1, 1]) {
          const dom = editor.view.domAtPos(position, side)
          assert.equal(editor.view.posAtDOM(dom.node, dom.offset, side), position)
        }
      }
      const gap = widgets(editor)[0]
      assert.equal(gap.pmViewDesc.ignoreMutation({ type: "selection" }), true)
      assert.equal(gap.pmViewDesc.parseRule().ignore, true)
    }
  } finally { context.destroy() }
})

test("正文编辑形成唯一撤销记录，重新发布段内 layout 不添加历史且 undo 还原原文", () => {
  const context = createEditor()
  const { editor } = context
  try {
    const original = editor.getJSON()
    publish(editor)
    const paragraph = paragraphs(editor)[1]
    editor.view.dispatch(editor.state.tr.insertText("新增", paragraph.pos + 1))
    assert.equal(widgets(editor).length, 0, "正文改变后先恢复原段自然折行")
    assert.equal(undoDepth(editor.state), 1)
    const before = snapshot(editor)
    publish(editor)
    assertSnapshot(editor, before)
    assert.equal(undoDepth(editor.state), 1)
    assert.equal(editor.commands.undo(), true)
    assert.deepEqual(editor.getJSON(), original)
    assert.equal(widgets(editor).length, 0)
    publish(editor)
    assert.equal(undoDepth(editor.state), 0)
    assert.equal(widgets(editor).length, 1)
  } finally { context.destroy() }
})

test("split 和 merge 改变真实段结构时清除旧续行及背景，重新发布使用当前段位置", () => {
  for (const action of ["split", "merge"]) {
    const context = createEditor()
    const { editor } = context
    try {
      publish(editor)
      const oldWidgets = widgets(editor)
      const paragraph = paragraphs(editor)[1]
      const beforeCount = editor.state.doc.childCount
      const transaction = action === "split" ? editor.state.tr.split(paragraph.pos + 1 + 8) :
        editor.state.tr.join(paragraph.pos + paragraph.node.nodeSize)
      editor.view.dispatch(transaction)
      assert.equal(editor.state.doc.childCount, beforeCount + (action === "split" ? 1 : -1))
      assert.equal(paragraphDecorations(editor).length, 0, "不能保留旧字符位置的空隙或旧段背景裁剪")
      assert.equal(widgets(editor).length, 0)
      assert.equal(oldWidgets.every(widget => !widget.isConnected), true)
      assert.equal(PAGE_PAGINATION_KEY.getState(editor.state).pending, true)
      const before = snapshot(editor)
      publish(editor, { offset: 4 })
      assertSnapshot(editor, before)
      assert.equal(widgets(editor)[0].parentElement, editor.view.nodeDOM(paragraphs(editor)[1].pos))
      assert.equal(widgetDecoration(editor).from, paragraphs(editor)[1].pos + 5)
    } finally { context.destroy() }
  }
})

test("前置插入与纸面设置修改均撤掉旧续行，重新发布不沿用过时的位置", () => {
  const context = createEditor()
  const { editor } = context
  try {
    publish(editor)
    const initial = paragraphs(editor)[1].pos
    editor.view.dispatch(editor.state.tr.insertText("前文新增", 1))
    assert.equal(paragraphs(editor)[1].pos, initial + 4)
    assert.equal(paragraphDecorations(editor).length, 0)
    publish(editor)
    const before = snapshot(editor)
    editor.commands.setPaginationSettings({ pageHeightPx: 600 })
    assert.equal(paragraphDecorations(editor).length, 0)
    assert.equal(PAGE_PAGINATION_KEY.getState(editor.state).pending, true)
    publish(editor)
    assertSnapshot(editor, before)
    assert.equal(widgetDecoration(editor).from, paragraphs(editor)[1].pos + 9)
  } finally { context.destroy() }
})

test("IME 期间已有续行仅映射且保持 DOM，compositionend 后先清除再等待真实测量", () => {
  const context = createEditor()
  const { editor } = context
  try {
    publish(editor)
    const gap = widgets(editor)[0]
    const position = widgetDecoration(editor).from
    const paragraph = paragraphs(editor)[1]
    editor.commands.setTextSelection(paragraph.pos + 2)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionstart", { bubbles: true }))
    assert.equal(editor.view.composing, true)
    // 用真实模型事务代表输入法提交的候选文字；本例不声称覆盖系统原生候选框操作。
    editor.view.dispatch(editor.state.tr.insertText("你好", paragraph.pos + 2))
    assert.equal(widgetDecoration(editor).from, position + 2)
    assert.equal(widgets(editor)[0], gap)
    assert.equal(gap.isConnected, true)
    const before = snapshot(editor)
    flush(frames)
    assert.equal(widgets(editor)[0], gap, "合成中测量帧不得重建正文装饰")
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionend", { bubbles: true }))
    assert.equal(editor.view.composing, false)
    assert.equal(widgets(editor)[0], gap, "结束事件应让 ProseMirror 先完成候选提交")
    flush(timers)
    flush(frames)
    assert.equal(paragraphDecorations(editor).length, 0)
    assert.equal(gap.isConnected, false)
    assert.equal(PAGE_PAGINATION_KEY.getState(editor.state).pending, true)
    assertSnapshot(editor, before)
    publish(editor)
    assertSnapshot(editor, before)
    assert.equal(widgets(editor).length, 1)
  } finally { context.destroy() }
})

test("只读仍可展示段内分页，关闭和销毁清理 span、背景、测量帧及合成延时", () => {
  const context = createEditor()
  const { editor } = context
  const observer = observers.at(-1)
  try {
    publish(editor)
    editor.setEditable(false)
    publish(editor)
    assert.equal(widgets(editor).length, 1)
    const before = snapshot(editor)
    editor.commands.setPaginationSettings({ enabled: false })
    assert.equal(paragraphDecorations(editor).length, 0)
    assert.equal(widgets(editor).length, 0)
    assert.equal(editor.view.dom.hasAttribute("data-mewoc-pagination"), false)
    assert.equal(getPagePagination(editor).status, "disabled")
    assertSnapshot(editor, before)
    editor.commands.setPaginationSettings({ enabled: true })
    publish(editor)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionend", { bubbles: true }))
    assert.ok(frames.size > 0)
    assert.ok([...timers.values()].some(timer => timer.delay === 30))
  } finally { context.destroy() }
  assert.equal(observer.disconnected, true)
  assert.equal(frames.size, 0)
  assert.equal([...timers.values()].some(timer => timer.delay === 30), false, "扩展必须取消自己的合成结束延时")
  assert.equal(context.host.isConnected, false)
  assert.equal(editor.isDestroyed, true)
  assert.equal(getPagePagination(editor).status, "disabled")
  DOM.window.dispatchEvent(new DOM.window.Event("resize"))
  assert.equal(frames.size, 0)
})
