const paragraph = text => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] })
const heading = text => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] })
const item = (text, children = []) => ({ type: "listItem", content: [paragraph(text), ...children] })
const cell = (text, attrs = {}, children = []) => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [160], ...attrs }, content: [paragraph(text), ...children] })

// 同一份复杂内容用于 Node 包结构检查、渲染检查和真实浏览器导出，避免每条链路各测一个样例。
export function createComplexDocxDocument(base) {
  const document = structuredClone(base)
  document.title = "M7 · Word 复杂内容验收"
  document.content.content = [
    heading("Word 复杂内容转换"),
    { type: "paragraph", attrs: { firstLineIndent: 2, lineHeight: 1.5 }, content: [
      { type: "text", text: "中文 English 样式：" },
      { type: "text", text: "彩色加粗下划线", marks: [{ type: "bold" }, { type: "underline" }, { type: "textStyle", attrs: { color: "#6942a3", backgroundColor: "#fff1ad", fontSize: "14pt" } }] },
      { type: "text", text: "、文档链接", marks: [{ type: "link", attrs: { href: "https://docx.js.org/" } }] }
    ] },
    { type: "orderedList", attrs: { start: 3, type: "1" }, content: [
      item("从编号三开始", [paragraph("同一列表项的第二段不重复编号。"), { type: "bulletList", content: [item("嵌套项目甲"), item("嵌套项目乙")] }]),
      item("外层编号继续为四")
    ] },
    { type: "orderedList", attrs: { start: 1, type: "A" }, content: [item("独立列表重新从 A 开始")] },
    { type: "blockquote", content: [paragraph("引用内容保留缩进、底色和左边线。"), { type: "bulletList", content: [item("引用中的列表")] }] },
    { type: "horizontalRule" },
    { type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: "// 中文注释与完整换行\nconst message = \"你好 Word\"\n\nif (message) {\n  alert(message)\n}" }] },
    { type: "pageBreak" },
    heading("公式、图片与合并表格"),
    { type: "paragraph", content: [{ type: "text", text: "行内公式：" }, { type: "inlineMath", attrs: { latex: "E=mc^2" } }] },
    { type: "blockMath", attrs: { latex: "\\frac{a_1+\\sqrt{x}}{b^2}=\\sum_{i=1}^{n}i" } },
    { type: "blockMath", attrs: { latex: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}" } },
    { type: "image", attrs: { assetId: "m5-image", width: 160, height: 80, alt: "紫色验收图片" } },
    { type: "table", content: [
      { type: "tableRow", content: ["区域", "内容", "状态"].map(text => ({ ...cell(text), type: "tableHeader" })) },
      { type: "tableRow", content: [cell("纵向合并", { rowspan: 2 }), cell("横向合并（两列）", { colspan: 2, colwidth: [160, 160] }, [
        { type: "bulletList", content: [item("合并单元格里的列表")] }
      ])] },
      { type: "tableRow", content: [cell("含图片", {}, [{ type: "image", attrs: { assetId: "m5-image", width: 240, height: 120 } }]), cell("嵌套表格", {}, [
        { type: "table", content: [{ type: "tableRow", content: [cell("内甲", { colwidth: [55] }), cell("内乙", { colwidth: [55] })] }] }
      ])] }
    ] },
    { type: "attachment", attrs: { assetId: "m5-attachment" } }
  ]
  return document
}

export function createLongDocxTable(base) {
  const document = structuredClone(base)
  document.title = "M7 · Word 长表格验收"
  document.assets = []
  document.content.content = [heading("长表格跨页与重复表头"), { type: "table", content: [
    { type: "tableRow", content: ["序号", "内容", "备注"].map(text => ({ ...cell(text), type: "tableHeader" })) },
    ...Array.from({ length: 48 }, (_, index) => ({ type: "tableRow", content: [cell(String(index + 1)), cell(`第 ${index + 1} 行：跨页文字保持完整`), cell("验收记录")] }))
  ] }]
  return document
}
