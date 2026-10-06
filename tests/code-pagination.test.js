/**
 * 真实 ProseMirror / 高亮 DOM 保留原位置，受控 Range 补上 JSDOM 不具备的字体排版。
 * 测试定位映射与安全回退；实际 PRE 换行、block widget 增高及缩放由原生浏览器专项验证。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor, Extension } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { Plugin } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { DocumentCodeBlock } from "../src/pages/editor/extensions/code-block.js"
import { CodeHighlightKey } from "../src/pages/editor/extensions/code-highlight.js"
import { highlightCode } from "../src/pages/editor/tools/code-highlight.js"
import { measureCodeBlockLines } from "../src/pages/editor/tools/code-pagination.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true })
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = DOM.window.requestAnimationFrame.bind(DOM.window)
globalThis.cancelAnimationFrame = DOM.window.cancelAnimationFrame.bind(DOM.window)
const originalCreateRange = document.createRange.bind(document)
const rect = (top, height, width = 600) => ({ left: 0, right: width, top, bottom: top + height, width, height })

function context(text, { scale = 1, gaps = [], beforeHeight = 0, prefix = false, nested = false, lineHeight = 24,
  invalidLine = -1, language = "plaintext" } = {}) {
  const outerPos = prefix ? 6 : 0
  const pos = outerPos + (nested ? 1 : 0)
  const gapFixtures = Extension.create({
    name: "codePaginationFixtures",
    addProseMirrorPlugins() {
      return [new Plugin({ props: { decorations: state => DecorationSet.create(state.doc, [
        ...(beforeHeight ? [Decoration.widget(outerPos, () => {
          const div = document.createElement("div"); div.dataset.codePreviousGap = ""; return div
        }, { side: -1, key: "code-previous-gap" })] : []),
        ...gaps.map((gap, index) => Decoration.widget(pos + 1 + gap.offset, () => {
          const span = document.createElement("span"); span.dataset.mewocPageGap = ""; span.style.display = "block"; span.style.height = `${gap.height}px`; return span
        }, { side: -1, key: `code-gap-${index}`, marks: [] }))
      ]) } })]
    }
  })
  const host = document.body.appendChild(document.createElement("div"))
  const block = { type: "codeBlock", attrs: { language }, ...(text ? { content: [{ type: "text", text }] } : {}) }
  const editor = new Editor({ element: host,
    extensions: [StarterKit.configure({ codeBlock: false, trailingNode: false }), DocumentCodeBlock, gapFixtures],
    content: { type: "doc", content: [...(prefix ? [{ type: "paragraph", content: [{ type: "text", text: "前置正文" }] }] : []),
      nested ? { type: "blockquote", content: [block] } : block] },
    editorProps: { handleScrollToSelection: () => true }
  })
  const node = editor.state.doc.nodeAt(pos)
  let pre
  let code
  let widgets
  const positions = new Map()
  const pattern = /\r\n|\r|\n/g
  let start = 0
  let line = 0
  let match
  while ((match = pattern.exec(text))) {
    const end = match.index + match[0].length
    for (let index = start; index < end; index += 1) positions.set(pos + 1 + index, line)
    start = end; line += 1
  }
  for (let index = start; index < text.length; index += 1) positions.set(pos + 1 + index, line)
  const lineCount = line + 1
  const top = 10
  const innerTop = top + 18
  const rootTop = 100
  const internalHeight = gaps.reduce((sum, gap) => sum + gap.height, 0)
  const preceding = position => beforeHeight + gaps.filter(gap => pos + 1 + gap.offset <= position).reduce((sum, gap) => sum + gap.height, 0)
  editor.view.dom.getBoundingClientRect = () => rect(rootTop, (top + 33 + lineCount * lineHeight + beforeHeight + internalHeight) * scale, 600 * scale)
  const refresh = () => {
    pre = editor.view.nodeDOM(pos)
    code = pre.querySelector("code")
    pre.style.cssText = "display:block;direction:ltr;line-height:24px;padding:16px 16px 12px;border-top:2px solid black;border-bottom:3px solid black"
    code.style.cssText = "display:inline;white-space:pre;direction:ltr"
    pre.getBoundingClientRect = () => rect(rootTop + (top + beforeHeight) * scale, (33 + lineCount * lineHeight + internalHeight) * scale, 600 * scale)
    widgets = [...editor.view.dom.querySelectorAll("[data-code-previous-gap],[data-mewoc-page-gap]")].map(element => ({ dom: element,
      height: element.hasAttribute("data-code-previous-gap") ? beforeHeight : gaps[[...code.querySelectorAll("[data-mewoc-page-gap]")].indexOf(element)].height }))
  }
  refresh()
  const glyph = position => {
    const index = positions.get(position) ?? lineCount - 1
    return rect(rootTop + (innerTop + index * lineHeight + 5 + preceding(position)) * scale, 14 * scale, 8 * scale)
  }
  editor.view.coordsAtPos = position => glyph(position)
  let calls = 0
  document.createRange = () => {
    const range = originalCreateRange()
    range.getClientRects = () => {
      calls += 1
      if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== 3) return []
      const element = range.startContainer
      const modelPos = editor.view.posAtDOM(element, 0)
      const boxes = new Map()
      for (let offset = range.startOffset; offset < range.endOffset; offset += 1) {
        const box = glyph(modelPos + offset)
        boxes.set(box.top, box)
        if (positions.get(modelPos + offset) === invalidLine) boxes.set("soft-wrap", rect(box.top + lineHeight * scale, box.height))
      }
      return [...boxes.values()]
    }
    return range
  }
  return { editor, node, get pre() { return pre }, get code() { return code }, pos, get widgets() { return widgets }, refresh, calls: () => calls,
    measure: (extra = {}) => measureCodeBlockLines(editor.view, node, pos, { scale, widgets, ...extra }),
    destroy: () => { document.createRange = originalCreateRange; editor.destroy(); host.remove() } }
}

test("PRE 内容区按原物理行测量，外壳 padding/border 与末尾空行不变", () => {
  const fixture = context("a\nb\n", { prefix: true })
  try {
    assert.deepEqual(fixture.measure(), [
      { pos: 7, start: 28, height: 24, firstLine: 0, lastLine: 0, lineCount: 3 },
      { pos: 9, start: 52, height: 48, firstLine: 1, lastLine: 2, lineCount: 3 }
    ])
    assert.equal(fixture.measure().some(line => line.pos === fixture.pos + fixture.node.nodeSize - 1), false)
  } finally { fixture.destroy() }
})

test("CRLF、CR、连续空行、空格/制表符和 Unicode 保留原 UTF-16 位置", () => {
  const fixture = context("😀\r\n\r\n \t\r尾")
  try {
    assert.deepEqual(fixture.measure(), [
      { pos: 1, start: 28, height: 24, firstLine: 0, lastLine: 0, lineCount: 4 },
      { pos: 5, start: 52, height: 24, firstLine: 1, lastLine: 1, lineCount: 4 },
      { pos: 7, start: 76, height: 24, firstLine: 2, lastLine: 2, lineCount: 4 },
      { pos: 10, start: 100, height: 24, firstLine: 3, lastLine: 3, lineCount: 4 }
    ])
    assert.equal(fixture.node.textContent, "😀\r\n\r\n \t\r尾")
  } finally { fixture.destroy() }
})

test("原始高亮 SPAN 与嵌套代码仍映射到唯一源码，不改 JSON/HTML/选区/历史", async () => {
  const fixture = context("const value = 1;\nconsole.log(value);", { nested: true, language: "javascript" })
  try {
    // 直接发布真实着色 token，避免把插件的 150ms 防抖/模块载入时间当成测量正确性的条件。
    const tokens = await highlightCode(fixture.node.textContent, "javascript")
    let offset = fixture.pos + 1
    const decorations = []
    for (const token of tokens) {
      if (token.text.length && token.classes.length) decorations.push(Decoration.inline(offset, offset + token.text.length, { class: token.classes.join(" ") }))
      offset += token.text.length
    }
    fixture.editor.view.dispatch(fixture.editor.state.tr.setMeta(CodeHighlightKey, {
      doc: fixture.editor.state.doc, decorations: DecorationSet.create(fixture.editor.state.doc, decorations), messages: {}
    }).setMeta("addToHistory", false))
    fixture.refresh()
    const before = fixture.editor.getJSON()
    const html = fixture.editor.getHTML()
    const selection = fixture.editor.state.selection
    const spans = [...fixture.code.querySelectorAll("span")]
    assert.ok(spans.length > 0, fixture.editor.view.dom.innerHTML)
    assert.deepEqual(fixture.measure().map(line => line.pos), [2, 19])
    assert.deepEqual(fixture.editor.getJSON(), before)
    assert.equal(fixture.editor.getHTML(), html)
    assert.equal(fixture.editor.state.selection, selection)
    assert.equal(fixture.editor.can().undo(), false)
    assert.equal(fixture.editor.view.nodeDOM(fixture.pos), fixture.pre)
    assert.deepEqual([...fixture.code.querySelectorAll("span")], spans)
  } finally { fixture.destroy() }
})

test("0.5/1/1.5 缩放与前置/内部旧 block widget 还原相同自然行盒", () => {
  for (const scale of [0.5, 1, 1.5]) {
    const fixture = context("a\nb\nc", { scale, beforeHeight: 155, gaps: [{ offset: 2, height: 175 }, { offset: 4, height: 210 }] })
    try {
      assert.equal(fixture.widgets.length, 3)
      assert.deepEqual(fixture.measure(), [
        { pos: 1, start: 28, height: 24, firstLine: 0, lastLine: 0, lineCount: 3 },
        { pos: 3, start: 52, height: 24, firstLine: 1, lastLine: 1, lineCount: 3 },
        { pos: 5, start: 76, height: 24, firstLine: 2, lastLine: 2, lineCount: 3 }
      ])
    } finally { fixture.destroy() }
  }
})

test("空代码与仅换行的代码保留完整行高且不引入末尾 widget 位置", () => {
  for (const source of ["", "\n", "\n\n"]) {
    const fixture = context(source)
    try {
      const measured = fixture.measure()
      assert.ok(measured)
      assert.equal(measured.reduce((sum, group) => sum + group.height, 0), (source.length + 1) * 24)
      assert.equal(fixture.editor.getJSON().content[0].content?.[0]?.text || "", source)
    } finally { fixture.destroy() }
  }
})

test("未知样式、RTL、软换行、隐藏/裁切与不可靠参数均安全保留整块", () => {
  const cases = [
    fixture => { fixture.code.style.whiteSpace = "pre-wrap" },
    fixture => { fixture.pre.style.direction = "rtl" },
    fixture => { fixture.code.style.writingMode = "vertical-rl" },
    fixture => { fixture.pre.style.columnCount = "2" },
    fixture => { fixture.code.style.visibility = "hidden" },
    fixture => { fixture.code.style.transform = "scale(2)" },
    fixture => { Object.defineProperties(fixture.pre, { clientHeight: { value: 40 }, scrollHeight: { value: 90 } }) },
    fixture => { fixture.code.appendChild(document.createElement("button")) }
  ]
  for (const configure of cases) {
    const fixture = context("a\nb")
    try { configure(fixture); assert.equal(fixture.measure(), null) } finally { fixture.destroy() }
  }
  for (const source of ["مرحبا\nx", "x\u202ey\nz"]) {
    const fixture = context(source)
    try { assert.equal(fixture.measure(), null) } finally { fixture.destroy() }
  }
  const wrapped = context("ab\ncd", { invalidLine: 0 })
  try {
    assert.equal(wrapped.measure(), null)
    assert.equal(wrapped.measure({ scale: 0 }), null)
    assert.equal(wrapped.measure({ widgets: [{ dom: wrapped.code, height: -1 }] }), null)
    assert.equal(measureCodeBlockLines(wrapped.editor.view, wrapped.node, -1), null)
  } finally { wrapped.destroy() }
})

test("长源码每个逻辑组只读取所需高亮片段，查询量不随 code unit 逐字增长", () => {
  const source = Array.from({ length: 250 }, () => "x".repeat(80)).join("\n")
  const fixture = context(source)
  try {
    const measured = fixture.measure()
    assert.equal(measured.length, 250)
    assert.equal(measured.at(-1).pos, 1 + 249 * 81)
    assert.ok(fixture.calls() <= 250)
    assert.equal(fixture.node.textContent, source)
  } finally { fixture.destroy() }
})
