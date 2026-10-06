/**
 * Markdown 导入的语义适配层：读取 remark AST，构造编辑器支持的节点与标记。
 * 先收集定义再转换，无法原样表达的 HTML、资源、脚注或格式保留为文字并返回说明。
 */
import { isSafeLink } from "./document-schema.js"
import { getFormulaSourceError } from "./formula.js"

// Markdown 强调节点映射到编辑器 marks；链接、代码与公式使用独立规则处理。
const MARKDOWN_MARKS = new Map([["strong", "bold"], ["emphasis", "italic"], ["delete", "strike"]])

/**
 * 将 Markdown AST 转为受支持的 Tiptap JSON，转换损失通过去重 warnings 明确返回。
 * 先扫描整棵树收集引用链接定义并限制结构规模，再转换正文，支持定义位于引用之后。
 * 图片保留说明与地址、HTML 保留源码文字；此流程不会请求外部资源。
 */
export function createMarkdownContent(tree) {
  const warnings = new Set()
  const definitions = new Map()
  let count = 0
  // 引用定义允许出现在正文之后，预扫描先建索引；大小写折叠且首个定义优先，符合引用解析规则。
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

/** 扁平化块转换结果，支持一个源块（如脚注定义）展开为多个编辑器段落。 */
/** 按块语义生成 JSON；定义节点只供引用查找，未知类型必须报错，不能丢弃正文后继续导入。 */
function getMarkdownBlocks(nodes, context) {
  return nodes.flatMap(node => getMarkdownBlock(node, context))
}

function getMarkdownBlock(node, context) {
  const { warnings } = context
  if (node.type === "definition") return []
  if (node.type === "paragraph") return [{ type: "paragraph", content: getMarkdownInline(node.children, context) }]
  if (node.type === "heading") {
    return [{ type: "heading", attrs: { level: node.depth }, content: getMarkdownInline(node.children, context) }]
  }
  if (node.type === "blockquote") {
    const content = getMarkdownBlocks(node.children, context)
    return [{ type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] }]
  }
  if (node.type === "thematicBreak") return [{ type: "horizontalRule" }]
  // 围栏语言保留为属性，过长语言降为纯文本；附加 meta 无编辑器对应项但源码不受影响。
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
  if (node.type === "list") return getMarkdownLists(node, context)
  if (node.type === "table") return [getMarkdownTable(node, context)]
  // 脚注不生成隐藏引用体系，而是在当前位置保留带标识的说明和完整正文块。
  if (node.type === "footnoteDefinition") {
    warnings.add("脚注已转换为带编号的普通文字")
    return [{ type: "paragraph", content: getText(`[^${node.label || node.identifier}]：`) }, ...getMarkdownBlocks(node.children, context)]
  }
  throw new Error(`暂不支持 Markdown 节点：${node.type}`)
}

/**
 * GFM 允许同一列表混排普通项和任务项；编辑器分别使用 listItem / taskItem。
 * 按连续类型拆成相邻列表，保留正文顺序、勾选状态与嵌套，不把普通项误转为未完成任务。
 */
function getMarkdownLists(node, context) {
  if (node.ordered && node.start === 0) context.warnings.add("从 0 开始的有序列表已改为从 1 开始")
  const lists = []
  node.children.forEach((item, index) => {
    const task = typeof item.checked === "boolean"
    const type = task ? "taskList" : node.ordered ? "orderedList" : "bulletList"
    if (task && node.ordered) context.warnings.add("带编号的任务项已转换为待办清单，保留勾选状态，普通列表项继续保留原编号")
    if (lists.at(-1)?.type !== type) lists.push({
      type, ...(type === "orderedList" && { attrs: { start: (node.start || 1) + index } }), content: []
    })
    const blocks = getMarkdownBlocks(item.children, context)
    // 两种列表项均以段落开头，代码/公式开头需补空段落才能载入。
    if (blocks[0]?.type !== "paragraph") blocks.unshift({ type: "paragraph", content: [] })
    lists.at(-1).content.push({ type: task ? "taskItem" : "listItem", ...(task && { attrs: { checked: item.checked } }), content: blocks })
  })
  return lists
}

// GFM 首行映射表头，各行补齐至最大列数；对齐写入单元格内段落，符合编辑器属性归属。
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

/**
 * 递归传播行内 marks，遇到代码使用互斥 code 标记，图片与不支持 HTML 保留为显式文字。
 * 输出只含编辑器支持的行内节点，外部地址不会触发资源请求。
 */
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

/** 解析直接/引用链接，仅安全协议创建 link mark；其它地址附在正文后以保留用户原输入。 */
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

// 空/超长公式无法作为公式节点入库，转成含分隔符的文字以保留用户源码。
function getMarkdownFormula(latex, inline, context, marks = []) {
  if (getFormulaSourceError(latex)) {
    context.warnings.add("空公式或超长公式已保留为带美元分隔符的文字")
    const text = getText(inline ? `$${latex}$` : `$$\n${latex}\n$$`, marks)
    return inline ? text : [{ type: "paragraph", content: text }]
  }
  return [{ type: inline ? "inlineMath" : "blockMath", attrs: { latex }, ...(marks.length ? { marks } : {}) }]
}

/** 仅为非空源码创建文字节点，已有 marks 原样附上，空字符串不生成非法空 text 节点。 */
function getText(value, marks = []) {
  return value ? [{ type: "text", text: value, ...(marks.length ? { marks } : {}) }] : []
}
