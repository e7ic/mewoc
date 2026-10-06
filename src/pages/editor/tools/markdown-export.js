/**
 * 编辑器文档到 Markdown AST 的映射层：保留内容语义并集中记录无法表达的样式/资源信息。
 * 行内格式按固定层次合并，简单表格映射 GFM，复杂表格按格展开避免压扁正文。
 */
import { DEFAULT_PAGE } from "../constants/editor-constants.js"
import { getAttachmentText } from "./attachment-assets.js"
import { createCommentAppendixMarkdown, COMMENT_MARKDOWN_WARNING } from "./comment-export.js"
import { DETAILS_DEFAULTS } from "./block-containers.js"
import { isInternalNavigationHref } from "./document-navigation.js"
import { prepareNavigationExportContent } from "./navigation-export.js"
import { isPageFurnitureActive } from "./page-furniture.js"
import { getMediaText } from "./media-assets.js"

// 类型白名单用于拒绝未知内容；marks 接受 commentAnchor，但实际批注由文末附录保留。
const INLINE_TYPES = ["text", "hardBreak", "inlineMath"]
const MARK_TYPES = ["bold", "italic", "strike", "code", "link", "underline", "superscript", "subscript", "textStyle", "commentAnchor"]
const MARK_ORDER = ["link", "bold", "italic", "strike"]
const MARK_NODES = { bold: "strong", italic: "emphasis", strike: "delete" }

/**
 * 将编辑器 JSON 转成 Markdown AST；保留可表达的内容，并逐类记录排版/资源转换说明。
 * 未知节点直接报错，不能默默跳过；完整样式和二进制备份应使用 Mewoc 文件。
 */
export function createMarkdownTree(document) {
  if (document.content.type !== "doc") throw new Error("Markdown 导出要求完整文档")
  const navigation = prepareNavigationExportContent(document.content)
  const context = { warnings: new Set(navigation.warnings), assets: document.assets }
  const page = document.page
  if (page.size !== DEFAULT_PAGE.size || page.orientation !== DEFAULT_PAGE.orientation ||
    Object.keys(DEFAULT_PAGE.marginsMm).some(key => page.marginsMm[key] !== DEFAULT_PAGE.marginsMm[key])) {
    context.warnings.add("Markdown 不保留纸张大小、方向和页边距")
  }
  if (page.watermark) context.warnings.add("Markdown 不保留页面水印，正文文字保持原内容")
  if ([page.header, page.footer].some(isPageFurnitureActive)) context.warnings.add("Markdown 不保留页眉、页脚和页码，正文文字保持原内容")
  const appendix = createCommentAppendixMarkdown(document)
  if (appendix.length) context.warnings.add(COMMENT_MARKDOWN_WARNING)
  const tree = { type: "root", children: [...getBlocks(navigation.content.content || [], context), ...appendix] }
  return { tree, warnings: [...context.warnings] }
}

/** 将块节点转换为一个或多个 Markdown 块，正文顺序不变；不支持的节点直接阻断导出。 */
function getBlocks(nodes, context) {
  return nodes.flatMap(node => {
    if (node.type === "paragraph" || node.type === "heading") {
      reportParagraphStyle(node, context)
      const children = getInlineNodes(node.content || [], context)
      // Markdown 标题无法含显式换行，转普通段落以优先保留文字与行边界。
      const multilineHeading = node.type === "heading" && children.some(child => child.type === "break")
      if (multilineHeading) context.warnings.add(`含换行的 ${node.attrs.level} 级标题已转换为普通段落，保留正文换行`)
      const type = multilineHeading ? "paragraph" : node.type
      if (type === "paragraph" && !children.length) context.warnings.add("空段落会按 Markdown 规则折叠，空段间距不保留")
      return [{ type, ...(type === "heading" && { depth: node.attrs.level }), children }]
    }
    if (node.type === "blockquote") return [{ type: "blockquote", children: getBlocks(node.content || [], context) }]
    if (node.type === "textBox") {
      context.warnings.add("文本框已展开为普通正文，Markdown 不保留边框、底色和内边距")
      return getBlocks(node.content || [], context)
    }
    if (node.type === "details") {
      context.warnings.add("折叠详情已展开为标题和完整正文，Markdown 不保留折叠交互")
      return [{ type: "paragraph", children: [{ type: "strong", children: [{ type: "text", value: node.attrs?.summary ?? DETAILS_DEFAULTS.summary }] }] },
        ...getBlocks(node.content || [], context)]
    }
    if (node.type === "tableOfContents") {
      context.warnings.add("目录已转换为当前标题的文字快照，Markdown 不保留目录更新、文内跳转和页码")
      return [{ type: "paragraph", children: [{ type: "strong", children: [{ type: "text", value: node.attrs.title }] }] },
        ...(node.attrs.entries.length ? [getTableOfContentsList(node.attrs.entries)] : [])]
    }
    if (["bulletList", "orderedList", "taskList"].includes(node.type)) return [getList(node, context)]
    if (node.type === "horizontalRule") return [{ type: "thematicBreak" }]
    if (node.type === "codeBlock") return [getCodeBlock(node, context)]
    if (node.type === "blockMath") return [{ type: "math", value: node.attrs.latex }]
    if (node.type === "image") return [{ type: "paragraph", children: [getImageText(node, context)] }]
    if (node.type === "attachment") {
      const asset = context.assets.find(item => item.id === node.attrs.assetId)
      context.warnings.add("附件已转换为文件说明；请使用 Mewoc 文件保留附件内容")
      return [{ type: "paragraph", children: [{ type: "text", value: `${getAttachmentText(asset)}（附件内容请从 Mewoc 文件获取）` }] }]
    }
    if (node.type === "media") {
      const asset = context.assets.find(item => item.id === node.attrs.assetId)
      context.warnings.add("音频和视频已转换为文件说明；完整资源请使用 Mewoc 文件或 HTML")
      return [{ type: "paragraph", children: [{ type: "text", value: getMediaText(asset) }] }]
    }
    if (node.type === "table") return getTable(node, context)
    if (node.type === "pageBreak") {
      context.warnings.add("手动分页符已转换为文字说明")
      return [{ type: "paragraph", children: [{ type: "text", value: "[手动分页符]" }] }]
    }
    throw new Error(`Markdown 导出不支持节点 ${node.type}`)
  })
}

