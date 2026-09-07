import test from "node:test"
import assert from "node:assert/strict"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkStringify from "remark-stringify"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import { createMarkdownTree } from "../src/pages/editor/tools/markdown-export.js"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentMarkdown, readMarkdownDocument } from "../src/pages/editor/tools/markdown-file.js"
import { DEFAULT_PAGE } from "../src/pages/editor/constants/editor-constants.js"

const text = (value, marks) => ({ type: "text", text: value, ...(marks && { marks }) })
const paragraph = (content = [], attrs) => ({ type: "paragraph", content, ...(attrs && { attrs }) })
const document = content => ({ content: { type: "doc", content }, assets: [], page: structuredClone(DEFAULT_PAGE) })
const cell = (type, content, attrs) => ({ type, content, ...(attrs && { attrs }) })
const row = content => ({ type: "tableRow", content })
const math = latex => ({ type: "inlineMath", attrs: { latex } })
const CODEC = unified().use(remarkParse).use(remarkStringify, { emphasis: "_", strong: "*", incrementListMarker: false }).use(remarkGfm).use(remarkMath)
const cleanTree = tree => JSON.parse(JSON.stringify(tree, (key, value) => ["position", "data"].includes(key) ? undefined : value))
const getText = node => {
  if (node.type === "text") return node.text
  if (node.type === "hardBreak") return "\n"
  return (node.content || []).map(getText).join("")
}
const exportAndRead = async content => {
  const record = { ...createDocument(), content: { type: "doc", content } }
  const result = await createDocumentMarkdown(record)
  const imported = await readMarkdownDocument(result.source)
  return { ...result, content: imported.record.document.content, record }
}

test("Markdown 导出保留块结构、列表起点、代码源码及公式", () => {
  const source = document([
    { type: "heading", attrs: { level: 3 }, content: [text("标题")] },
    { type: "blockquote", content: [paragraph([text("引用")])] },
    { type: "orderedList", attrs: { start: 4 }, content: [{ type: "listItem", content: [paragraph([text("条目")]), { type: "bulletList", content: [{ type: "listItem", content: [paragraph([text("嵌套")])] }] }] }] },
    { type: "horizontalRule" },
    { type: "codeBlock", attrs: { language: "Ruby" }, content: [text("\tputs `源码`\n\n")] },
    paragraph([math("x^2"), { type: "hardBreak" }, text("下一行")]),
    { type: "blockMath", attrs: { latex: "\\frac{a}{b}" } }
  ])
  const before = structuredClone(source)
  const { tree, warnings } = createMarkdownTree(source)
  assert.deepEqual(tree.children.map(node => node.type), ["heading", "blockquote", "list", "thematicBreak", "code", "paragraph", "math"])
  assert.equal(tree.children[2].start, 4)
  assert.equal(tree.children[2].children[0].children[1].ordered, false)
  assert.deepEqual(tree.children[4], { type: "code", lang: "Ruby", value: "\tputs `源码`\n\n" })
  assert.equal(tree.children[5].children[0].value, "x^2")
  assert.equal(tree.children[5].children[1].type, "break")
  assert.deepEqual(warnings, [])
  assert.deepEqual(source, before)
})

test("相邻文本标记合并为连续范围，保留内层不同标记和链接", () => {
  const bold = { type: "bold" }
  const link = { type: "link", attrs: { href: "https://example.com/?a=1&b=2" } }
  const { tree } = createMarkdownTree(document([paragraph([
    text("a", [bold]), text("b", [bold, { type: "italic" }]), text("c", [bold]),
    text("d", [link]), text("e", [link, { type: "strike" }]), text("f", [{ type: "code" }])
  ])]))
  const children = tree.children[0].children
  assert.equal(children.length, 3)
  assert.deepEqual(children[0], { type: "strong", children: [{ type: "text", value: "a" }, { type: "emphasis", children: [{ type: "text", value: "b" }] }, { type: "text", value: "c" }] })
  assert.equal(children[1].type, "link")
  assert.equal(children[1].children[1].type, "delete")
  assert.deepEqual(children[2], { type: "inlineCode", value: "f" })
})

