/** 段落精细设置跨链路集成回归：schema、粘贴、格式刷、Mewoc、Word 与 Markdown 共用属性含义。 */
import assert from "node:assert/strict"
import test from "node:test"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"

// DOMParser 与真实 schema 用于 HTML/XML 适配，布局值按属性检查而非屏幕外观推测。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
// 段落、标题与文档 fixture 只改变指定属性，减少非相关内容对默认值断言的干扰。
const paragraph = (text, attrs = {}) => ({ type: "paragraph", attrs, content: [{ type: "text", text }] })
const heading = (text, attrs = {}) => ({ ...paragraph(text, { level: 2, ...attrs }), type: "heading" })
const makeDocument = content => ({ ...createDocument(), content: { type: "doc", content } })
// 挂载真实扩展并跳过 JSDOM 不提供的滚动布局，保留解析和事务行为。
const makeEditor = content => new Editor({
  element: document.body.appendChild(document.createElement("div")), extensions: createExtensions(),
  editorProps: { handleScrollToSelection: () => true }, content
})
// 统一截取四个精细设置字段；测试值特意组合半磅、零、false 和 true。
const layoutKeys = ["spaceBefore", "spaceAfter", "keepWithNext", "keepTogether"]
const layoutOf = node => Object.fromEntries(layoutKeys.map(key => [key, node.attrs[key]]))
const settings = { spaceBefore: 12.5, spaceAfter: 0, keepWithNext: false, keepTogether: true }

// 从真实 DOCX 包提取段落 XML，同时确认导出没有修改来源对象。
async function getWordParagraphs(content) {
  const source = makeDocument(content)
  const before = JSON.stringify(source)
  const result = await createDocumentDocx(source, new Map())
  assert.equal(JSON.stringify(source), before)
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml").async("string")
  const parsed = new DOMParser().parseFromString(xml, "application/xml")
  assert.equal(parsed.querySelector("parsererror"), null)
  return { paragraphs: [...parsed.getElementsByTagName("w:p")], warnings: result.warnings }
}

test("段落文件契约接受默认、零、半磅与布尔值，拒绝越界、CSS 和伪布尔", () => {
  for (const attrs of [settings, { spaceBefore: 120, spaceAfter: 0.5 }, { spaceBefore: null, keepTogether: null }]) {
    assert.doesNotThrow(() => validateDocument(makeDocument([paragraph("合法", attrs)])))
  }
  for (const attrs of [{ spaceBefore: -0.5 }, { spaceAfter: 120.5 }, { spaceAfter: 1.25 }, { spaceBefore: "12pt" },
    { spaceBefore: Infinity }, { keepTogether: "false" }, { keepWithNext: 1 }, { spaceBefore: {} }]) {
    assert.throws(() => validateDocument(makeDocument([paragraph("非法", attrs)])))
  }
})

test("段落内部 HTML 往返保留全部新属性与既有行距缩进，默认仍为空", () => {
  const source = makeEditor({ type: "doc", content: [heading("标题", { ...settings, lineHeight: 2, firstLineIndent: 2, leftIndent: 3 }), paragraph("默认"), paragraph("显式关闭", { spaceBefore: 0, spaceAfter: 120, keepWithNext: true, keepTogether: false })] })
  let pasted
  try {
    const html = source.getHTML()
    pasted = makeEditor(cleanPastedHtml(html))
    assert.deepEqual(pasted.getJSON(), source.getJSON())
    const element = pasted.view.dom.querySelector("h2")
    assert.equal(element.style.marginTop, "12.5pt")
    assert.equal(element.style.marginBottom, "0pt")
    assert.equal(element.style.breakAfter, "auto")
    assert.equal(element.style.breakInside, "avoid")
    assert.deepEqual(layoutOf(pasted.state.doc.child(1)), Object.fromEntries(layoutKeys.map(key => [key, null])))
  } finally { source.destroy(); pasted?.destroy() }
})

test("粘贴非法段距与分页 CSS 不进入正文，旧分页写法按允许值解析", () => {
  const editor = makeEditor(cleanPastedHtml('<p style="margin-top:-12pt;margin-bottom:121pt;break-after:page;break-inside:avoid-column;position:fixed" onclick="bad()">正文</p><h2 style="margin-top:0pt;margin-bottom:6.5pt;page-break-after:avoid;page-break-inside:auto">兼容写法</h2>'))
  try {
    assert.deepEqual(layoutOf(editor.state.doc.child(0)), Object.fromEntries(layoutKeys.map(key => [key, null])))
    assert.deepEqual(layoutOf(editor.state.doc.child(1)), { spaceBefore: 0, spaceAfter: 6.5, keepWithNext: true, keepTogether: false })
    assert.equal(editor.view.dom.querySelector("[onclick]"), null)
    assert.equal(editor.view.dom.querySelector("p").style.position, "")
    validateDocument({ ...createDocument(), content: editor.getJSON() })
  } finally { editor.destroy() }
})

