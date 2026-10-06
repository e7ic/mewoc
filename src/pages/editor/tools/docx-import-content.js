/**
 * DOCX HTML 到业务 JSON 的显式映射器：只接收支持的标签、资源键和公式占位符。
 * 结合 XML 段落元信息恢复标题/列表，并验证合并表格，避免 HTML 容错掩盖内容缺失。
 */
import { isSafeLink } from "./document-schema.js"

import { createDocxLists } from "./docx-import-lists.js"

// 标签只用于语义标记映射，不复制 Word 的任意 HTML/CSS；BLOCKS 区分独立块与段内内容。
const MARKS = { strong: "bold", b: "bold", em: "italic", i: "italic", u: "underline", s: "strike", del: "strike", code: "code", sup: "superscript", sub: "subscript" }
const BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "table", "pre", "hr"])

// HTML 只进入不执行脚本、无资源加载器的临时 DOM，再显式构造业务 JSON；不调用 innerHTML 注入编辑页。
export function createDocxImportContent(html, images, paragraphs, formulas, warnings) {
  if (html.length > 2000000) throw new Error("Word 转换内容过大")
  // template 内容保持惰性，图片和外部地址不会因检查 HTML 而发起请求。
  const template = document.createElement("template")
  template.innerHTML = html
  // 对 DOM 的实际规模再次设限；HTML 字符长度较小也可能形成很深的树或大量节点。
  const stack = [[template.content, 0]]
  let count = 0
  while (stack.length) {
    const [node, depth] = stack.pop()
    count += 1
    if (depth > 48 || count > 50000) throw new Error("Word 内容过深或节点过多")
    for (const child of node.childNodes) stack.push([child, depth + 1])
  }
  // 统一段落类由 Mammoth 变换器生成；数量完全相等后才能按源顺序绑定标题/编号属性。
  const nodes = [...template.content.querySelectorAll("p.mewoc-docx-paragraph")]
  if (nodes.length !== paragraphs.length) throw new Error("Word 段落转换未能完整对应")
  const metadata = new WeakMap(nodes.map((node, index) => [node, paragraphs[index]]))
  // 完整标记命中才恢复公式；其余字符串保持文字，随机前缀避免误识别用户正文。
  const formulaMap = new Map(formulas.map(formula => [formula.marker, formula]))
  const prefix = formulas[0]?.marker.split("X")[0]
  const formulaPattern = prefix ? new RegExp(`(${prefix}X\\d+END)`, "g") : null
  const content = getBlocks([...template.content.childNodes], { images, warnings, metadata, formulaMap, formulaPattern })
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] }
}

/**
 * 将同级 DOM 子节点归并为块；散落的行内内容补段落，图片和块公式单独输出。
 * 保留每个源段落的 metadata 分组边界，最后交由列表组装器判断嵌套和续项。
 */
/** 将一个块标签变为一个或多个节点；段内图片/块公式会拆出独立块，文字前后顺序保留。 */
function getBlocks(nodes, context) {
  const groups = []
  let inline = []
  // 只在确有行内内容时提交临时段落，避免纯空白 HTML 意外制造额外块。
  const flush = () => {
    if (inline.length) groups.push({ blocks: [{ type: "paragraph", content: inline }] })
    inline = []
  }
  for (const node of nodes) {
    if (node.nodeType === 3 && !node.textContent.trim()) continue
    if (BLOCKS.has(node.localName)) {
      flush()
      groups.push({ blocks: getBlock(node, context), metadata: context.metadata.get(node) })
    } else {
      for (const child of getInline(node, context)) {
        if (["image", "blockMath"].includes(child.type)) {
          flush()
          groups.push({ blocks: [child] })
        } else inline.push(child)
      }
    }
  }
  flush()
  return createDocxLists(groups, context.warnings)
}

function getBlock(node, context) {
  // Word 样式计算出的标题级别优先于 Mammoth 的统一 p 标签，恢复语义而非原视觉字号。
  const headingLevel = context.metadata.get(node)?.heading
  const name = headingLevel ? `h${headingLevel}` : node.localName
  if (name === "hr") return [{ type: "horizontalRule" }]
  if (name === "table") return [getTable(node, context)]
  // 容许受控 HTML 已含列表，但每项必须满足编辑器 listItem 首块为 paragraph 的约束。
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
  const heading = /^h[1-6]$/.test(name)
  const flush = () => {
    content.push({ type: heading ? "heading" : "paragraph", ...(heading && { attrs: { level: Number(name[1]) } }), content: inline })
    inline = []
  }
  for (const child of [...node.childNodes].flatMap(child => getInline(child, context))) {
    if (["image", "blockMath"].includes(child.type)) {
      if (inline.length) flush()
      content.push(child)
    }
    else inline.push(child)
  }
  if (inline.length || !content.length) flush()
  return content
}

