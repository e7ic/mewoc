import { DEFAULT_PAGE } from "../constants/editor-constants.js"
import { getAttachmentText } from "./attachment-assets.js"

const INLINE_TYPES = ["text", "hardBreak", "inlineMath"]
const MARK_TYPES = ["bold", "italic", "strike", "code", "link", "underline", "textStyle"]
const MARK_ORDER = ["link", "bold", "italic", "strike"]
const MARK_NODES = { bold: "strong", italic: "emphasis", strike: "delete" }

/**
 * 将编辑器 JSON 转成 Markdown AST；保留可表达的内容，并逐类记录排版/资源转换说明。
 * 未知节点直接报错，不能默默跳过；完整样式和二进制备份应使用 Mewoc 文件。
 */
export function createMarkdownTree(document) {
  if (document.content.type !== "doc") throw new Error("Markdown 导出要求完整文档")
  const context = { warnings: new Set(), assets: document.assets }
  const page = document.page
  if (page.size !== DEFAULT_PAGE.size || page.orientation !== DEFAULT_PAGE.orientation ||
    Object.keys(DEFAULT_PAGE.marginsMm).some(key => page.marginsMm[key] !== DEFAULT_PAGE.marginsMm[key])) {
    context.warnings.add("Markdown 不保留纸张方向和页边距")
  }
  const tree = { type: "root", children: getBlocks(document.content.content || [], context) }
  return { tree, warnings: [...context.warnings] }
}

function getBlocks(nodes, context) {
  return nodes.flatMap(node => {
    if (node.type === "paragraph" || node.type === "heading") {
      reportParagraphStyle(node, context)
      const children = getInlineNodes(node.content || [], context)
      const multilineHeading = node.type === "heading" && children.some(child => child.type === "break")
      if (multilineHeading) context.warnings.add(`含换行的 ${node.attrs.level} 级标题已转换为普通段落，保留正文换行`)
      const type = multilineHeading ? "paragraph" : node.type
      if (type === "paragraph" && !children.length) context.warnings.add("空段落会按 Markdown 规则折叠，空段间距不保留")
      return [{ type, ...(type === "heading" && { depth: node.attrs.level }), children }]
    }
    if (node.type === "blockquote") return [{ type: "blockquote", children: getBlocks(node.content || [], context) }]
    if (node.type === "bulletList" || node.type === "orderedList") return [getList(node, context)]
    if (node.type === "horizontalRule") return [{ type: "thematicBreak" }]
    if (node.type === "codeBlock") return [getCodeBlock(node, context)]
    if (node.type === "blockMath") return [{ type: "math", value: node.attrs.latex }]
    if (node.type === "image") return [{ type: "paragraph", children: [getImageText(node, context)] }]
    if (node.type === "attachment") {
      const asset = context.assets.find(item => item.id === node.attrs.assetId)
      context.warnings.add("附件已转换为文件说明；请使用 Mewoc 文件保留附件内容")
      return [{ type: "paragraph", children: [{ type: "text", value: `${getAttachmentText(asset)}（附件内容请从 Mewoc 文件获取）` }] }]
    }
    if (node.type === "table") return getTable(node, context)
    if (node.type === "pageBreak") {
      context.warnings.add("手动分页符已转换为文字说明")
      return [{ type: "paragraph", children: [{ type: "text", value: "[手动分页符]" }] }]
    }
    throw new Error(`Markdown 导出不支持节点 ${node.type}`)
  })
}

function getList(node, context) {
  let start = node.type === "orderedList" ? node.attrs?.start || 1 : null
  if (start > 999999999) {
    context.warnings.add(`有序列表原始起点为 ${start}，超过 Markdown 九位编号限制，已从 1 重新编号`)
    start = 1
  }
  if (node.type === "orderedList" && node.attrs?.type && node.attrs.type !== "1") {
    context.warnings.add("字母或罗马数字列表已转换为数字编号")
  }
  return {
    type: "list", ordered: node.type === "orderedList", start,
    spread: true,
    children: (node.content || []).map(item => {
      if (item.type !== "listItem") throw new Error(`Markdown 列表不支持节点 ${item.type}`)
      return { type: "listItem", spread: true, children: getBlocks(item.content || [], context) }
    })
  }
}

