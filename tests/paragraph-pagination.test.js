/**
 * 使用真实 ProseMirror 模型/DOM 位置与受控 Range 矩形验证段内测量的映射、自然坐标与安全回退。
 * JSDOM 不排版字体；这里只验证测量契约，实际换行/行高/缩放由浏览器专项覆盖。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor, Extension, Node as TiptapNode } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { Plugin } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { ParagraphLayout } from "../src/pages/editor/extensions/paragraph-layout.js"
import { measureParagraphLines, paragraphGraphemeBoundaries } from "../src/pages/editor/tools/paragraph-pagination.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true })
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = DOM.window.requestAnimationFrame.bind(DOM.window)
globalThis.cancelAnimationFrame = DOM.window.cancelAnimationFrame.bind(DOM.window)
const originalCreateRange = document.createRange.bind(document)
const txt = (text, marks = []) => ({ type: "text", text, ...(marks.length ? { marks } : {}) })
const br = { type: "hardBreak" }
const rect = (top, height, width = 300) => ({ left: 0, right: width, top, bottom: top + height, width, height })

function createContext(parts, options = {}) {
  const { scale = 1, wrapAt = 4, lineHeight = 28, top = 10, gaps = [], collapseSpaces = false, attrs = {}, heading = false,
    prefix = false, formatting = false, glyphHeight = () => 14 } = options
  const prefixContent = prefix ? [{ type: "paragraph", content: [txt("前置正文")] }] : []
  const paragraphPos = prefix ? 6 : 0
  const decorations = Extension.create({
    name: "paragraphMeasurementFixtures",
    addProseMirrorPlugins() {
      return [new Plugin({ props: { decorations: state => DecorationSet.create(state.doc, [
        ...gaps.map((gap, index) => Decoration.widget(paragraphPos + 1 + gap.offset, () => {
          const span = document.createElement("span"); span.dataset.mewocPageGap = ""; span.style.height = `${gap.height}px`; return span
        }, { key: `measurement-gap-${index}`, side: -1 })),
        ...(formatting ? [Decoration.inline(paragraphPos + 1, paragraphPos + 1 + parts.reduce((sum, part) => sum + (part.text?.length || 1), 0), { "data-mewoc-format-mark": "space" })] : [])
      ]) } })]
    }
  })
  const inlineAtom = TiptapNode.create({ name: "measurementAtom", group: "inline", inline: true, atom: true,
    renderHTML: () => ["span", { "data-measurement-atom": "" }, "内联原子"] })
  const host = document.body.appendChild(document.createElement("div"))
  const editor = new Editor({
    element: host, extensions: [StarterKit.configure({ trailingNode: false }), ParagraphLayout, inlineAtom, decorations],
    content: { type: "doc", content: [...prefixContent, { type: heading ? "heading" : "paragraph", attrs: heading ? { level: 2, ...attrs } : attrs, content: parts }] },
    editorProps: { handleScrollToSelection: () => true }
  })
  const node = editor.state.doc.nodeAt(paragraphPos)
  const dom = editor.view.nodeDOM(paragraphPos)
  dom.style.width = "600px"
  dom.style.lineHeight = `${lineHeight}px`
  dom.style.direction = "ltr"
  const text = node.textBetween(0, node.content.size, "", "\n")
  const positions = new Map()
  let line = 0
  let column = 0
  for (const item of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (item.segment !== "\n" && !(collapseSpaces && /^\s+$/.test(item.segment)) && column >= wrapAt) { line += 1; column = 0 }
    for (let index = item.index; index < item.index + item.segment.length; index += 1) positions.set(paragraphPos + 1 + index, line)
    if (item.segment === "\n") { line += 1; column = 0 }
    else if (!(collapseSpaces && /^\s+$/.test(item.segment))) column += 1
  }
  const lineCount = line + 1
  const rootTop = 100
  const gapBefore = modelPos => gaps.filter(gap => paragraphPos + 1 + gap.offset <= modelPos).reduce((sum, gap) => sum + gap.height, 0)
  editor.view.dom.getBoundingClientRect = () => rect(rootTop, (top + lineCount * lineHeight + gaps.reduce((sum, gap) => sum + gap.height, 0)) * scale, 600 * scale)
  dom.getBoundingClientRect = () => rect(rootTop + top * scale, (lineCount * lineHeight + gaps.reduce((sum, gap) => sum + gap.height, 0)) * scale, 600 * scale)
  const widgets = [...dom.querySelectorAll("[data-mewoc-page-gap]")].map((element, index) => ({ dom: element, height: gaps[index].height }))
  const glyphRect = modelPos => {
    const lineIndex = positions.get(modelPos) ?? lineCount - 1
    const height = glyphHeight(modelPos)
    return rect(rootTop + (top + lineIndex * lineHeight + (lineHeight - height) / 2 + gapBefore(modelPos)) * scale, height * scale, 8 * scale)
  }
  node.forEach((child, offset) => {
    if (child.type.name === "hardBreak") editor.view.nodeDOM(paragraphPos + 1 + offset).getBoundingClientRect = () => glyphRect(paragraphPos + 1 + offset)
  })
  const trailing = dom.querySelector("br.ProseMirror-trailingBreak")
  if (trailing) trailing.getBoundingClientRect = () => glyphRect(paragraphPos + node.nodeSize - 1)
  editor.view.coordsAtPos = position => glyphRect(position)
  let calls = 0
  // 原生 Range 保留合法 DOM 边界操作，只替换 JSDOM 缺失的矩形输出；位置始终使用真实 view.posAtDOM。
  document.createRange = () => {
    const range = originalCreateRange()
    range.getClientRects = () => {
      calls += 1
      if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== 3) return []
      const source = range.startContainer
      const modelPos = editor.view.posAtDOM(source, 0)
      const groups = new Map()
      for (let offset = range.startOffset; offset < range.endOffset; offset += 1) {
        if (collapseSpaces && /\s/.test(source.nodeValue[offset])) continue
        const box = glyphRect(modelPos + offset)
        const key = `${box.top}:${box.bottom}`
        groups.set(key, box)
      }
      return [...groups.values()]
    }
    return range
  }
  const measure = (extra = {}) => measureParagraphLines(editor.view, node, paragraphPos, { scale, widgets, ...extra })
  return { editor, node, dom, widgets, paragraphPos, measure, lineCount, calls: () => calls,
    destroy: () => { document.createRange = originalCreateRange; editor.destroy(); host.remove() } }
}

test("完整 grapheme 边界保留代理对、组合音符、旗帜和 ZWJ 表情", () => {
  const parts = ["A", "😀", "e\u0301", "🇨🇳", "👨‍👩‍👧‍👦", "B"]
  const expected = [0]
  parts.forEach(part => expected.push(expected.at(-1) + part.length))
  assert.deepEqual(paragraphGraphemeBoundaries(parts.join("")), expected)
  assert.deepEqual(paragraphGraphemeBoundaries(""), [0])
  assert.equal(paragraphGraphemeBoundaries(null), null)
})

test("Range glyph 高度转换为完整 CSS 行盒，段顶、尾部 leading 和绝对模型位置保持正确", () => {
  const context = createContext([txt("abcdefghijkl")], { prefix: true })
  try {
    assert.deepEqual(context.measure(), [
      { pos: 7, start: 10, height: 28 }, { pos: 11, start: 38, height: 28 }, { pos: 15, start: 66, height: 28 }
    ])
    assert.equal(context.node.content.size, 12)
  } finally { context.destroy() }
})

test("粗体、斜体、链接与不同 glyph 高的 mark 片段合并成同一视觉行", () => {
  const context = createContext([txt("ab"), txt("cd", [{ type: "bold" }]), txt("ef", [{ type: "italic" }]),
    txt("gh", [{ type: "link", attrs: { href: "https://example.invalid" } }])], { glyphHeight: pos => pos > 2 && pos < 5 ? 18 : 14 })
  try {
    const result = context.measure()
    assert.deepEqual(result.map(line => line.pos), [1, 5])
    assert.equal(result.length, 2)
    assert.equal(result[0].start, 10)
    assert.equal(result.reduce((sum, line) => sum + line.height, 0), 56)
  } finally { context.destroy() }
})

test("保留格式标记包裹的真实空格文字，独立 widget 不进入 Range 文本片段", () => {
  const context = createContext([txt("ab  cd  ")], { formatting: true })
  try {
    assert.ok(context.dom.querySelector("[data-mewoc-format-mark]"))
    assert.deepEqual(context.measure().map(line => line.pos), [1, 5])
  } finally { context.destroy() }
})

test("折叠空格没有自身 Range 矩形时按前缀证据定位可见行，不添加或删除原空格", () => {
  const context = createContext([txt("ab  cd")], { wrapAt: 2, collapseSpaces: true })
  try {
    const before = context.editor.getJSON()
    assert.deepEqual(context.measure().map(line => line.pos), [1, 5])
    assert.deepEqual(context.editor.getJSON(), before)
    assert.equal(context.editor.getText(), "ab  cd")
  } finally { context.destroy() }
})

test("预格式空格、NBSP 和制表符使用原模型 UTF-16 位置，不按 trim 后字符串测量", () => {
  const context = createContext([txt("a \u00a0\tbcd ")])
  try {
    context.dom.style.whiteSpace = "pre-wrap"
    assert.deepEqual(context.measure().map(line => line.pos), [1, 5])
    assert.equal(context.editor.getText(), "a \u00a0\tbcd ")
  } finally { context.destroy() }
})

test("连续硬换行保留中间空行，尾部空行并入前组避免在 contentEnd 插装饰", () => {
  const context = createContext([txt("a"), br, br, txt("b"), br], { wrapAt: 100 })
  try {
    assert.deepEqual(context.measure(), [
      { pos: 1, start: 10, height: 28 }, { pos: 3, start: 38, height: 28 }, { pos: 4, start: 66, height: 56 }
    ])
    assert.equal(context.measure().some(line => line.pos === context.paragraphPos + context.node.nodeSize - 1), false)
    assert.equal(context.editor.getJSON().content[0].content.filter(node => node.type === "hardBreak").length, 3)
  } finally { context.destroy() }
})

test("空段落与仅硬换行段落仍保留原始高度，不把 PM trailingBreak 当成正文", () => {
  for (const parts of [[], [br]]) {
    const context = createContext(parts)
    try {
      assert.deepEqual(context.measure(), [{ pos: 1, start: 10, height: parts.length ? 56 : 28 }])
      assert.equal(context.editor.getJSON().content[0].content?.length || 0, parts.length)
    } finally { context.destroy() }
  }
})

test("0.5/1/1.5 缩放和旧内部 widget 高度都从每个原始文本片段扣除", () => {
  for (const scale of [0.5, 1, 1.5]) {
    const context = createContext([txt("abcdefghijkl")], { scale, gaps: [{ offset: 4, height: 175 }, { offset: 8, height: 210 }] })
    try {
      const before = context.editor.getJSON()
      assert.equal(context.widgets.length, 2)
      assert.deepEqual(context.measure(), [
        { pos: 1, start: 10, height: 28 }, { pos: 5, start: 38, height: 28 }, { pos: 9, start: 66, height: 28 }
      ])
      assert.deepEqual(context.editor.getJSON(), before)
    } finally { context.destroy() }
  }
})

test("跨 mark 的组合字符和长 ZWJ 表情保持完整 grapheme 位置", () => {
  const context = createContext([txt("A"), txt("e", [{ type: "bold" }]), txt("\u0301", [{ type: "italic" }]), txt("👨‍👩‍👧‍👦BC")], { wrapAt: 2 })
  try {
    const positions = context.measure().map(line => line.pos)
    const boundaries = paragraphGraphemeBoundaries(context.node.textContent).map(offset => offset + 1)
    assert.ok(positions.every(pos => boundaries.includes(pos)))
    assert.deepEqual(positions, [1, 4, 16])
  } finally { context.destroy() }
})

test("长文本按每行二分定位，不逐个 code unit 查询 Range", () => {
  const context = createContext([txt("a".repeat(10000))], { wrapAt: 40 })
  try {
    const result = context.measure()
    assert.equal(result.length, 250)
    assert.equal(result.at(-1).pos, 9961)
    assert.ok(context.calls() <= 1 + result.length * (Math.ceil(Math.log2(10000)) + 2), "Range 查询应随视觉行数和对数查找增长")
    assert.ok(context.calls() < 5000)
  } finally { context.destroy() }
})

test("keepTogether、内联原子、RTL、多列及非顶层布局安全回退整段", () => {
  for (const fixture of [
    { parts: [txt("abcdefgh")], options: { attrs: { keepTogether: true } } },
    { parts: [txt("a"), { type: "measurementAtom" }, txt("b")], options: {} },
    { parts: [txt("مرحبا")], options: {} },
    { parts: [txt("abcd")], options: {}, style: { direction: "rtl" } },
    { parts: [txt("abcd")], options: {}, style: { columnCount: "2" } },
    { parts: [txt("abcd")], options: {}, style: { display: "flex" } },
    { parts: [txt("a\nb")], options: {} }
  ]) {
    const context = createContext(fixture.parts, fixture.options)
    try {
      Object.assign(context.dom.style, fixture.style || {})
      assert.equal(context.measure(), null)
    } finally { context.destroy() }
  }
  const context = createContext([txt("abcdefgh")])
  try {
    const wrapper = document.createElement("div")
    context.dom.replaceWith(wrapper); wrapper.appendChild(context.dom)
    assert.equal(context.measure(), null)
  } finally { context.destroy() }
})

test("标题使用相同只读测量，显式 keepTogether=false 允许按行分析", () => {
  const context = createContext([txt("abcdefgh")], { heading: true, attrs: { keepTogether: false } })
  try {
    const before = { json: context.editor.getJSON(), html: context.editor.getHTML(), selection: context.editor.state.selection.toJSON() }
    assert.equal(context.dom.tagName, "H2")
    assert.equal(context.measure().length, 2)
    assert.deepEqual(context.editor.getJSON(), before.json)
    assert.equal(context.editor.getHTML(), before.html)
    assert.deepEqual(context.editor.state.selection.toJSON(), before.selection)
  } finally { context.destroy() }
})

test("无效缩放、隐藏零尺寸、缺少 Range 几何和失配模型 DOM 均返回 null", () => {
  const context = createContext([txt("abcdefgh")])
  try {
    for (const scale of [0, -1, NaN, Infinity]) assert.equal(context.measure({ scale }), null)
    assert.equal(context.measure({ widgets: [{ dom: context.dom, height: -1 }] }), null)
    const nativeRange = document.createRange
    document.createRange = originalCreateRange
    assert.equal(context.measure(), null)
    document.createRange = nativeRange
    context.editor.view.dom.getBoundingClientRect = () => rect(100, 56, 0)
    assert.equal(context.measure(), null)
    context.editor.view.dom.getBoundingClientRect = () => rect(100, 56)
    context.editor.view.domObserver.stop()
    context.dom.firstChild.nodeValue = "错配"
    assert.equal(context.measure(), null)
  } finally { context.destroy() }
})
