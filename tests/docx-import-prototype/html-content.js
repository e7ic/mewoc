/**
 * Node 导入原型的 HTML 白名单映射器：使用独立 JSDOM 读取转换 HTML，并显式构造 JSON。
 * 只识别已声明块/标记与内部图片引用，合并表格需要完整网格，未知内容一律报错。
 */
import { JSDOM } from "jsdom"
import { isSafeLink } from "../../src/pages/editor/tools/document-schema.js"

// 标记和块标签映射为编辑器语义，不复制任意 HTML 属性/CSS，也不依赖浏览器样式表现。
const MARKS = { strong: "bold", b: "bold", em: "italic", i: "italic", u: "underline", s: "strike", del: "strike", code: "code" }
const BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "table", "pre", "hr"])

// HTML 只进入不执行脚本、无资源加载器的临时 DOM，再显式构造业务 JSON；不调用 innerHTML 注入编辑页。
export function createDocxContent(html, images, warnings) {
  if (html.length > 2000000) throw new Error("DOCX 转换内容过大")
  const dom = new JSDOM(html)
  try {
    // 长度、DOM 深度和节点数各自设限，避免短 HTML 形成异常深层或大量业务节点。
    const stack = [[dom.window.document.body, 0]]
    let count = 0
    while (stack.length) {
      const [node, depth] = stack.pop()
      count += 1
      if (depth > 48 || count > 50000) throw new Error("DOCX 内容过深或节点过多")
      for (const child of node.childNodes) stack.push([child, depth + 1])
    }
    const content = getBlocks([...dom.window.document.body.childNodes], { images, warnings })
    return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] }
  // 无论 JSON 成功还是发现未知内容，关闭本次临时 DOM，不留下窗口资源。
  } finally { dom.window.close() }
}

/** 合并同级散落行内内容为段落，图片拆为独立块，原始兄弟顺序保持。 */
/** 识别一个块元素，可将其中混排图片拆成多个 JSON 块；标题级别保留本原型的三级限制。 */
function getBlocks(nodes, context) {
  const result = []
  let inline = []
  // 临时行内数组只在非空时输出段落，提交后清空以免跨块粘连正文。
  const flush = () => {
    if (inline.length) result.push({ type: "paragraph", content: inline })
    inline = []
  }
  for (const node of nodes) {
    if (BLOCKS.has(node.localName)) {
      flush()
      result.push(...getBlock(node, context))
    } else {
      for (const child of getInline(node, context)) {
        if (child.type === "image") {
          flush()
          result.push(child)
        }
        else inline.push(child)
      }
    }
  }
  flush()
  return result
}

function getBlock(node, context) {
  const name = node.localName
  if (name === "hr") return [{ type: "horizontalRule" }]
  if (name === "table") return [getTable(node, context)]
  // 原型直接使用 Mammoth 的列表分组，编号统一从 1 开始；此限制由归档/入口 warnings 说明。
  if (name === "ul" || name === "ol") {
    const content = [...node.children].map(item => {
      if (item.localName !== "li") throw new Error("列表结构无效")
      const content = getBlocks([...item.childNodes], context)
      if (content[0]?.type !== "paragraph") content.unshift({ type: "paragraph" })
      return { type: "listItem", content }
    })
    if (!content.length) return []
    return [{ type: name === "ol" ? "orderedList" : "bulletList", ...(name === "ol" && { attrs: { start: 1, type: "1" } }), content }]
  }
  if (name === "blockquote") return [{ type: "blockquote", content: getBlocks([...node.childNodes], context) }]
  if (name === "pre") return [{ type: "codeBlock", attrs: { language: "plaintext" }, content: getText(node.textContent) }]
  const content = []
  let inline = []
  // 四至六级标题在本原型中降到三级，正式导入的标题级别恢复能力由其它模块验证。
  const heading = /^h[1-6]$/.test(name)
  if (heading && Number(name[1]) > 3) context.warnings.add("四至六级标题已转换为三级标题")
  const flush = () => {
    content.push({ type: heading ? "heading" : "paragraph", ...(heading && { attrs: { level: Math.min(3, Number(name[1])) } }), content: inline })
    inline = []
  }
  for (const child of [...node.childNodes].flatMap(child => getInline(child, context))) {
    if (child.type === "image") {
      if (inline.length) flush()
      content.push(child)
    }
    else inline.push(child)
  }
  if (inline.length || !content.length) flush()
  return content
}

