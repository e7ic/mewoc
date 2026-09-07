import { isSafeLink } from "./document-schema.js"
import { getFormulaSourceError } from "./formula.js"

const MARKDOWN_MARKS = new Map([["strong", "bold"], ["emphasis", "italic"], ["delete", "strike"]])

export function createMarkdownContent(tree) {
  const warnings = new Set()
  const definitions = new Map()
  let count = 0
  const visit = (node, depth) => {
    count += 1
    if (depth > 48 || count > 50000) throw new Error("Markdown 结构过深或节点过多")
    if (node.type === "definition" && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node)
    node.children?.forEach(child => visit(child, depth + 1))
  }
  visit(tree, 0)
  const context = { warnings, definitions }
  const content = getMarkdownBlocks(tree.children, context)
  return { content: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] }, warnings: [...warnings] }
}

function getMarkdownBlocks(nodes, context) {
  return nodes.flatMap(node => getMarkdownBlock(node, context))
}

function getMarkdownBlock(node, context) {
  const { warnings } = context
  if (node.type === "definition") return []
  if (node.type === "paragraph") return [{ type: "paragraph", content: getMarkdownInline(node.children, context) }]
  if (node.type === "heading") {
    if (node.depth > 3) warnings.add("四至六级标题已转换为三级标题")
    return [{ type: "heading", attrs: { level: Math.min(node.depth, 3) }, content: getMarkdownInline(node.children, context) }]
  }
  if (node.type === "blockquote") {
    const content = getMarkdownBlocks(node.children, context)
    return [{ type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] }]
  }
  if (node.type === "thematicBreak") return [{ type: "horizontalRule" }]
  if (node.type === "code") {
    let language = node.lang || "plaintext"
    if (language.length > 1000) {
      language = "plaintext"
      warnings.add("过长的代码语言标记已改为纯文本，源码保留")
    }
    if (node.meta) warnings.add("代码围栏的附加参数不受支持，已保留源码和语言")
    return [{ type: "codeBlock", attrs: { language }, content: getText(node.value) }]
  }
  if (node.type === "html") {
    warnings.add("HTML 源码按文字保留，不执行其中的标签或脚本")
    return [{ type: "paragraph", content: getText(node.value) }]
  }
  if (node.type === "math") return getMarkdownFormula(node.value, false, context)
  if (node.type === "list") return [getMarkdownList(node, context)]
  if (node.type === "table") return [getMarkdownTable(node, context)]
  if (node.type === "footnoteDefinition") {
    warnings.add("脚注已转换为带编号的普通文字")
    return [{ type: "paragraph", content: getText(`[^${node.label || node.identifier}]：`) }, ...getMarkdownBlocks(node.children, context)]
  }
  throw new Error(`暂不支持 Markdown 节点：${node.type}`)
}

function getMarkdownList(node, context) {
  if (node.ordered && node.start === 0) context.warnings.add("从 0 开始的有序列表已改为从 1 开始")
  const content = node.children.map(item => {
    const blocks = getMarkdownBlocks(item.children, context)
    if (blocks[0]?.type !== "paragraph") blocks.unshift({ type: "paragraph", content: [] })
    if (item.checked !== null && item.checked !== undefined) {
      context.warnings.add("任务列表已保留为 [x] / [ ] 文字，不提供勾选控件")
      blocks[0].content = [...getText(item.checked ? "[x] " : "[ ] "), ...(blocks[0].content || [])]
    }
    return { type: "listItem", content: blocks }
  })
  return node.ordered ? { type: "orderedList", attrs: { start: node.start || 1 }, content } : { type: "bulletList", content }
}

function getMarkdownTable(node, context) {
  const columns = Math.max(...node.children.map(row => row.children.length))
  if (columns * node.children.length > 10000) throw new Error("Markdown 表格不能超过 10000 个单元格")
  if (node.children.some(row => row.children.length !== columns)) context.warnings.add("表格列数不齐，已补空单元格并保留全部已有内容")
  return { type: "table", content: node.children.map((row, rowIndex) => ({
    type: "tableRow", content: Array.from({ length: columns }, (_, column) => ({
      type: rowIndex === 0 ? "tableHeader" : "tableCell",
      content: [{ type: "paragraph", attrs: { textAlign: node.align[column] || null }, content: getMarkdownInline(row.children[column]?.children || [], context) }]
    }))
  })) }
}

function getMarkdownInline(nodes, context, marks = []) {
  return nodes.flatMap(node => {
    if (node.type === "text") return getText(node.value, marks)
    const type = MARKDOWN_MARKS.get(node.type)
    if (type) return getMarkdownInline(node.children, context, [...marks.filter(mark => mark.type !== type), { type }])
    if (node.type === "inlineCode") {
      if (marks.length) context.warnings.add("行内代码不叠加其他文字标记，已保留代码内容")
      return getText(node.value, [{ type: "code" }])
    }
    if (node.type === "break") return [{ type: "hardBreak" }]
    if (node.type === "inlineMath") return getMarkdownFormula(node.value, true, context, marks)
    if (["link", "linkReference"].includes(node.type)) return getMarkdownLink(node, context, marks)
    if (["image", "imageReference"].includes(node.type)) {
      const image = node.type === "image" ? node : context.definitions.get(node.identifier.toUpperCase())
      context.warnings.add("图片未下载，已保留替代说明和原地址；请使用图片入口插入本地文件")
      const address = image ? image.url : node.identifier
      return getText(`[图片：${node.alt || "未提供说明"}] ${address || "（空地址）"}`, marks)
    }
    if (node.type === "footnoteReference") {
      context.warnings.add("脚注已转换为带编号的普通文字")
      return getText(`[^${node.label || node.identifier}]`, marks)
    }
    if (node.type === "html") {
      context.warnings.add("HTML 源码按文字保留，不执行其中的标签或脚本")
      return getText(node.value, marks)
    }
    throw new Error(`暂不支持 Markdown 行内节点：${node.type}`)
  })
}

function getMarkdownLink(node, context, marks) {
  const link = node.type === "link" ? node : context.definitions.get(node.identifier.toUpperCase())
  if (link?.title) context.warnings.add("链接的附加标题不受支持，已保留正文与地址")
  if (link && isSafeLink(link.url)) {
    return getMarkdownInline(node.children, context, [...marks.filter(mark => mark.type !== "link"),
      { type: "link", attrs: { href: link.url, target: "_blank", rel: "noopener noreferrer" } }])
  }
  context.warnings.add("空地址、相对地址或不支持的链接协议已保留为普通文字")
  const address = link ? link.url : node.identifier
  return [...getMarkdownInline(node.children, context, marks), ...getText(`（${address || "空地址"}）`, marks)]
}

function getMarkdownFormula(latex, inline, context, marks = []) {
  if (getFormulaSourceError(latex)) {
    context.warnings.add("空公式或超长公式已保留为带美元分隔符的文字")
    const text = getText(inline ? `$${latex}$` : `$$\n${latex}\n$$`, marks)
    return inline ? text : [{ type: "paragraph", content: text }]
  }
  return [{ type: inline ? "inlineMath" : "blockMath", attrs: { latex }, ...(marks.length ? { marks } : {}) }]
}

function getText(value, marks = []) {
  return value ? [{ type: "text", text: value, ...(marks.length ? { marks } : {}) }] : []
}