/**
 * 目录层级必须写成真正的列表结构；段首空格会被普通 Markdown 段落折叠，不能承担缩进语义。
 * 跳级标题归入最近的前置低级标题，不补虚构父项；回到同级或更高级时结束此前分支。
 */
function getTableOfContentsList(entries) {
  const list = { type: "list", ordered: false, start: null, spread: false, children: [] }
  const ancestors = []
  for (const entry of entries) {
    while (ancestors.length && ancestors.at(-1).level >= entry.level) ancestors.pop()
    const item = { type: "listItem", spread: false, children: [{ type: "paragraph", children: [{ type: "text", value: entry.text || "未命名标题" }] }] }
    const parent = ancestors.at(-1)
    if (parent) {
      // 同一父标题的多个子项复用一份列表，避免 stringify 把同级条目拆成独立列表。
      if (!parent.list) {
        parent.list = { type: "list", ordered: false, start: null, spread: false, children: [] }
        parent.item.children.push(parent.list)
      }
      parent.list.children.push(item)
    } else list.children.push(item)
    ancestors.push({ level: entry.level, item })
  }
  return list
}

/** 保留普通列表嵌套和起点，超九位起点/字母罗马编号超出 Markdown 语法时给出降级说明。 */
function getList(node, context) {
  const task = node.type === "taskList"
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
      if (item.type !== (task ? "taskItem" : "listItem")) throw new Error(`Markdown 列表不支持节点 ${item.type}`)
      const children = getBlocks(item.content || [], context)
      // GFM 的复选框后必须有正文；空首段会让 stringify 静默丢掉 checked。
      // 用可见说明承接空项，明确报告这处补文，不引入隐藏字符或可执行 HTML。
      if (task && children[0]?.type === "paragraph" && !children[0].children.length) {
        children[0].children = [{ type: "text", value: "（空待办）" }]
        context.warnings.add("Markdown 空待办项已补充“（空待办）”文字，以保留勾选状态")
      }
      return { type: "listItem", spread: true, ...(task && { checked: item.attrs?.checked === true }), children }
    })
  }
}

/** 只把安全语言串放进围栏信息，正文必须全部为 text；语言不兼容时省略语言而保留完整源码。 */
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

/**
 * 行内节点先校验类型与 marks，再按格式封装和合并；硬换行独立输出，段尾无法保留的换行移除。
 * 最后修整删除线边缘空白，使生成文本重新解析时仍得到相同正文及标记。
 */
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

/** 文字内的 CR/LF 显式拆为 break；行内代码另有换行转空格规则，因此不在这里拆开。 */
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

/** 逐类报告 Markdown 不支持的视觉样式，未知 mark 仍报错而不是当作可忽略格式。 */
function reportMarks(marks, context) {
  marks.forEach(mark => {
    if (!MARK_TYPES.includes(mark.type)) throw new Error(`Markdown 导出不支持文字标记 ${mark.type}`)
    if (mark.type === "underline") context.warnings.add("Markdown 不保留下划线")
    if (mark.type === "link" && isInternalNavigationHref(mark.attrs?.href)) context.warnings.add("文内链接已转换为普通文字，Markdown 不保留内部跳转")
    // 不写入 sup/sub HTML，保持导入端“HTML 只按源码文字保留”的安全契约。
    if (["superscript", "subscript"].includes(mark.type)) context.warnings.add("Markdown 不保留文字上下标，已保留全部文字内容")
    if (mark.type === "textStyle" && Object.values(mark.attrs || {}).some(value => value !== null && value !== "")) {
      context.warnings.add("Markdown 不保留字体、字号、文字颜色和背景色")
    }
  })
}