/**
 * 递归累积行内 marks；支持文本/换行/受控图片/公式，未知元素拒绝以防正文被无声跳过。
 * marks 使用新的数组向下传递，使兄弟节点之间的格式不会串联。
 */
function getInline(node, context, marks = []) {
  if (node.nodeType === 3) {
    const parts = context.formulaPattern ? node.textContent.split(context.formulaPattern) : [node.textContent]
    return parts.flatMap(text => {
      const formula = context.formulaMap.get(text)
      return formula ? [{ type: formula.type, attrs: { latex: formula.latex } }] : getText(text, marks)
    })
  }
  if (node.nodeType !== 1) return []
  const name = node.localName
  if (name === "br") return [{ type: "hardBreak" }]
  // src 只允许命中转换阶段创建的内部资源表，无法命中时拒绝，不尝试加载地址补救。
  if (name === "img") {
    const asset = context.images.get(node.getAttribute("src"))
    if (!asset) throw new Error("图片引用缺失，已停止导入")
    return [{ type: "image", attrs: { assetId: asset.id, width: asset.width, height: asset.height, alt: (node.getAttribute("alt") || "").slice(0, 1000) } }]
  }
  if (["script", "style", "iframe", "object", "svg", "math"].includes(name)) throw new Error(`转换结果包含不支持的 ${name} 内容`)
  if (name === "a") {
    const href = node.getAttribute("href")
    // 目录的内部书签只是跳转目标，不能把 _Toc 等内部标识追加成用户正文。
    if (href?.startsWith("#")) {
      context.warnings.add("原文内部书签链接已转为普通文字，不保留目录跳转")
      return [...node.childNodes].flatMap(child => getInline(child, context, marks))
    }
    if (href && isSafeLink(href)) marks = [...marks.filter(mark => mark.type !== "link"), { type: "link", attrs: { href, target: "_blank", rel: "noopener noreferrer" } }]
    else {
      context.warnings.add("书签、相对地址或不安全链接按普通文字保留")
      return [...node.childNodes].flatMap(child => getInline(child, context, marks)).concat(getText(href ? `（${href}）` : "", marks))
    }
  // code 标记与其它字体标记互斥；同类标记先去重，避免 Schema 产生不一致的嵌套。
  } else if (MARKS[name]) {
    const type = MARKS[name]
    // 上下标互斥，内层语义覆盖外层；粗体、链接等兼容标记继续保留。
    const excludes = ["superscript", "subscript"].includes(type) ? ["superscript", "subscript"] : [type]
    marks = type === "code" ? [{ type }] : marks.some(mark => mark.type === "code") ? marks : [...marks.filter(mark => !excludes.includes(mark.type)), { type }]
  } else if (name !== "span") throw new Error(`转换结果包含未知标签 ${name}`)
  return [...node.childNodes].flatMap(child => getInline(child, context, marks))
}

/**
 * 按 rowspan/colspan 建立占位网格，校验跨行边界、重叠、缺格和总规模后再返回 JSON。
 * 网格存占位状态，单元格正文只出现在起始格中，空格补 paragraph 满足 Schema。
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
      // 上一行跨下来的合并格已占列，当前实际单元格必须从下一个空列开始。
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
  // HTML 表格允许不规则布局，编辑器表格要求完整矩形；不能自动补格掩盖原文转换丢失。
  if (!width || grid.some(row => row.length !== width || Array.from({ length: width }, (_, x) => !row[x]).some(Boolean))) throw new Error("表格存在缺失单元格")
  return { type: "table", content }
}

/** 非空文字才创建 text 节点；没有 marks 时省略该字段，避免生成 Schema 不接受的空文本节点。 */
function getText(text, marks = []) {
  return text ? [{ type: "text", text, ...(marks.length ? { marks } : {}) }] : []
}
