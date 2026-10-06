/** 分页纯几何与真实 EditorView 装饰生命周期；真实字体/缩放/媒体高度另由浏览器验收。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { undoDepth } from "@tiptap/pm/history"
import { PagePagination, PAGE_PAGINATION_KEY, getPagePagination } from "../src/pages/editor/extensions/page-pagination.js"
import { PageBreak } from "../src/pages/editor/extensions/page-break.js"
import { ParagraphLayout } from "../src/pages/editor/extensions/paragraph-layout.js"
import { DEFAULT_PAGINATION_SETTINGS, normalizePaginationSettings, planPagePagination } from "../src/pages/editor/tools/page-pagination.js"

const settings = { enabled: true, pageHeightPx: 500, marginTopPx: 50, marginBottomPx: 50, gapPx: 24 }
const block = (pos, height, extra = {}) => ({ pos, nodeSize: 5, height, type: "paragraph", marginTop: 0, marginBottom: 0, ...extra })
const manual = pos => block(pos, 0, { nodeSize: 1, type: "pageBreak" })

test("纸面、边距与空隙校验拒绝非有限尺寸和零正文预算，不改输入", () => {
  const snapshot = structuredClone(settings)
  assert.deepEqual(normalizePaginationSettings(settings), settings)
  assert.deepEqual(settings, snapshot)
  for (const value of [null, [], { ...settings, enabled: 1 }, { ...settings, gapPx: -1 }, { ...settings, pageHeightPx: Infinity },
    { ...settings, marginTopPx: 450 }, { ...settings, extra: true }]) assert.throws(() => normalizePaginationSettings(value), /分页尺寸/)
  assert.deepEqual(normalizePaginationSettings(DEFAULT_PAGINATION_SETTINGS), DEFAULT_PAGINATION_SETTINGS)
})

test("分页关闭不造纸面；空正文启用仍保留标准首张纸", () => {
  assert.equal(planPagePagination([], { ...settings, enabled: false }).pageCount, 0)
  const layout = planPagePagination([], settings)
  assert.deepEqual(layout.pages, [{ index: 0, top: 0, height: 500, overflow: false }])
  assert.equal(layout.contentHeight, 0)
  assert.equal(layout.status, "paginated")
})

test("实际块恰好装满正文页不提前换页，下一块空隙覆盖三段页面留白", () => {
  const layout = planPagePagination([block(0, 160), block(5, 240), block(10, 50)], settings)
  assert.equal(layout.pageCount, 2)
  assert.deepEqual(layout.breaks, [{ pos: 10, height: 124, pageIndex: 1, reason: "automatic" }])
  assert.deepEqual(layout.placements.map(item => item.top), [50, 210, 574])
  assert.equal(layout.contentHeight, 574)
  assert.deepEqual(layout.pages[1], { index: 1, top: 524, height: 500, overflow: false })
})

test("CSS 实测的首项默认与后续块上下 margin 单独计入，无累积漂移", () => {
  const input = [block(0, 100, { marginBottom: 10 }), block(5, 240, { marginTop: 20, marginBottom: 10 }), block(10, 80, { marginTop: 15 })]
  const snapshot = structuredClone(input)
  const layout = planPagePagination(input, settings)
  assert.deepEqual(layout.placements.map(item => item.top), [50, 180, 589])
  assert.equal(layout.breaks[0].height, 144)
  assert.deepEqual(input, snapshot)
  assert.equal(layout.contentHeight, 619)
})

test("首项显式段前距不可被首项默认样式规则吞掉", () => {
  const layout = planPagePagination([block(0, 380, { marginTop: 20 }), block(5, 40)], settings)
  assert.equal(layout.placements[0].top, 70)
  assert.equal(layout.placements[1].pageIndex, 1)
  assert.equal(layout.breaks[0].height, 124)
})

test("与下段同页完整链在可满足时整体移到新页", () => {
  const layout = planPagePagination([block(0, 250), block(5, 50, { keepWithNext: true }), block(10, 140)], settings)
  assert.deepEqual(layout.placements.map(item => item.pageIndex), [0, 1, 1])
  assert.equal(layout.breaks[0].pos, 5)
  assert.equal(layout.constraintCount, 0)
})

test("超过标准页的 keepWithNext 链拆为逐块排版并报告未满足约束", () => {
  const layout = planPagePagination([block(0, 220, { keepWithNext: true }), block(5, 220, { keepWithNext: true }), block(10, 40)], settings)
  assert.equal(layout.constraintCount, 1)
  assert.deepEqual(layout.placements.map(item => item.pageIndex), [0, 1, 1])
  assert.equal(layout.overflowCount, 0)
})

test("首项超高块独占展开页，下块恢复标准纸高和完整边距", () => {
  const layout = planPagePagination([block(0, 710, { type: "table", marginBottom: 10 }), block(5, 70)], settings)
  assert.deepEqual(layout.pages, [{ index: 0, top: 0, height: 820, overflow: true }, { index: 1, top: 844, height: 500, overflow: false }])
  assert.equal(layout.overflowCount, 1)
  assert.equal(layout.status, "expanded")
  assert.equal(layout.placements[1].top, 894)
  assert.equal(layout.breaks[0].height, 124)
})

test("普通块之后及连续超高块各自成页，既不切内容也不把下块挤进展开页", () => {
  const layout = planPagePagination([block(0, 100), block(5, 800, { type: "bulletList" }), block(10, 650, { type: "paragraph" }), block(15, 90)], settings)
  assert.deepEqual(layout.pages.map(item => item.height), [500, 900, 750, 500])
  assert.deepEqual(layout.placements.map(item => item.pageIndex), [0, 1, 2, 3])
  assert.equal(layout.overflowCount, 2)
})

test("首尾及连续手动分页符保留空页和用户原边界", () => {
  const layout = planPagePagination([manual(0), manual(1), block(2, 70), manual(7)], settings)
  assert.equal(layout.pageCount, 4)
  assert.deepEqual(layout.breaks.map(item => [item.pos, item.reason]), [[1, "manual"], [2, "manual"], [8, "manual"]])
  assert.deepEqual(layout.pages.map(item => item.top), [0, 524, 1048, 1572])
  assert.equal(layout.placements[2].pageIndex, 2)
})

test("展开页后的手动分页只推进一次，再连续手动分页仍保留空页", () => {
  const layout = planPagePagination([block(0, 700), manual(5), manual(6), block(7, 80)], settings)
  assert.equal(layout.pageCount, 3)
  assert.deepEqual(layout.breaks.map(item => item.reason), ["manual", "manual"])
  assert.equal(layout.placements.at(-1).pageIndex, 2)
})

test("无效块尺寸拒绝，不让负高或非法位置进入装饰", () => {
  for (const input of [null, [block(-1, 20)], [block(0, NaN)], [block(0, 2, { nodeSize: 0 })], [block(0, 2, { marginBottom: -1 })]]) {
    assert.throws(() => planPagePagination(input, settings), /块尺寸/)
  }
})

const DOM = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true })
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = DOM.window.requestAnimationFrame.bind(DOM.window)
globalThis.cancelAnimationFrame = DOM.window.cancelAnimationFrame.bind(DOM.window)
const paragraph = (text = "正文", attrs = {}) => ({ type: "paragraph", attrs, content: [{ type: "text", text }] })
const pause = () => new Promise(resolve => setTimeout(resolve, 85))
const plugin = editor => PAGE_PAGINATION_KEY.getState(editor.state)

function createEditor(content, heights, scale = 1, usedMargins = [], roundGap = value => value) {
  const host = document.body.appendChild(document.createElement("div"))
  const editor = new Editor({
    element: host, extensions: [StarterKit.configure({ trailingNode: false }), ParagraphLayout, PageBreak, PagePagination],
    content: { type: "doc", content }, editorProps: { handleScrollToSelection: () => true }
  })
  editor.view.dom.style.width = "600px"
  const values = new WeakMap()
  const margins = new WeakMap()
  editor.state.doc.forEach((node, pos, index) => {
    const dom = editor.view.nodeDOM(pos)
    values.set(dom, heights[index])
    margins.set(dom, usedMargins[index] || { top: 0, bottom: 0 })
  })
  const childHeight = child => child.hasAttribute("data-mewoc-page-gap") ? roundGap(parseFloat(child.style.height)) : values.get(child) || 0
  const childMargin = child => margins.get(child) || { top: 0, bottom: 0 }
  const childOuterHeight = child => childHeight(child) + childMargin(child).top + childMargin(child).bottom
  const viewHeight = () => [...editor.view.dom.children].reduce((sum, child) => sum + childOuterHeight(child), 0)
  const viewRect = () => ({ x: 0, y: 37, top: 37, left: 0, right: 600 * scale, bottom: 37 + viewHeight() * scale,
    width: 600 * scale, height: viewHeight() * scale })
  editor.view.dom.getBoundingClientRect = viewRect
  const attachRects = () => {
    for (const dom of editor.view.dom.children) dom.getBoundingClientRect = () => {
      let top = 0
      for (const child of editor.view.dom.children) {
        if (child === dom) break
        top += childOuterHeight(child)
      }
      top += childMargin(dom).top
      return { width: 600 * scale, height: childHeight(dom) * scale, top: 37 + top * scale, bottom: 37 + (top + childHeight(dom)) * scale, left: 0, right: 600 * scale }
    }
  }
  attachRects()
  editor.on("transaction", attachRects)
  return { editor, values, margins, attachRects, destroy: () => { editor.destroy(); host.remove() } }
}

test("默认禁用，不改正文、HTML、选区或历史；命令仅设置视图几何", async () => {
  const context = createEditor([paragraph(), paragraph()], [300, 300])
  const { editor } = context
  try {
    const before = JSON.stringify(editor.getJSON())
    const html = editor.getHTML()
    const selection = editor.state.selection.toJSON()
    assert.equal(getPagePagination(editor).status, "disabled")
    assert.equal(editor.view.dom.querySelector("[data-mewoc-page-gap]"), null)
    assert.equal(editor.commands.setPaginationSettings({ enabled: true, ...settings }), true)
    await pause()
    assert.equal(getPagePagination(editor).pageCount, 2)
    assert.equal(JSON.stringify(editor.getJSON()), before)
    assert.equal(editor.getHTML(), html)
    assert.deepEqual(editor.state.selection.toJSON(), selection)
    assert.equal(undoDepth(editor.state), 0)
    assert.equal(editor.view.dom.getAttribute("data-mewoc-pagination"), "true")
  } finally { context.destroy() }
})

test("真实 EditorView 的分页 widget 保持不可编辑、无正文字符，静态序列化不携带", async () => {
  const context = createEditor([paragraph("一"), paragraph("二"), paragraph("三")], [200, 200, 80])
  try {
    const { editor } = context
    editor.commands.setPaginationSettings(settings)
    await pause()
    const widgets = [...editor.view.dom.querySelectorAll("[data-mewoc-page-gap]")]
    assert.equal(widgets.length, 1)
    assert.equal(widgets[0].style.height, "124px")
    assert.equal(widgets[0].contentEditable, "false")
    assert.equal(widgets[0].getAttribute("aria-hidden"), "true")
    assert.equal(widgets[0].textContent, "")
    assert.equal(editor.getText(), "一\n\n二\n\n三")
    assert.doesNotMatch(editor.getHTML(), /page-gap|pagination/)
    assert.equal(getPagePagination(editor).contentHeight, 604)
    assert.equal(plugin(editor).pending, false)
  } finally { context.destroy() }
})

test("缩放除回未缩放块高，纸张边距变更重新分页但不进撤销", async () => {
  const context = createEditor([paragraph(), paragraph()], [210, 210], 0.5)
  try {
    const { editor } = context
    editor.commands.setPaginationSettings(settings)
    await pause()
    assert.equal(getPagePagination(editor).pageCount, 2)
    editor.commands.setPaginationSettings({ pageHeightPx: 600 })
    await pause()
    assert.equal(getPagePagination(editor).pageCount, 1)
    assert.equal(editor.view.dom.querySelector("[data-mewoc-page-gap]"), null)
    assert.equal(undoDepth(editor.state), 0)
    assert.equal(editor.commands.setPaginationSettings({ marginTopPx: 600 }), false)
    assert.equal(plugin(editor).settings.pageHeightPx, 600)
  } finally { context.destroy() }
})

test("组合输入期间冻结已有分页 DOM，结束后只重排最终度量，不改变插入/撤销", async () => {
  const context = createEditor([paragraph("一"), paragraph("二")], [300, 300])
  try {
    const { editor, values } = context
    editor.commands.setPaginationSettings(settings)
    await pause()
    const oldWidget = editor.view.dom.querySelector("[data-mewoc-page-gap]")
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionstart", { bubbles: true }))
    assert.equal(editor.view.composing, true)
    values.set(editor.view.nodeDOM(0), 50)
    editor.commands.insertContent("已确认")
    await pause()
    assert.equal(editor.view.dom.querySelector("[data-mewoc-page-gap]"), oldWidget)
    assert.equal(getPagePagination(editor).pageCount, 2)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionend", { bubbles: true }))
    await pause()
    assert.equal(editor.view.composing, false)
    assert.equal(getPagePagination(editor).pageCount, 1)
    assert.equal(editor.getText().includes("已确认"), true)
    assert.equal(undoDepth(editor.state), 1)
    editor.commands.undo()
    assert.equal(editor.getText().includes("已确认"), false)
  } finally { context.destroy() }
})

test("只读仍显示同一分页，关闭清理装饰并发送 disabled 事件", async () => {
  const context = createEditor([paragraph(), paragraph()], [300, 300])
  try {
    const { editor } = context
    const events = []
    editor.on("paginationUpdate", layout => events.push(layout))
    editor.commands.setPaginationSettings(settings)
    await pause()
    editor.setEditable(false)
    assert.equal(getPagePagination(editor).pageCount, 2)
    assert.equal(editor.view.dom.querySelectorAll("[data-mewoc-page-gap]").length, 1)
    editor.commands.setPaginationSettings({ enabled: false })
    assert.equal(getPagePagination(editor).status, "disabled")
    assert.equal(editor.view.dom.querySelector("[data-mewoc-page-gap]"), null)
    assert.equal(editor.view.dom.hasAttribute("data-mewoc-pagination"), false)
    assert.equal(events.at(-1).status, "disabled")
    assert.equal(undoDepth(editor.state), 0)
  } finally { context.destroy() }
})

test("资源加载高度重排保留正文与节点 DOM，卸载取消待执行测量", async () => {
  const context = createEditor([paragraph(), paragraph()], [150, 150])
  const { editor, values } = context
  const before = editor.getJSON()
  editor.commands.setPaginationSettings(settings)
  await pause()
  const dom = editor.view.nodeDOM(0)
  values.set(dom, 300)
  dom.dispatchEvent(new DOM.window.Event("load"))
  await pause()
  assert.equal(getPagePagination(editor).pageCount, 2)
  assert.equal(editor.view.nodeDOM(0), dom)
  assert.deepEqual(editor.getJSON(), before)
  values.set(dom, 800)
  dom.dispatchEvent(new DOM.window.Event("load"))
  context.destroy()
  await pause()
  assert.equal(getPagePagination(editor).status, "disabled")
})

test("标题默认同下段，而显式 keepWithNext=false 优先，不产生内容事务", async () => {
  const content = [paragraph(), { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] }, paragraph()]
  const context = createEditor(content, [250, 50, 140])
  try {
    const { editor } = context
    editor.commands.setPaginationSettings(settings)
    await pause()
    assert.deepEqual(getPagePagination(editor).placements.map(item => item.pageIndex), [0, 1, 1])
    const secondPos = editor.state.doc.child(0).nodeSize
    editor.view.dispatch(editor.state.tr.setNodeMarkup(secondPos, undefined, { ...editor.state.doc.child(1).attrs, keepWithNext: false }))
    context.values.set(editor.view.nodeDOM(secondPos), 50)
    context.attachRects()
    await pause()
    assert.deepEqual(getPagePagination(editor).placements.map(item => item.pageIndex), [0, 0, 1])
    assert.equal(undoDepth(editor.state), 1)
  } finally { context.destroy() }
})

test("400 段的小数声明与真实 used-margin 不同，缩放和空隙舍入也不会累计越界", async () => {
  const count = 400
  const context = createEditor(Array.from({ length: count }, (_, index) => paragraph(`段${index}`, { spaceBefore: 0.5, spaceAfter: 0.5 })),
    Array(count).fill(31.5), 0.75, Array.from({ length: count }, () => ({ top: 0.61, bottom: 0.62 })),
    value => Math.floor(value * 11) / 11)
  const nativeStyle = DOM.window.getComputedStyle
  DOM.window.getComputedStyle = dom => {
    const style = nativeStyle(dom)
    // JSDOM 不解析绝对 CSS 单位；夹具明确给出浏览器解析后的声明值和不同的实际 used-size。
    return new Proxy(style, { get(target, key) {
      if (["marginTop", "marginBottom"].includes(key) && target[key] === "0.5pt") return "0.666667px"
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    } })
  }
  try {
    const { editor } = context
    let events = 0
    editor.on("paginationUpdate", () => { events += 1 })
    editor.commands.setPaginationSettings(settings)
    let previous = ""
    let stable = 0
    for (let index = 0; index < 30 && stable < 3; index += 1) {
      await pause()
      const signature = JSON.stringify(getPagePagination(editor))
      stable = signature === previous ? stable + 1 : 0
      previous = signature
    }
    assert.equal(stable, 3, "小数排版反复测量未收敛")
    const layout = getPagePagination(editor)
    assert.equal(layout.pageCount > 30, true, `页数${layout.pageCount}，首段${JSON.stringify(layout.placements[0])}，尾段${JSON.stringify(layout.placements.at(-1))}`)
    const rootTop = editor.view.dom.getBoundingClientRect().top
    layout.placements.forEach(placement => {
      const rect = editor.view.nodeDOM(placement.pos).getBoundingClientRect()
      const top = (rect.top - rootTop) / 0.75 + settings.marginTopPx
      const bottom = (rect.bottom - rootTop) / 0.75 + settings.marginTopPx
      const page = layout.pages[placement.pageIndex]
      assert.ok(top >= page.top + settings.marginTopPx - 0.15, `段${placement.pos} 越过页顶`)
      assert.ok(bottom <= page.top + page.height - settings.marginBottomPx + 0.15, `段${placement.pos} 越过页底`)
      assert.ok(Math.abs(top - placement.top) < 0.15, "planner 与真实 DOM 坐标不一致")
    })
    const emitted = events
    await pause()
    assert.equal(events, emitted, "稳定后仍不断创建分页事务")
    assert.equal(undoDepth(editor.state), 0)
  } finally { DOM.window.getComputedStyle = nativeStyle; context.destroy() }
})