/** 将可表达的 marks 包成 AST 层级；代码先转换 inlineCode，再按统一顺序套链接/强调/删除线。 */
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
    if (type === "link" && isInternalNavigationHref(mark.attrs?.href)) continue
    inline = type === "link" ? { type: "link", url: mark.attrs.href, children: [inline] } : { type: MARK_NODES[type], children: [inline] }
  }
  return inline
}

/** 合并连续同型文字或同属性标记容器，避免 JSON 分片生成连续分隔符影响 Markdown 重新解析。 */
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

/** 图片导出为替代说明/文件名，不输出不可用的会话 URL 或假装 Markdown 携带二进制资源。 */
function getImageText(node, context) {
  const asset = context.assets.find(item => item.id === node.attrs.assetId)
  const fileName = asset?.fileName.split(/[\\/]/).pop()
  const label = node.attrs.alt || fileName || "未命名图片"
  context.warnings.add("图片已转换为文字说明；请使用 Mewoc 文件保留完整图片")
  return { type: "text", value: `[图片：${label}；请使用 Mewoc 文件保留图片]` }
}

/** 记录段落视觉属性损失；GFM 表格可保留列对齐时使用 preserveAlignment 跳过该项提示。 */
function reportParagraphStyle(node, context, preserveAlignment = false) {
  const attrs = node.attrs || {}
  if (attrs.navigationId || attrs.bookmarkName) context.warnings.add("Markdown 不保留文档书签和内部定位锚点")
  if (!preserveAlignment && attrs.textAlign && attrs.textAlign !== "left") context.warnings.add("Markdown 不保留段落对齐")
  if (attrs.firstLineIndent || attrs.leftIndent) context.warnings.add("Markdown 不保留首行缩进和段落缩进")
  if (attrs.lineHeight) context.warnings.add("Markdown 不保留段落行距")
  if (typeof attrs.spaceBefore === "number" || typeof attrs.spaceAfter === "number") context.warnings.add("Markdown 不保留段前、段后间距")
  if (typeof attrs.keepWithNext === "boolean" || typeof attrs.keepTogether === "boolean") context.warnings.add("Markdown 不保留段落同页与段内不分页设置")
}

// 只有单段、无合并且首行全表头的规则表格使用 GFM 表格，其余逐格展开以保留内容。
// 不强行把复杂单元格压成字符串，避免公式、列表或多段内容丢失。
function getTable(node, context) {
  const rows = node.content || []
  if (rows.some(row => row.attrs?.minHeight)) context.warnings.add("Markdown 不保留表格最小行高")
  const columns = rows[0]?.content?.length || 0
  // 除规则行列外，还要求每格单段、首行全表头、无合并且行内内容可安全置于 GFM 表格。
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

/** GFM 只有左/中/右列对齐：居中/靠右显式设置，其余转默认左对齐。 */
function getCellAlignment(cell) {
  const alignment = cell.content[0].attrs?.textAlign
  return ["center", "right"].includes(alignment) ? alignment : null
}

/** 判断序列化后是否仍能安全留在 GFM 单元格；含分隔符/换行的公式或特殊代码需要按格展开。 */
function isTableInline(node) {
  if (node.type === "inlineMath") return !/[|\r\n]/.test(node.attrs.latex)
  if (node.type !== "text" || /[\r\n]/.test(node.text)) return false
  // GFM 的代码/公式序列化不能完整表达这类分隔符组合，保留为正文中的原节点。
  return !node.marks?.some(mark => mark.type === "code") || !/\\\|/.test(node.text)
}

/** 报告单元格视觉/尺寸属性损失，显式等于编辑器默认值的属性不产生多余 warning。 */
function reportCellStyle(cell, context) {
  if (cell.attrs?.colwidth) context.warnings.add("Markdown 不保留表格列宽")
  const attrs = cell.attrs || {}
  if (attrs.backgroundColor || (attrs.verticalAlign && attrs.verticalAlign !== "top") ||
    (attrs.paddingX !== undefined && attrs.paddingX !== null && attrs.paddingX !== 10) ||
    (attrs.paddingY !== undefined && attrs.paddingY !== null && attrs.paddingY !== 8) ||
    (attrs.borderColor && attrs.borderColor.toLowerCase() !== "#d9dbe5") ||
    (attrs.borderWidth !== undefined && attrs.borderWidth !== null && attrs.borderWidth !== 1) ||
    (attrs.borderStyle && attrs.borderStyle !== "solid")) {
    context.warnings.add("Markdown 不保留单元格底色、垂直对齐、内边距和表格边框")
  }
  if (cell.content.some(node => node.attrs?.textAlign === "justify")) context.warnings.add("Markdown 表格不保留两端对齐")
}

/** 复杂表格按实际单元格序号加标签后展开各块，合并跨度写入说明，列表/公式/多段内容继续递归保留。 */
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