test("普通矩形表格保留列对齐、公式和标记并报告布局差异", () => {
  const source = document([{ type: "table", content: [
    row([cell("tableHeader", [paragraph([text("标题|单元格")], { textAlign: "center" })], { colwidth: [160] }), cell("tableHeader", [paragraph([])])]),
    row([cell("tableCell", [paragraph([math("x^2")], { textAlign: "center" })]), cell("tableCell", [paragraph([text("粗体", [{ type: "bold" }])], { textAlign: "right" })])])
  ] }])
  const { tree, warnings } = createMarkdownTree(source)
  assert.equal(tree.children[0].type, "table")
  assert.deepEqual(tree.children[0].align, ["center", null])
  assert.equal(tree.children[0].children[1].children[0].children[0].type, "inlineMath")
  assert.equal(warnings.some(value => value.includes("列宽")), true)
  assert.equal(warnings.some(value => value.includes("统一为首行")), true)
})

test("富表格降为逐格正文，保留多段、图片说明、公式与嵌套引用", () => {
  const source = document([{ type: "table", content: [row([
    cell("tableCell", [paragraph([text("第一段")]), paragraph([math("a+b")]), { type: "image", attrs: { assetId: "image-1", alt: "图注" } }], { colspan: 2 }),
    cell("tableCell", [{ type: "blockquote", content: [paragraph([text("引用")])] }, { type: "blockMath", attrs: { latex: "c^2" } }])
  ])] }])
  source.assets = [{ id: "image-1", fileName: "image.png" }]
  const { tree, warnings } = createMarkdownTree(source)
  assert.deepEqual(tree.children.map(node => node.type), ["paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "blockquote", "math"])
  assert.match(tree.children[0].children[0].value, /跨 2 列/)
  assert.equal(tree.children[2].children[0].type, "inlineMath")
  assert.equal(tree.children[3].children[0].value, "[图片：图注；请使用 Mewoc 文件保留图片]")
  assert.equal(warnings.filter(value => value.includes("图片")).length, 1)
  assert.equal(warnings.some(value => value.includes("按行转换为正文")), true)
})

test("无法表达的样式只报告一次，原始文字及危险围栏语言不作为语法注入", () => {
  const source = document([
    paragraph([text("$a$ <script> **字面**", [{ type: "underline" }, { type: "textStyle", attrs: { color: "#ff0000" } }])], { firstLineIndent: 2, lineHeight: 2 }),
    paragraph([text("第二段", [{ type: "underline" }])], { leftIndent: 3, textAlign: "right" }),
    { type: "codeBlock", attrs: { language: "js\n```" }, content: [] }, { type: "pageBreak" }
  ])
  source.page.orientation = "landscape"
  const { tree, warnings } = createMarkdownTree(source)
  assert.equal(tree.children[0].children[0].value, "$a$ <script> **字面**")
  assert.equal(tree.children[2].lang, null)
  assert.equal(warnings.filter(value => value.includes("下划线")).length, 1)
  assert.equal(warnings.filter(value => value.includes("缩进")).length, 1)
  assert.equal(warnings.some(value => value.includes("围栏")), true)
  assert.equal(warnings.some(value => value.includes("纸张")), true)
})

test("未知节点与文字标记显式失败，行内换行报告归一化", () => {
  assert.throws(() => createMarkdownTree(document([{ type: "futureBlock" }])), /futureBlock/)
  assert.throws(() => createMarkdownTree(document([paragraph([text("正文", [{ type: "futureMark" }])])])), /futureMark/)
  assert.throws(() => createMarkdownTree(document([paragraph([{ type: "futureInline" }])])), /futureInline/)
  const { warnings } = createMarkdownTree(document([paragraph([text("a\nb", [{ type: "code" }]), math("x\ny")])]))
  assert.equal(warnings.filter(value => value.includes("转换为空格")).length, 1)
})

test("图片使用替代文本或文件名说明，不导出内部资源 ID 和本地目录", () => {
  const source = document([
    { type: "image", attrs: { assetId: "internal-image-1", alt: "" } },
    { type: "image", attrs: { assetId: "internal-image-2", alt: "第二幅图" } }
  ])
  source.assets = [
    { id: "internal-image-1", fileName: "/Users/private/照片.png" },
    { id: "internal-image-2", fileName: "C:\\private\\photo.png" }
  ]
  const { tree, warnings } = createMarkdownTree(source)
  const serialized = CODEC.stringify(tree)
  assert.match(serialized, /照片\.png/)
  assert.match(serialized, /第二幅图/)
  assert.doesNotMatch(serialized, /internal-image|Users|private|C:/)
  assert.equal(warnings.length, 1)
})

test("实际 Markdown 序列化往返保留交叉标记、字面符号与代码围栏", () => {
  const italic = { type: "italic" }
  const content = [
    paragraph([text("a", [italic]), text("b", [italic, { type: "bold" }]), text("c", [italic])]),
    paragraph([text("$a$ $$b$$ <script>alert(1)</script> **字面** [链接](javascript:alert) | \\ 原文")]),
    paragraph([math("a$b"), text(" "), math("x\ny")]),
    { type: "blockMath", attrs: { latex: "a\n$$\nb" } },
    { type: "codeBlock", attrs: { language: "js" }, content: [text("```\n\tconst a = 1\n\n")] }
  ]
  const { tree } = createMarkdownTree(document(content))
  const serialized = CODEC.stringify(tree)
  const parsed = cleanTree(CODEC.parse(serialized))
  assert.deepEqual(parsed.children.slice(0, 3), tree.children.slice(0, 3))
  assert.equal(parsed.children[3].value, content[3].attrs.latex)
  assert.equal(parsed.children[4].value, content[4].content[0].text)
  assert.equal(parsed.children[4].lang, "js")
})

test("GFM 表格转义竖线与代码；无法表达的公式和换行降级后源码完整", () => {
  const simple = { type: "table", content: [
    row([cell("tableHeader", [paragraph([text("标题|单元格")])])]),
    row([cell("tableCell", [paragraph([text("a|b", [{ type: "code" }])])])])
  ] }
  const { tree } = createMarkdownTree(document([simple]))
  const parsed = cleanTree(CODEC.parse(CODEC.stringify(tree)))
  assert.deepEqual(parsed, tree)
  for (const inline of [math("a|b"), math("a\nb"), text("a\\|b", [{ type: "code" }]), text("a\nb")]) {
    const source = structuredClone(simple)
    source.content[1].content[0].content[0].content = [inline]
    const converted = createMarkdownTree(document([source]))
    assert.equal(converted.tree.children.some(node => node.type === "table"), false)
    const result = cleanTree(CODEC.parse(CODEC.stringify(converted.tree)))
    assert.deepEqual(result.children[result.children.length - 1], converted.tree.children[converted.tree.children.length - 1])
    assert.equal(converted.warnings.some(value => value.includes("按行转换")), true)
  }
})

test("超出九位的起始编号从一重新编号并明确报告原始起点", () => {
  for (const start of [1000000000, Number.MAX_SAFE_INTEGER]) {
    const source = document([{ type: "orderedList", attrs: { start }, content: ["第一项", "第二项"].map(value => ({
      type: "listItem", content: [paragraph([text(value)])]
    })) }])
    const { tree, warnings } = createMarkdownTree(source)
    const parsed = CODEC.parse(CODEC.stringify(tree))
    assert.equal(parsed.children.length, 1)
    assert.equal(parsed.children[0].type, "list")
    assert.equal(parsed.children[0].start, 1)
    assert.equal(parsed.children[0].children.length, 2)
    assert.equal(warnings.some(value => value.includes(String(start)) && value.includes("从 1 重新编号")), true)
    assert.equal(source.content.content[0].attrs.start, start)
  }
  const { tree, warnings } = createMarkdownTree(document([{ type: "orderedList", attrs: { start: 999999999 }, content: [
    { type: "listItem", content: [paragraph([text("第一项")])] },
    { type: "listItem", content: [paragraph([text("第二项")])] }
  ] }]))
  const parsed = CODEC.parse(CODEC.stringify(tree))
  assert.equal(parsed.children.length, 1)
  assert.equal(parsed.children[0].start, 999999999)
  assert.equal(parsed.children[0].children.length, 2)
  assert.deepEqual(warnings, [])
})

test("空段落按 Markdown 规则折叠并报告，非空正文保持完整", () => {
  const source = document([paragraph(), paragraph([text("正文")]), paragraph(), paragraph()])
  const { tree, warnings } = createMarkdownTree(source)
  const parsed = cleanTree(CODEC.parse(CODEC.stringify(tree)))
  assert.deepEqual(parsed.children, [{ type: "paragraph", children: [{ type: "text", value: "正文" }] }])
  assert.equal(warnings.filter(value => value.includes("空段落")).length, 1)
  assert.equal(source.content.content.length, 4)
})

test("粗斜体边缘空白无损往返，删除线仅移出边缘空白并保留文字", () => {
  for (const value of [" hello ", "  ", "\thello\t"]) {
    for (const type of ["bold", "italic"]) {
      const { tree, warnings } = createMarkdownTree(document([paragraph([text(value, [{ type }])])]))
      assert.deepEqual(cleanTree(CODEC.parse(CODEC.stringify(tree))), tree)
      assert.deepEqual(warnings, [])
    }
    const { tree, warnings } = createMarkdownTree(document([paragraph([text(value, [{ type: "strike" }])])]))
    const parsed = cleanTree(CODEC.parse(CODEC.stringify(tree)))
    assert.deepEqual(parsed, tree)
    assert.equal(parsed.children[0].children.map(node => node.value || node.children.map(child => child.value).join("")).join(""), value)
    assert.equal(warnings.filter(item => item.includes("删除线边缘的空白")).length, 1)
    assert.equal(parsed.children[0].children.some(node => node.type === "delete"), !!value.trim())
  }
})

test("应用入口往返把带标记的硬换行放在标记外，不泄漏字符实体或分隔符", async () => {
  for (const type of ["bold", "italic", "strike"]) {
    const marks = [{ type }]
    const result = await exportAndRead([paragraph([text("pre", marks), { type: "hardBreak", marks }, text("post", marks)])])
    assert.equal(getText(result.content), "pre\npost")
    const children = result.content.content[0].content
    assert.deepEqual(children.map(node => node.type), ["text", "hardBreak", "text"])
    assert.equal(children[1].marks, undefined)
    assert.equal(children[0].marks.some(mark => mark.type === type), true)
    assert.equal(children[2].marks.some(mark => mark.type === type), true)
    assert.equal(result.warnings.some(value => value.includes("硬换行不保留文字标记")), true)
  }
})

test("应用入口往返保留普通与带标记正文的连续换行，不拆段或泄漏分隔符", async () => {
  for (const type of [null, "bold", "italic", "strike"]) {
    const marks = type ? [{ type }] : []
    const result = await exportAndRead([paragraph([text("a\n\nb", marks)])])
    assert.equal(result.content.content.length, 1)
    assert.equal(getText(result.content), "a\n\nb")
    assert.deepEqual(result.content.content[0].content.map(node => node.type), ["text", "hardBreak", "hardBreak", "text"])
    assert.equal(result.warnings.some(value => value.includes("文字中的换行")), true)
    assert.equal(result.record.content.content[0].content[0].text, "a\n\nb")
    if (type) assert.equal(result.content.content[0].content[0].marks.some(mark => mark.type === type), true)
  }
})

test("段首和段中连续硬换行可保留，段尾硬换行明确移除且不产生反斜杠正文", async () => {
  const hardBreak = () => ({ type: "hardBreak" })
  const result = await exportAndRead([paragraph([hardBreak(), hardBreak(), text("a"), hardBreak(), hardBreak(), text("b"), hardBreak(), hardBreak()])])
  assert.equal(getText(result.content), "\n\na\n\nb")
  assert.equal(result.warnings.some(value => value.includes("段尾硬换行")), true)
  const empty = await createDocumentMarkdown({ ...createDocument(), content: { type: "doc", content: [paragraph([hardBreak(), hardBreak()])] } })
  assert.equal(empty.source.trim(), "")
  assert.equal(empty.warnings.some(value => value.includes("空段落")), true)
})

test("含换行标题降为正文并报告级别，行内代码连续换行明确转换为空格", async () => {
  const heading = await exportAndRead([{ type: "heading", attrs: { level: 2 }, content: [text("a\r\n\r\nb", [{ type: "bold" }])] }])
  assert.equal(heading.content.content[0].type, "paragraph")
  assert.equal(getText(heading.content), "a\n\nb")
  assert.equal(heading.warnings.some(value => value.includes("2 级标题已转换为普通段落")), true)
  const code = await exportAndRead([paragraph([text("a\n\nb", [{ type: "code" }])])])
  assert.equal(getText(code.content), "a  b")
  assert.equal(code.content.content[0].content[0].marks[0].type, "code")
  assert.equal(code.warnings.some(value => value.includes("行内代码的换行")), true)
})

test("仅含换行的文字或硬换行仍报告下划线与文字样式的降级", async () => {
  const marks = [{ type: "underline" }, { type: "textStyle", attrs: { color: "#ff0000" } }]
  for (const inline of [text("\n\n", marks), { type: "hardBreak", marks }]) {
    const result = await createDocumentMarkdown({ ...createDocument(), content: { type: "doc", content: [paragraph([inline])] } })
    assert.equal(result.source.trim(), "")
    assert.equal(result.warnings.some(value => value.includes("下划线")), true)
    assert.equal(result.warnings.some(value => value.includes("字体、字号")), true)
    assert.equal(result.warnings.some(value => value.includes("段尾硬换行")), true)
  }
})
