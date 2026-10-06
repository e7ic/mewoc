/**
 * 预格式代码只在原始换行之后分页；读取唯一 PRE/CODE 与高亮片段，不拆源码或创建第二份可编辑视图。
 * 行盒来自扣除旧 widget 后的 PRE 内容区，Range 负责核对逻辑行仍是单一可视行，不能靠字符串行数猜测软换行。
 */
import { analyzeCodeBlockPagination, getContainerPaginationDOM } from "./container-pagination.js"

const EPSILON = 1
const round = value => Math.round(value * 10000) / 10000
const pixel = value => !value || value === "0" ? 0 : /^-?\d+(?:\.\d+)?px$/.test(value) ? Number.parseFloat(value) : NaN
const unsupportedStyle = style => style.direction === "rtl" || style.writingMode && style.writingMode !== "horizontal-tb" ||
  !["", "auto", "1"].includes(style.columnCount) || ["absolute", "fixed"].includes(style.position) ||
  style.transform && style.transform !== "none"

/**
 * 返回 [{pos,start,height,firstLine,lastLine,lineCount}] 或 null；坐标/高度均为无分页装饰的纸面像素。
 * start 从 PRE 内容区开始，padding/border 留给容器外壳预算；最后一个组吸收终止换行的空行，不在 contentEnd 插 widget。
 * scale 是 EditorView 的实际缩放，widgets 的 height 已是纸面像素；旧 block SPAN 只从自然流里扣除一次。
 * 只接受 white-space:pre 的横排文本。RTL、滚动裁切、未知节点或无法核对的 Range 保留完整代码块。
 */
