/**
 * 把列表与流式容器展开成只读排版叶子，保留原节点、嵌套关系和唯一 NodeView。
 * 结构分析不估算 DOM 高度；外壳标题/内边距与叶子的真实几何由编辑视图按祖先首尾分配。
 */
import { analyzeTablePagination } from "./table-pagination.js"

export const PAGINATION_CONTAINER_TYPES = Object.freeze([
  "bulletList", "orderedList", "taskList", "listItem", "taskItem", "blockquote", "textBox", "details"
])
const containers = new Set(PAGINATION_CONTAINER_TYPES)
const lists = new Map([["bulletList", "listItem"], ["orderedList", "listItem"], ["taskList", "taskItem"]])
const MAX_DEPTH = 64
const validPosition = (node, pos) => !!node?.type && Number.isSafeInteger(pos) && pos >= 0 && Number.isSafeInteger(pos + node.nodeSize)

/**
 * 返回 {leaves,containers}；每个 leaf 的 ancestors 从外到内，firstLeaf/lastLeaf 指向 leaves 的下标。
 * details 的 expanded 属于视图，必须由 isDetailsExpanded(node,pos) 注入；缺少可靠状态时保留闭合整块。
 * 原子、未知外壳、损坏结构和过深子树成为完整 block leaf；table 只作为安全行组叶子，绝不进入 cell。
 */
export function analyzeContainerPagination(node, pos, { isDetailsExpanded = () => false } = {}) {
  if (!validPosition(node, pos) || !containers.has(node.type.name) || typeof isDetailsExpanded !== "function") return null
  const leaves = []
  const shells = []
  const addLeaf = (current, currentPos, ancestors, kind = "block", extra = {}) => {
    leaves.push({ node: current, pos: currentPos, kind, ancestors: [...ancestors], ...extra })
  }
  const visit = (current, currentPos, ancestors) => {
    if (current.type.spec.tableRole === "table") {
      const table = analyzeTablePagination(current, currentPos)
      addLeaf(current, currentPos, ancestors, table ? "table" : "block", table ? { table } : {})
      return
    }
    if (["paragraph", "heading"].includes(current.type.name)) { addLeaf(current, currentPos, ancestors, "paragraph"); return }
    if (current.type.name === "codeBlock") { addLeaf(current, currentPos, ancestors, "code"); return }
    if (!containers.has(current.type.name) || current.isAtom || ancestors.length >= MAX_DEPTH) { addLeaf(current, currentPos, ancestors); return }
    const parent = ancestors.at(-1)
    const shell = { node: current, pos: currentPos, type: current.type.name, parentPos: parent?.pos ?? null,
      firstLeaf: leaves.length, lastLeaf: leaves.length }
    shells.push(shell)
    const path = [...ancestors, shell]
    let expanded = true
    if (current.type.name === "details") {
      try { expanded = isDetailsExpanded(current, currentPos) === true } catch { expanded = false }
    }
    // schema.validContent 同时检查 item 的首段与允许的 marks；错误网格/未知 NodeView 不能被展平后丢失内容。
    const valid = current.type.validContent(current.content) && current.childCount > 0 &&
      (!lists.has(current.type.name) || current.content.content.every(child => child.type.name === lists.get(current.type.name)))
    if (!expanded || !valid) addLeaf(current, currentPos, path)
    else current.forEach((child, offset) => visit(child, currentPos + 1 + offset, path))
    shell.lastLeaf = leaves.length - 1
  }
  visit(node, pos, [])
  return { leaves, containers: shells }
}

/**
 * 读取已存在的内容挂载点，不重新 renderHTML 或克隆 NodeView；任务复选框、详情按钮只保留原有实例。
 * 仅直接子元素可成为 contentDOM，避免 querySelector 误取嵌套容器的正文；不认识的 DOM 返回 null。
 */
export function getContainerPaginationDOM(view, node, pos) {
  if (!view?.dom || !validPosition(node, pos)) return null
  let dom
  try { dom = view.nodeDOM(pos) } catch { return null }
  if (!dom || dom.nodeType !== 1 || !view.dom.contains(dom)) return null
  const type = node.type.name
  const children = [...dom.children]
  let contentDOM = dom
  let expanded = true
  if (type === "bulletList" && (dom.tagName !== "UL" || dom.dataset.type === "taskList") ||
    type === "orderedList" && dom.tagName !== "OL" ||
    type === "taskList" && (dom.tagName !== "UL" || dom.dataset.type !== "taskList") ||
    type === "blockquote" && dom.tagName !== "BLOCKQUOTE" ||
    type === "textBox" && (dom.tagName !== "DIV" || dom.dataset.type !== "text-box")) return null
  if (type === "listItem") {
    if (dom.tagName !== "LI" || dom.dataset.type === "taskItem") return null
  } else if (type === "taskItem") {
    if (dom.tagName !== "LI" || dom.dataset.type !== "taskItem") return null
    const bodies = children.filter(child => child.tagName === "DIV")
    if (bodies.length !== 1 || !children.some(child => child.tagName === "LABEL")) return null
    contentDOM = bodies[0]
  } else if (type === "details") {
    if (!(dom.tagName === "DETAILS" || dom.tagName === "DIV" && dom.dataset.detailsView === "true")) return null
    const bodies = children.filter(child => child.hasAttribute("data-details-content"))
    if (bodies.length !== 1) return null
    contentDOM = bodies[0]
    expanded = !contentDOM.hidden && (dom.tagName === "DETAILS" ? dom.open : dom.dataset.expanded === "true")
  } else if (type === "codeBlock") {
    if (dom.tagName !== "PRE") return null
    const code = children.filter(child => child.tagName === "CODE")
    if (code.length !== 1) return null
    contentDOM = code[0]
  } else if (!containers.has(type)) return null
  return { dom, contentDOM, expanded }
}

/**
 * 代码源文本按真实换行 token 分组，pos/nodeSize 保留原始 UTF-16 长度，包括 CRLF 的两个 code unit。
 * 不把逻辑行数当作可视高度；调用方须确认 PRE/CODE 保留空白且没有软换行，再用原始 Range/caret 实测。
 * 最后空行没有可承载 widget 的模型内容，并入前组；空代码块仍保留一个完整视图行。
 */
export function analyzeCodeBlockPagination(node, pos) {
  if (!validPosition(node, pos) || node.type.name !== "codeBlock" || !node.isTextblock || !node.type.spec.code ||
    !node.type.validContent(node.content) || node.content.content.some(child => !child.isText)) return null
  const text = node.textContent
  const groups = []
  const pattern = /\r\n|\r|\n/g
  let start = 0
  let line = 0
  let match
  while ((match = pattern.exec(text))) {
    const end = match.index + match[0].length
    groups.push({ firstLine: line, lastLine: line, pos: pos + 1 + start, nodeSize: end - start })
    start = end
    line += 1
  }
  if (start < text.length || !groups.length) groups.push({ firstLine: line, lastLine: line, pos: pos + 1 + start, nodeSize: Math.max(1, text.length - start) })
  else groups.at(-1).lastLine = line
  return { lineCount: line + 1, groups }
}