test("格式刷复制段落精细设置且保留目标类型，一次撤销；来源默认恢复目标默认", () => {
  const editor = makeEditor({ type: "doc", content: [paragraph("来源", settings), heading("目标"), paragraph("默认")] })
  try {
    editor.commands.setTextSelection(1)
    assert.equal(editor.commands.copyFormat(), true)
    editor.commands.setTextSelection({ from: 5, to: 7 })
    const before = editor.getJSON()
    editor.commands.applyFormat()
    assert.deepEqual(layoutOf(editor.state.doc.child(1)), settings)
    assert.equal(editor.state.doc.child(1).type.name, "heading")
    assert.equal(editor.getText(), "来源\n\n目标\n\n默认")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.redo()
    editor.commands.setTextSelection(9)
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 5, to: 7 })
    editor.commands.applyFormat()
    assert.deepEqual(layoutOf(editor.state.doc.child(1)), Object.fromEntries(layoutKeys.map(key => [key, null])))
  } finally { editor.destroy() }
})

test("Mewoc 往返完整保留段落设置与默认含义，导入创建独立 ID", async () => {
  const source = makeDocument([heading("标题", settings), paragraph("默认", { spaceBefore: null, keepWithNext: null }), paragraph("零值", { spaceBefore: 0, spaceAfter: 0, keepTogether: false })])
  const portable = await createPortableFile(source, new Map())
  const restored = await readPortableFile(new File([JSON.stringify(portable)], "paragraphs.mewoc.json"))
  assert.notEqual(restored.document.id, source.id)
  assert.deepEqual(restored.document.content, source.content)
})

// null 使用样式默认，显式 false/0 必须写入覆盖值，不能被 truthy 判断吞掉。
test("Word 使用 twip 输出显式间距，false 覆盖标题同页默认且默认正文不被更改", async () => {
  const { paragraphs, warnings } = await getWordParagraphs([heading("显式", settings), heading("默认标题"), paragraph("默认正文"), paragraph("开启", { spaceBefore: 0, spaceAfter: 120, keepWithNext: true, keepTogether: false })])
  assert.deepEqual(warnings, [])
  const explicit = paragraphs.find(node => node.textContent === "显式")
  assert.equal(explicit.getElementsByTagName("w:spacing")[0].getAttribute("w:before"), "250")
  assert.equal(explicit.getElementsByTagName("w:spacing")[0].getAttribute("w:after"), "0")
  assert.equal(explicit.getElementsByTagName("w:keepNext")[0].getAttribute("w:val"), "false")
  assert.equal(explicit.getElementsByTagName("w:keepLines").length, 1)
  assert.equal(paragraphs.find(node => node.textContent === "默认标题").getElementsByTagName("w:keepNext").length, 1)
  const normal = paragraphs.find(node => node.textContent === "默认正文")
  assert.equal(normal.getElementsByTagName("w:spacing")[0].getAttribute("w:after"), "240")
  assert.equal(normal.getElementsByTagName("w:keepLines").length, 0)
  const enabled = paragraphs.find(node => node.textContent === "开启")
  assert.equal(enabled.getElementsByTagName("w:spacing")[0].getAttribute("w:before"), "0")
  assert.equal(enabled.getElementsByTagName("w:spacing")[0].getAttribute("w:after"), "2400")
  assert.equal(enabled.getElementsByTagName("w:keepLines")[0].getAttribute("w:val"), "false")
})

test("Word 列表、引用、单元格内显式段距优先于上下文默认，文字和编号保留", async () => {
  const { paragraphs, warnings } = await getWordParagraphs([
    { type: "bulletList", content: [{ type: "listItem", content: [paragraph("列表", { spaceBefore: 2.5, spaceAfter: 18, keepWithNext: true })] }] },
    { type: "blockquote", content: [paragraph("引用", { spaceBefore: 3, spaceAfter: 6 })] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph("单元格", { spaceBefore: 0, spaceAfter: 9, keepTogether: true })] }] }] }
  ])
  assert.deepEqual(warnings, [])
  for (const [text, before, after] of [["列表", 50, 360], ["引用", 60, 120], ["单元格", 0, 180]]) {
    const spacing = paragraphs.find(node => node.textContent === text).getElementsByTagName("w:spacing")[0]
    assert.equal(spacing.getAttribute("w:before"), String(before))
    assert.equal(spacing.getAttribute("w:after"), String(after))
  }
  assert.equal(paragraphs.find(node => node.textContent === "列表").getElementsByTagName("w:numPr").length, 1)
})

test("Markdown 保留所有正文并说明间距和分页设置损失，显式 false 也被报告", async () => {
  const { source, warnings } = await createDocumentMarkdown(makeDocument([heading("标题", settings), paragraph("正文", { spaceBefore: 0, keepTogether: false }), paragraph("默认")]))
  assert.match(source, /标题/)
  assert.match(source, /正文/)
  assert.match(source, /默认/)
  assert.equal(warnings.filter(text => text.includes("段前、段后")).length, 1)
  assert.equal(warnings.filter(text => text.includes("段内不分页")).length, 1)
  const defaults = await createDocumentMarkdown(makeDocument([paragraph("默认")] ))
  assert.deepEqual(defaults.warnings, [])
})
