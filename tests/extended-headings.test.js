/**
 * 验证六级标题在共享 schema、命令、实际 CSS、内部粘贴与三种文件格式中的级别一致性。
 * 往返检查包含 Word 样式和大纲元信息，H4–H6 不得被旧转换路径压成三级标题。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { compile } from "sass"
import { Editor } from "@tiptap/core"
import JSZip from "jszip"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { createDocumentMarkdown, readMarkdownDocument } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { createDocxImportContent } from "../src/pages/editor/tools/docx-import-content.js"
import { readDocxParagraphs } from "../src/pages/editor/tools/docx-import-numbering.js"
import { readDocxXml, WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"
import { getSelectionTextStyle } from "../src/pages/editor/tools/text-appearance.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"

// 在 JSDOM 中载入实际正文 Sass 编译结果，回显测试读取真实标题默认外观，而不是手工模拟字号。
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
}
const style = document.head.appendChild(document.createElement("style"))
style.textContent = compile("src/pages/editor/sass/content.scss").css
// 同一组 H1–H6 节点贯穿编辑、Mewoc、Markdown 与 Word 往返，提取 helper 只比较语义级别。
const levels = [1, 2, 3, 4, 5, 6]
const heading = level => ({ type: "heading", attrs: { level }, content: [{ type: "text", text: `标题${level}` }] })
const recordWithHeadings = () => ({ ...createDocument(), content: { type: "doc", content: levels.map(heading) } })
const headingLevels = content => content.content.filter(node => node.type === "heading").map(node => node.attrs.level)
// 每个场景创建独立编辑器并在 finally 销毁，隔离正文、插件和撤销历史；扩展组合只提供该组验证所需能力。
const createEditor = content => new Editor({
  element: document.body.appendChild(document.createElement("div")), extensions: createExtensions(), content,
  editorProps: { attributes: { class: "mewoc-content" }, handleScrollToSelection: () => true }
})
// 直接读取 Word XML 命名空间节点，用于核对最终样式/大纲以及外部命名和继承规则。
const parseWord = source => readDocxXml(source, "extended-heading-test.xml")
const wordNodes = (xml, name) => Array.from(xml.getElementsByTagNameNS(WORD_XML, name))

test("六级标题：共享 Schema 与 HTML 保留 H1–H6，超出范围或非整数级别拒绝", () => {
  const record = recordWithHeadings()
  assert.equal(validateDocument(record), record)
  const editor = createEditor(record.content)
  try {
    assert.deepEqual(headingLevels(editor.getJSON()), levels)
    assert.deepEqual([...editor.view.dom.children].map(node => node.tagName), levels.map(level => `H${level}`))
    for (const level of [0, 7, 9, "4", 4.5]) {
      const invalid = { ...createDocument(), content: { type: "doc", content: [heading(level)] } }
      assert.throws(() => validateDocument(invalid), /属性 level 无效/)
    }
  } finally { editor.destroy() }
})

test("六级标题：H4–H6 命令保留原文与段落设置，逐次独立撤销", () => {
  const editor = createEditor({ type: "doc", content: [{ type: "paragraph", attrs: { spaceAfter: 7.5 }, content: [{ type: "text", text: "原文" }] }] })
  try {
    for (const level of [4, 5, 6]) {
      editor.commands.setTextSelection(1)
      const before = editor.getJSON()
      assert.equal(editor.commands.setHeading({ level }), true)
      const node = editor.getJSON().content[0]
      assert.equal(node.attrs.level, level)
      assert.equal(node.attrs.spaceAfter, 7.5)
      assert.equal(node.content[0].text, "原文")
      assert.equal(editor.commands.undo(), true)
      assert.deepEqual(editor.getJSON(), before)
    }
  } finally { editor.destroy() }
})

// 扩展标题级别时需要同时保护既有三级外观和新增级别回显，JSON 级别正确不等于工具栏字号正确。
test("六级标题：默认外观保持 H1–H3，新级别字号可回显并内部粘贴", () => {
  const editor = createEditor(recordWithHeadings().content)
  try {
    const sizes = ["22.5pt", "15pt", "12.75pt", "11.25pt", "10.5pt", "9.75pt"]
    const heights = [1.5, 1.55, 1.55, 1.55, 1.55, 1.55]
    editor.state.doc.forEach((node, pos, index) => {
      editor.commands.setTextSelection(pos + 1)
      assert.equal(getSelectionTextStyle(editor).fontSize, sizes[index])
      const css = getComputedStyle(editor.view.nodeDOM(pos))
      assert.equal(css.fontWeight, "600")
      assert.equal(Number(css.lineHeight), heights[index])
    })
    editor.commands.setContent(cleanPastedHtml(editor.getHTML()))
    assert.deepEqual(headingLevels(editor.getJSON()), levels)
    assert.doesNotThrow(() => validateDocument({ ...createDocument(), content: editor.getJSON() }))
  } finally { editor.destroy() }
})

for (const [level, points] of [[4, "11.25pt"], [5, "10.5pt"], [6, "9.75pt"]]) {
  test(`六级标题：H${level} 格式刷固化字号后可保存且可撤销`, async () => {
    const editor = createEditor({ type: "doc", content: [heading(level), { type: "paragraph", content: [{ type: "text", text: "正文" }] }] })
    try {
      editor.commands.setTextSelection(1)
      assert.equal(editor.commands.copyFormat(), true)
      const paragraphPos = editor.state.doc.child(0).nodeSize
      editor.commands.setTextSelection({ from: paragraphPos + 1, to: paragraphPos + 3 })
      const before = editor.getJSON()
      assert.equal(editor.commands.applyFormat(), true)
      const target = editor.getJSON().content[1]
      assert.equal(target.type, "paragraph")
      assert.equal(target.content[0].marks.find(mark => mark.type === "textStyle").attrs.fontSize, points)
      const snapshot = validateDocument({ ...createDocument(), content: editor.getJSON() })
      const portable = await createPortableFile(snapshot, new Map())
      const restored = await readPortableFile(new File([JSON.stringify(portable)], "标题.mewoc.json"))
      assert.deepEqual(restored.document.content, JSON.parse(JSON.stringify(snapshot.content)))
      assert.equal(editor.commands.undo(), true)
      assert.deepEqual(editor.getJSON(), before)
    } finally { editor.destroy() }
  })
}

test("六级标题：Mewoc 文件往返创建独立文档并保留全部级别", async () => {
  const source = recordWithHeadings()
  const portable = await createPortableFile(source, new Map())
  const restored = await readPortableFile(new File([JSON.stringify(portable)], "六级标题.mewoc.json"))
  assert.notEqual(restored.document.id, source.id)
  assert.deepEqual(restored.document.content, source.content)
})

test("六级标题：Markdown 导入、导出与再导入均保留 1–6 级且不报压级说明", async () => {
  const source = levels.map(level => `${"#".repeat(level)} 标题${level}`).join("\n\n")
  const imported = await readMarkdownDocument(source)
  assert.deepEqual(headingLevels(imported.record.document.content), levels)
  assert.deepEqual(imported.warnings, [])
  const exported = await createDocumentMarkdown(imported.record.document)
  assert.deepEqual(exported.warnings, [])
  assert.equal(exported.source.trim(), source)
  const restored = await readMarkdownDocument(exported.source)
  assert.deepEqual(headingLevels(restored.record.document.content), levels)
})

// 既检查导出的 OOXML 再经过真实转换器导回，避免只验证输出侧而漏掉导入侧仍限制三级。
test("六级标题：Word 输出样式、字号和大纲级别明确，实际转换往返不压至三级", async () => {
  const source = recordWithHeadings()
  const before = structuredClone(source)
  const result = await createDocumentDocx(source, new Map())
  const bytes = new Uint8Array(await result.blob.arrayBuffer())
  const zip = await JSZip.loadAsync(bytes)
  const xml = parseWord(await zip.file("word/document.xml").async("string"))
  const paragraphs = wordNodes(xml, "p")
  assert.deepEqual(paragraphs.map(node => wordNodes(node, "pStyle")[0].getAttributeNS(WORD_XML, "val")), levels.map(level => `Heading${level}`))
  assert.deepEqual(paragraphs.map(node => Number(wordNodes(node, "sz")[0].getAttributeNS(WORD_XML, "val"))), [45, 30, 26, 23, 21, 20])
  const styles = parseWord(await zip.file("word/styles.xml").async("string"))
  for (const [level, size] of [[4, 23], [5, 21], [6, 20]]) {
    const entries = wordNodes(styles, "style").filter(node => node.getAttributeNS(WORD_XML, "styleId") === `Heading${level}`)
    assert.equal(entries.length, 1, "不得重复声明同 ID 的段落样式")
    const entry = entries[0]
    assert.equal(Number(wordNodes(entry, "sz")[0].getAttributeNS(WORD_XML, "val")), size)
    assert.equal(wordNodes(entry, "color")[0].getAttributeNS(WORD_XML, "val"), "363444")
    assert.equal(wordNodes(entry, "i").length, 0, "新标题不能继承 SDK 默认斜体")
    assert.equal(Number(wordNodes(entry, "outlineLvl")[0].getAttributeNS(WORD_XML, "val")), level - 1)
    assert.equal(wordNodes(entry, "keepNext").length, 1)
    assert.equal(wordNodes(entry, "spacing")[0].getAttributeNS(WORD_XML, "line"), "372")
  }
  assert.ok(result.warnings.some(warning => warning.includes("半磅")))
  const imported = await createDocxImportRecord(await convertDocxImport(bytes), "六级标题")
  assert.deepEqual(headingLevels(imported.record.document.content), levels)
  assert.equal(imported.warnings.some(warning => /标题已转换/.test(warning)), false)
  assert.deepEqual(source, before)
})

test("六级标题：Word 命名样式及继承大纲识别 H4–H6，H7–H9 仅降至 H6 并说明", () => {
  const styles = parseWord(`<w:styles xmlns:w="${WORD_XML}">${[4, 5, 6, 7, 8, 9].map(level => `<w:style w:styleId="Heading${level}"><w:name w:val="Heading ${level}"/></w:style>`).join("")}<w:style w:styleId="Localized"><w:pPr><w:outlineLvl w:val="4"/></w:pPr></w:style><w:style w:styleId="Inherited"><w:basedOn w:val="Localized"/></w:style></w:styles>`)
  const xml = parseWord(`<w:document xmlns:w="${WORD_XML}"><w:body>${[4, 5, 6, 7, 8, 9].map(level => `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>标题${level}</w:t></w:r></w:p>`).join("")}<w:p><w:pPr><w:pStyle w:val="Inherited"/></w:pPr><w:r><w:t>继承五级标题</w:t></w:r></w:p><w:p><w:pPr><w:outlineLvl w:val="8"/></w:pPr><w:r><w:t>九级大纲</w:t></w:r></w:p></w:body></w:document>`)
  const warnings = new Set()
  const paragraphs = readDocxParagraphs(xml, undefined, styles, warnings)
  assert.deepEqual(paragraphs.map(paragraph => paragraph.heading), [4, 5, 6, 6, 6, 6, 5, 6])
  assert.deepEqual([...warnings], ["七至九级标题已转换为六级标题"])
  const html = paragraphs.map((paragraph, index) => `<p class="mewoc-docx-paragraph">标题${index}</p>`).join("")
  const content = createDocxImportContent(html, new Map(), paragraphs, [], warnings)
  assert.deepEqual(headingLevels(content), [4, 5, 6, 6, 6, 6, 5, 6])
  assert.doesNotThrow(() => validateDocument({ ...createDocument(), content }))
})

test("六级标题：Word 转换 HTML 的 H4–H6 不依赖段落元信息也保留级别", () => {
  const warnings = new Set()
  const content = createDocxImportContent("<h4>四级</h4><h5>五级</h5><h6>六级</h6>", new Map(), [], [], warnings)
  assert.deepEqual(headingLevels(content), [4, 5, 6])
  assert.deepEqual([...warnings], [])
})