function getCodeBlock(node, context) {
  const language = node.attrs?.language || ""
  const safeLanguage = /^[a-z0-9#+._-]{1,1000}$/i.test(language)
  if (language && !safeLanguage) context.warnings.add("部分代码语言含 Markdown 围栏不支持的字符，已保留源码并省略语言")
  const value = (node.content || []).map(child => {
    if (child.type !== "text") throw new Error(`代码块包含不支持节点 ${child.type}`)
    return child.text
  }).join("")
  return { type: "code", lang: safeLanguage ? language : null, value }
}

function getInlineNodes(nodes, context) {
  const children = []
  nodes.forEach(node => {
    if (!INLINE_TYPES.includes(node.type)) throw new Error(`Markdown 行内不支持节点 ${node.type}`)
    const marks = node.marks || []
    reportMarks(marks, context)
    if (node.type === "text") {
      getTextNodes(node, context).forEach(inline => appendInline(children, inline))
      return
    }
    if (node.type === "hardBreak") {
      if (marks.length) context.warnings.add("硬换行不保留文字标记，前后正文的标记继续保留")
      children.push({ type: "break" })
      return
    }
    appendInline(children, applyMarks({ type: "inlineMath", value: node.attrs.latex }, marks, context))
  })
  if (children[children.length - 1]?.type === "break") context.warnings.add("段尾硬换行无法用 Markdown 保留，已移除这些换行")
  while (children[children.length - 1]?.type === "break") children.pop()
  return trimStrikeWhitespace(children, context)
}

function getTextNodes(node, context) {
  const marks = node.marks || []
  if (!/[\r\n]/.test(node.text) || marks.some(mark => mark.type === "code")) {
    return [applyMarks({ type: "text", value: node.text }, marks, context)]
  }
  context.warnings.add("文字中的换行已转换为显式换行，文字标记仅保留在各行正文")
  const children = []
  node.text.split(/\r\n?|\n/).forEach((value, index) => {
    if (index) children.push({ type: "break" })
    if (value) children.push(applyMarks({ type: "text", value }, marks, context))
  })
  return children
}

// 删除线分隔符边缘的空白会影响 Markdown 解析，将空白移到标记外而保留原文字顺序。
function trimStrikeWhitespace(nodes, context) {
  return nodes.flatMap(node => {
    if (node.children) node.children = trimStrikeWhitespace(node.children, context)
    if (node.type !== "delete") return [node]
    const first = node.children[0]
    const leading = first?.type === "text" ? first.value.match(/^\s+/)?.[0] || "" : ""
    if (leading) first.value = first.value.slice(leading.length)
    const last = node.children[node.children.length - 1]
    const trailing = last?.type === "text" ? last.value.match(/\s+$/)?.[0] || "" : ""
    if (trailing) last.value = last.value.slice(0, -trailing.length)
    if (!leading && !trailing) return [node]
    context.warnings.add("删除线边缘的空白已保留为普通文字，内部文字继续使用删除线")
    node.children = node.children.filter(child => child.type !== "text" || child.value)
    return [
      ...(leading ? [{ type: "text", value: leading }] : []),
      ...(node.children.length ? [node] : []),
      ...(trailing ? [{ type: "text", value: trailing }] : [])
    ]
  })
}

function reportMarks(marks, context) {
  marks.forEach(mark => {
    if (!MARK_TYPES.includes(mark.type)) throw new Error(`Markdown 导出不支持文字标记 ${mark.type}`)
    if (mark.type === "underline") context.warnings.add("Markdown 不保留下划线")
    if (mark.type === "textStyle" && Object.values(mark.attrs || {}).some(value => value !== null && value !== "")) {
      context.warnings.add("Markdown 不保留字体、字号、文字颜色和背景色")
    }
  })
}

function applyMarks(inline, marks, context) {
  if (marks.some(mark => mark.type === "code")) {
    if (inline.type !== "text") throw new Error("行内代码标记只能应用于文字")
    if (/[\r\n]/.test(inline.value)) context.warnings.add("行内代码的换行会按 Markdown 规则转换为空格")
    inline = { type: "inlineCode", value: inline.value.replace(/\r\n?|\n/g, " ") }
  }
  // 固定嵌套顺序后相邻同类标记才能合并；倒序包裹使链接最终位于最外层。
  for (const type of [...MARK_ORDER].reverse()) {
    const mark = marks.find(item => item.type === type)
    if (!mark) continue
    inline = type === "link" ? { type: "link", url: mark.attrs.href, children: [inline] } : { type: MARK_NODES[type], children: [inline] }
  }
  return inline
}

function appendInline(children, node) {
  const previous = children[children.length - 1]
  if (["text", "inlineCode"].includes(node.type) && previous?.type === node.type) {
    previous.value += node.value
    return
  }
  // 同一标记覆盖多个 JSON 文本片段；合并外层以免生成相邻 Markdown 分隔符。
  if (previous?.children && node.children && previous.type === node.type && previous.url === node.url) {
    node.children.forEach(child => appendInline(previous.children, child))
    return
  }
  children.push(node)
}

function getImageText(node, context) {
  const asset = context.assets.find(item => item.id === node.attrs.assetId)
  const fileName = asset?.fileName.split(/[\\/]/).pop()
  const label = node.attrs.alt || fileName || "未命名图片"
  context.warnings.add("图片已转换为文字说明；请使用 Mewoc 文件保留完整图片")
  return { type: "text", value: `[图片：${label}；请使用 Mewoc 文件保留图片]` }
}

function reportParagraphStyle(node, context, preserveAlignment = false) {
  const attrs = node.attrs || {}
  if (!preserveAlignment && attrs.textAlign && attrs.textAlign !== "left") context.warnings.add("Markdown 不保留段落对齐")
  if (attrs.firstLineIndent || attrs.leftIndent) context.warnings.add("Markdown 不保留首行缩进和段落缩进")
  if (attrs.lineHeight) context.warnings.add("Markdown 不保留段落行距")
}

// 只有单段、无合并且首行全表头的规则表格使用 GFM 表格，其余逐格展开以保留内容。
// 不强行把复杂单元格压成字符串，避免公式、列表或多段内容丢失。
function getTable(node, context) {
  const rows = node.content || []
  const columns = rows[0]?.content?.length || 0
  const simple = columns > 0 && rows.every((row, index) => row.type === "tableRow" && row.content?.length === columns &&
    row.content.every(cell => cell.type === (index === 0 ? "tableHeader" : "tableCell") &&
      (cell.attrs?.colspan || 1) === 1 && (cell.attrs?.rowspan || 1) === 1 && cell.content?.length === 1 &&
      cell.content[0].type === "paragraph" && (cell.content[0].content || []).every(isTableInline)))
  if (!simple) return getTableParagraphs(rows, context)
  const align = rows[0].content.map(cell => getCellAlignment(cell))
  return [{
    type: "table", align,
    children: rows.map(row => ({
      type: "tableRow",
      children: row.content.map((cell, index) => {
        reportCellStyle(cell, context)
        const paragraph = cell.content[0]
        reportParagraphStyle(paragraph, context, true)
        if (getCellAlignment(cell) !== align[index]) context.warnings.add("表格同列的不同对齐方式已统一为首行对齐")
        return { type: "tableCell", children: getInlineNodes(paragraph.content || [], context) }
      })
    }))
  }]
}

function getCellAlignment(cell) {
  const alignment = cell.content[0].attrs?.textAlign
  return ["center", "right"].includes(alignment) ? alignment : null
}

function isTableInline(node) {
  if (node.type === "inlineMath") return !/[|\r\n]/.test(node.attrs.latex)
  if (node.type !== "text" || /[\r\n]/.test(node.text)) return false
  // GFM 的代码/公式序列化不能完整表达这类分隔符组合，保留为正文中的原节点。
  return !node.marks?.some(mark => mark.type === "code") || !/\\\|/.test(node.text)
}

function reportCellStyle(cell, context) {
  if (cell.attrs?.colwidth) context.warnings.add("Markdown 不保留表格列宽")
  if (cell.content.some(node => node.attrs?.textAlign === "justify")) context.warnings.add("Markdown 表格不保留两端对齐")
}

function getTableParagraphs(rows, context) {
  context.warnings.add("包含合并单元格、复杂内容或特殊表头的表格已按行转换为正文，保留各格内容")
  const paragraphs = []
  rows.forEach((row, rowIndex) => {
    if (row.type !== "tableRow") throw new Error(`Markdown 表格不支持节点 ${row.type}`)
    row.content.forEach((cell, cellIndex) => {
      if (!["tableHeader", "tableCell"].includes(cell.type)) throw new Error(`Markdown 表格不支持单元格 ${cell.type}`)
      reportCellStyle(cell, context)
      const span = (cell.attrs?.colspan || 1) > 1 || (cell.attrs?.rowspan || 1) > 1
      const label = `表格第 ${rowIndex + 1} 行，第 ${cellIndex + 1} 格${span ? `（跨 ${cell.attrs?.colspan || 1} 列、${cell.attrs?.rowspan || 1} 行）` : ""}：`
      paragraphs.push({ type: "paragraph", children: [{ type: "text", value: label }] }, ...getBlocks(cell.content || [], context))
    })
  })
  return paragraphs
}