export function measureCodeBlockLines(view, node, pos, { scale = 1, widgets = [] } = {}) {
  const analysis = analyzeCodeBlockPagination(node, pos)
  if (!analysis || !view?.dom || !Number.isFinite(scale) || scale <= 0 || !Array.isArray(widgets) ||
    widgets.some(widget => !widget?.dom?.compareDocumentPosition || !Number.isFinite(widget.height) || widget.height < 0)) return null
  const source = getContainerPaginationDOM(view, node, pos)
  if (!source) return null
  const { dom, contentDOM } = source
  const doc = dom.ownerDocument
  const style = doc.defaultView.getComputedStyle(dom)
  const codeStyle = doc.defaultView.getComputedStyle(contentDOM)
  if (unsupportedStyle(style) || unsupportedStyle(codeStyle) || codeStyle.whiteSpace !== "pre" ||
    style.display && style.display !== "block" || !["", "inline", "block"].includes(codeStyle.display) ||
    style.visibility === "hidden" || codeStyle.visibility === "hidden") return null
  const text = node.textContent
  // 双向重排会使原始逻辑顺序与可视行不同；本批不给未知顺序生成伪断点。
  if (/[\u0590-\u08ff\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)) return null
  const edges = [style.borderTopWidth, style.paddingTop, style.paddingBottom, style.borderBottomWidth].map(pixel)
  if (edges.some(value => !Number.isFinite(value) || value < 0)) return null
  const rootRect = view.dom.getBoundingClientRect()
  const codeRect = dom.getBoundingClientRect()
  const before = element => widgets.reduce((sum, widget) => sum + (element.compareDocumentPosition(widget.dom) & 2 ? widget.height : 0), 0)
  const internal = widgets.reduce((sum, widget) => sum + (dom.contains(widget.dom) ? widget.height : 0), 0)
  // offset/client 高度只用于辨认横向滚动条；使用 Range/PRE 浮点矩形保留非整数行高与页面缩放。
  const scrollbar = dom.offsetHeight && dom.clientHeight ? Math.max(0, dom.offsetHeight - dom.clientHeight - edges[0] - edges[3]) : 0
  if (dom.clientHeight > 0 && dom.scrollHeight > dom.clientHeight + EPSILON) return null
  const start = (codeRect.top - rootRect.top) / scale - before(dom) + edges[0] + edges[1]
  const height = codeRect.height / scale - edges.reduce((sum, edge) => sum + edge, 0) - scrollbar - internal
  const lineHeight = height / analysis.lineCount
  if (!rootRect.width || !codeRect.width || !Number.isFinite(start) || start < -EPSILON ||
    !Number.isFinite(lineHeight) || lineHeight <= 0) return null

  const excluded = new Set(widgets.map(widget => widget.dom))
  const segments = []
  let supported = true
  const visit = element => {
    // PM 为尾换行/空块维护的 trailingBreak 是光标挂载物，不是第二份代码换行或未知 inline 节点。
    if (excluded.has(element) || element.nodeType === 1 && element.matches(".ProseMirror-widget,[data-mewoc-page-gap],br.ProseMirror-trailingBreak")) return
    if (element.nodeType === 3 && element.nodeValue.length) {
      const modelPos = view.posAtDOM(element, 0)
      const relative = modelPos - pos - 1
      if (relative < 0 || text.slice(relative, relative + element.nodeValue.length) !== element.nodeValue) { supported = false; return }
      segments.push({ dom: element, pos: modelPos, text: element.nodeValue })
    } else {
      // 原高亮是 inline SPAN；独立 widget 可跳过，其他挂载/布局类型不能当作源码文字处理。
      if (element !== contentDOM && element.nodeType === 1 &&
        (element.tagName !== "SPAN" || unsupportedStyle(doc.defaultView.getComputedStyle(element)) ||
          !["", "inline"].includes(doc.defaultView.getComputedStyle(element).display))) { supported = false; return }
      for (const child of element.childNodes) visit(child)
    }
  }
  try { visit(contentDOM) } catch { return null }
  segments.sort((a, b) => a.pos - b.pos)
  if (!supported || segments.reduce((sum, segment) => sum + segment.text.length, 0) !== text.length ||
    segments.some((segment, index) => segment.pos !== (index ? segments[index - 1].pos + segments[index - 1].text.length : pos + 1))) return null
  if (!text.length) return [{ pos: pos + 1, start: round(Math.max(0, start)), height: round(height), firstLine: 0, lastLine: 0, lineCount: 1 }]
  const range = doc.createRange()
  if (typeof range.getClientRects !== "function") return null
  const normalize = (rect, element) => {
    const rectHeight = rect.height ?? rect.bottom - rect.top
    if (![rect.top, rect.bottom, rectHeight].every(Number.isFinite) || rectHeight <= 0) return null
    const shift = before(element)
    return { top: (rect.top - rootRect.top) / scale - shift, bottom: (rect.bottom - rootRect.top) / scale - shift }
  }
  let segmentIndex = 0
  try {
    for (const group of analysis.groups) {
      const relative = group.pos - pos - 1
      const raw = text.slice(relative, relative + group.nodeSize)
      const body = raw.replace(/(?:\r\n|\r|\n)$/, "")
      // 空逻辑行仍用原换行字符的矩形核对；终止换行后的尾空行已归并，不能另造一个模型位置。
      const end = group.pos + (body.length || raw.length)
      const boxes = []
      while (segments[segmentIndex]?.pos + segments[segmentIndex].text.length <= group.pos) segmentIndex += 1
      for (let index = segmentIndex; index < segments.length && segments[index].pos < end; index += 1) {
        const segment = segments[index]
        range.setStart(segment.dom, Math.max(0, group.pos - segment.pos))
        range.setEnd(segment.dom, Math.min(segment.text.length, end - segment.pos))
        boxes.push(...[...range.getClientRects()].map(rect => normalize(rect, segment.dom)).filter(Boolean))
      }
      if (!boxes.length && /^\s*$/.test(raw)) {
        const element = segments[segmentIndex]?.dom
        if (!element) return null
        const caret = normalize(view.coordsAtPos(group.pos, 1), element)
        if (caret) boxes.push(caret)
      }
      const top = start + group.firstLine * lineHeight
      const bottom = top + lineHeight
      if (!boxes.length || boxes.some(box => box.top < top - EPSILON || box.bottom > bottom + EPSILON)) return null
    }
  } catch { return null }
  return analysis.groups.map(group => ({ pos: group.pos, start: round(Math.max(0, start + group.firstLine * lineHeight)),
    height: round((group.lastLine - group.firstLine + 1) * lineHeight), firstLine: group.firstLine, lastLine: group.lastLine, lineCount: analysis.lineCount }))
}