/** 递归收集文字/换行/图片并传递 marks；不支持标签直接拒绝，防止原型漏掉正文语义。 */
function getInline(node, context, marks = []) {
  if (node.nodeType === 3) return getText(node.textContent, marks)
  if (node.nodeType !== 1) return []
  const name = node.localName
  if (name === "br") return [{ type: "hardBreak" }]
  // 图片必须命中之前验过的内嵌资源键，外部地址不会发请求，缺引用不能交付残缺结果。
  if (name === "img") {
    const asset = context.images.get(node.getAttribute("src"))
    if (!asset) throw new Error("图片引用缺失，已停止导入")
    return [{ type: "image", attrs: { assetId: asset.id, width: asset.width, height: asset.height, alt: (node.getAttribute("alt") || "").slice(0, 1000) } }]
  }
  if (["script", "style", "iframe", "object", "svg", "math"].includes(name)) throw new Error(`转换结果包含不支持的 ${name} 内容`)
  // 只有安全完整地址转成链接；书签/相对/危险地址作为普通文字附加，保留用户可见信息。
  if (name === "a") {
    const href = node.getAttribute("href")
    if (href && isSafeLink(href)) marks = [...marks.filter(mark => mark.type !== "link"), { type: "link", attrs: { href, target: "_blank", rel: "noopener noreferrer" } }]
    else {
      context.warnings.add("书签、相对地址或不安全链接按普通文字保留")
      return [...node.childNodes].flatMap(child => getInline(child, context, marks)).concat(getText(href ? `（${href}）` : "", marks))
    }
  // code 与其它文字样式互斥，同类 mark 去重，递归时使用新数组避免影响兄弟节点。
  } else if (MARKS[name]) {
    const type = MARKS[name]
    marks = type === "code" ? [{ type }] : marks.some(mark => mark.type === "code") ? marks : [...marks.filter(mark => mark.type !== type), { type }]
  } else if (!["span", "sup", "sub"].includes(name)) throw new Error(`转换结果包含未知标签 ${name}`)
  if (["sup", "sub"].includes(name)) context.warnings.add("文字上下标按普通文字保留")
  return [...node.childNodes].flatMap(child => getInline(child, context, marks))
}

/**
 * 依据 HTML 合并属性建立逻辑占位网格，检查越界、重叠、缺洞与规模后再返回编辑器表格。
 * 合并正文仅在起始单元格输出，空单元格补 paragraph，Schema 需要完整矩形网格。
 */
function getTable(table, context) {
  const rows = [...table.children].flatMap(node => ["thead", "tbody", "tfoot"].includes(node.localName) ? [...node.children] : [node])
  const grid = rows.map(() => [])
  let width = 0
  let count = 0
  const content = rows.map((row, y) => {
    if (row.localName !== "tr") throw new Error("表格行结构无效")
    let x = 0
    const content = [...row.children].map(cell => {
      if (!["td", "th"].includes(cell.localName)) throw new Error("表格单元格结构无效")
      // 前行纵向合并已经占用的列跳过，当前实体格落在下一个可用逻辑列。
      while (grid[y][x]) x += 1
      const colspan = Number(cell.getAttribute("colspan") || 1)
      const rowspan = Number(cell.getAttribute("rowspan") || 1)
      count += colspan * rowspan
      if (![colspan, rowspan].every(value => Number.isInteger(value) && value >= 1 && value <= 1000) || x + colspan > 1000 || y + rowspan > rows.length || count > 10000) throw new Error("表格合并范围无效或超过 10000 格")
      for (let cy = y; cy < y + rowspan; cy += 1) {
        for (let cx = x; cx < x + colspan; cx += 1) {
          if (grid[cy][cx]) throw new Error("表格合并范围重叠")
          grid[cy][cx] = true
        }
      }
      x += colspan
      width = Math.max(width, x)
      const content = getBlocks([...cell.childNodes], context)
      return { type: cell.localName === "th" ? "tableHeader" : "tableCell", attrs: { colspan, rowspan }, content: content.length ? content : [{ type: "paragraph" }] }
    })
    return { type: "tableRow", content }
  })
  // 不能依赖 HTML 的不规则表格容错，缺格应拒绝而非猜测空内容进行补齐。
  if (!width || grid.some(row => row.length !== width || Array.from({ length: width }, (_, x) => !row[x]).some(Boolean))) throw new Error("表格存在缺失单元格")
  return { type: "table", content }
}

/** 只有非空文本才创建 text 节点，省略无 marks 的字段，避免输出空文字节点。 */
function getText(text, marks = []) {
  return text ? [{ type: "text", text, ...(marks.length ? { marks } : {}) }] : []
}
