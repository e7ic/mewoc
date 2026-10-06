/**
 * 从单一原始段落的 DOM Range 读取视觉行；只返回模型位置与自然流几何，不拆节点或改正文。
 * 旧分页 widget 占用的高度从每个原始文本片段扣除，测量结果不能包含上轮纸间空白。
 */

const EPSILON = 0.01
const round = value => Math.round(value * 10000) / 10000

/** UTF-16 模型位置只能落在完整 grapheme 边界，不能从代理对、组合音符或 ZWJ 表情中间分页。 */
export function paragraphGraphemeBoundaries(text) {
  if (typeof text !== "string") return null
  if (typeof Intl.Segmenter !== "function") return null
  const boundaries = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(item => item.index)
  boundaries.push(text.length)
  return boundaries
}

// 上标、粗体等 marks 可能让同一行出现不同 glyph 高度；按垂直重合聚合，不能按 top 严格相等去重。
function rowScore(rect, row) {
  const overlap = Math.min(rect.bottom, row.bottom) - Math.max(rect.top, row.top)
  const minimumHeight = Math.min(rect.bottom - rect.top, row.bottom - row.top)
  return minimumHeight > 0 ? overlap / minimumHeight : -1
}

function collectRows(fragments) {
  const rows = []
  for (const fragment of fragments.sort((a, b) => a.rect.top - b.rect.top || a.rect.bottom - b.rect.bottom)) {
    let target = null
    let score = 0.45
    for (const row of rows) {
      const candidate = rowScore(fragment.rect, row)
      if (candidate > score) { score = candidate; target = row }
    }
    if (!target) { target = { top: fragment.rect.top, bottom: fragment.rect.bottom, fragments: [] }; rows.push(target) }
    target.top = Math.min(target.top, fragment.rect.top)
    target.bottom = Math.max(target.bottom, fragment.rect.bottom)
    target.fragments.push(fragment)
  }
  return rows.sort((a, b) => a.top - b.top)
}

function rowIndex(rect, rows) {
  let result = -1
  let score = 0.45
  let distance = Infinity
  rows.forEach((row, index) => {
    const candidate = rowScore(rect, row)
    const centerDistance = Math.abs(rect.top + rect.bottom - row.top - row.bottom)
    if (candidate > score || candidate === score && centerDistance < distance) {
      score = candidate; distance = centerDistance; result = index
    }
  })
  return result
}

/**
 * 支持 paragraph/heading 的普通横向文本与 hardBreak；嵌套测量需显式 nested，且由调用者核对容器边界。
 * keepTogether、inline atom、RTL 或未知布局返回 null。
 * scale 是编辑纸面的实际 transform 比例；widgets 为当前屏幕装饰的 {dom,height}，height 已还原为纸面像素。
 * 每行返回 {pos,start,height}：pos 是原模型完整字符/硬换行边界，start 相对整个 EditorView 的无装饰自然流。
 * Range glyph box 不是 CSS 行盒：相邻 glyph 空白各分一半给前后行，首尾 leading 由真实段落总高兜住。
 */
export function measureParagraphLines(view, node, pos, { scale = 1, widgets = [], nested = false } = {}) {
  if (!view?.dom || !node?.isTextblock || !["paragraph", "heading"].includes(node.type.name) || node.attrs.keepTogether === true ||
    !Number.isSafeInteger(pos) || pos < 0 || !Number.isFinite(scale) || scale <= 0 || !Array.isArray(widgets)) return null
  const dom = view.nodeDOM(pos)
  if (!dom || !/^(P|H[1-6])$/.test(dom.tagName) || (!nested && dom.parentElement !== view.dom) || !view.dom.contains(dom)) return null
  const doc = dom.ownerDocument
  const style = doc.defaultView.getComputedStyle(dom)
  if (style.direction === "rtl" || style.writingMode && style.writingMode !== "horizontal-tb" ||
    style.display && style.display !== "block" || !["", "auto", "1"].includes(style.columnCount) ||
    ["absolute", "fixed"].includes(style.position)) return null
  if (widgets.some(widget => !widget?.dom?.compareDocumentPosition || !Number.isFinite(widget.height) || widget.height < 0)) return null
  const rootRect = view.dom.getBoundingClientRect()
  const paragraphRect = dom.getBoundingClientRect()
  const previousHeight = element => widgets.reduce((sum, widget) => sum + (element.compareDocumentPosition(widget.dom) & 2 ? widget.height : 0), 0)
  const naturalTop = (paragraphRect.top - rootRect.top) / scale - previousHeight(dom)
  const naturalHeight = paragraphRect.height / scale - widgets.reduce((sum, widget) => sum + (dom.contains(widget.dom) ? widget.height : 0), 0)
  if (!Number.isFinite(naturalTop) || naturalTop < -EPSILON || !Number.isFinite(naturalHeight) || naturalHeight <= 0 || !rootRect.width) return null
  const normalizeRect = (rect, source) => {
    const height = rect.height ?? rect.bottom - rect.top
    if (![rect.top, rect.bottom, height].every(Number.isFinite) || height <= 0) return null
    const offset = previousHeight(source)
    return { top: (rect.top - rootRect.top) / scale - offset, bottom: (rect.bottom - rootRect.top) / scale - offset }
  }

  const text = node.textBetween(0, node.content.size, "", "\n")
  // 浏览器 bidi 重排使模型顺序与视觉行顺序不同；本批保留整段，不能从猜测的逻辑位置插空白。
  if (/[\u0590-\u08ff\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)) return null
  const graphemes = paragraphGraphemeBoundaries(text)
  if (!graphemes || text.length !== node.content.size) return null
  const hardBreaks = []
  let textSize = 0
  let supported = true
  node.forEach((child, offset) => {
    if (child.isText) {
      textSize += child.text.length
      // 模型 hardBreak 提供可靠空行 token；未知 text 内换行的折叠方式不在本批猜测。
      if (/[\r\n]/.test(child.text)) supported = false
    } else if (child.type.name === "hardBreak") hardBreaks.push({ pos: pos + 1 + offset })
    else supported = false
  })
  if (!supported) return null

  const segments = []
  const excluded = new Set(widgets.map(widget => widget.dom))
  const visit = element => {
    // 可见空格/制表符的 inline Decoration 包住真实文字，必须保留；只跳过独立 widget，不能按标记属性全删。
    if (excluded.has(element) || element.nodeType === 1 && element.matches(".ProseMirror-widget,[data-mewoc-page-gap]")) return
    if (element.nodeType === 3 && element.nodeValue.length) {
      const modelPos = view.posAtDOM(element, 0)
      const relative = modelPos - pos - 1
      if (relative < 0 || relative + element.nodeValue.length > node.content.size ||
        node.textBetween(relative, relative + element.nodeValue.length, "", "\n") !== element.nodeValue) { supported = false; return }
      segments.push({ dom: element, pos: modelPos, text: element.nodeValue })
    } else for (const child of element.childNodes) visit(child)
  }
  try { visit(dom) } catch { return null }
  segments.sort((a, b) => a.pos - b.pos)
  if (!supported || segments.reduce((sum, segment) => sum + segment.text.length, 0) !== textSize ||
    segments.some((segment, index) => index > 0 && segment.pos < segments[index - 1].pos + segments[index - 1].text.length)) return null

  const range = doc.createRange()
  if (typeof range.getClientRects !== "function") return null
  const fragments = []
  try {
    for (const segment of segments) {
      range.selectNodeContents(segment.dom)
      const rects = [...range.getClientRects()].map(rect => normalizeRect(rect, segment.dom)).filter(Boolean)
      if (!rects.length && !/^\s*$/.test(segment.text)) return null
      segment.boundaries = paragraphGraphemeBoundaries(segment.text)
      rects.forEach(rect => fragments.push({ rect, segment }))
    }
    for (const item of hardBreaks) {
      const source = view.nodeDOM(item.pos)
      if (!source || source.tagName !== "BR" || !dom.contains(source)) return null
      const rect = normalizeRect(source.getBoundingClientRect(), source) || normalizeRect(view.coordsAtPos(item.pos, -1), source)
      if (!rect) return null
      fragments.push({ rect, pos: item.pos })
    }
    // 尾部 hardBreak 后还有一个空行；使用 PM 已维护的 trailingBreak/caret，不能把它写成第二个正文换行。
    if (node.lastChild?.type.name === "hardBreak") {
      const trailing = dom.querySelector("br.ProseMirror-trailingBreak")
      if (!trailing) return null
      const endPos = pos + node.nodeSize - 1
      const rect = normalizeRect(trailing.getBoundingClientRect(), trailing) || normalizeRect(view.coordsAtPos(endPos, 1), trailing)
      if (!rect) return null
      fragments.push({ rect, pos: endPos })
    }
  } catch { return null }
  if (!fragments.length) return [{ pos: pos + 1, start: round(Math.max(0, naturalTop)), height: round(naturalHeight) }]
  const rows = collectRows(fragments)

  // 整个文本节点一次读取所有视觉行，再对各行二分找首 grapheme；不是逐 code unit 强制布局。
  const firstPosition = (segment, target) => {
    const count = segment.boundaries.length - 1
    const indexAt = index => {
      range.setStart(segment.dom, segment.boundaries[index])
      range.setEnd(segment.dom, segment.boundaries[index + 1])
      let rects = [...range.getClientRects()].map(rect => normalizeRect(rect, segment.dom)).filter(Boolean)
      if (!rects.length) {
        // 折叠空格可能没有自己的矩形；前缀末个矩形保留它位于前行还是后行的可读证据。
        range.setStart(segment.dom, 0)
        rects = [...range.getClientRects()].map(rect => normalizeRect(rect, segment.dom)).filter(Boolean).slice(-1)
      }
      if (!rects.length) return -1
      const indices = rects.map(rect => rowIndex(rect, rows))
      return indices.every(index => index === indices[0]) ? indices[0] : null
    }
    let low = 0
    let high = count
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const index = indexAt(middle)
      if (index === null) return null
      if (index >= target) high = middle
      else low = middle + 1
    }
    return low < count && indexAt(low) === target ? segment.pos + segment.boundaries[low] : null
  }
  const positions = []
  try {
    for (const [index, row] of rows.entries()) {
      const candidates = row.fragments.filter(fragment => Number.isInteger(fragment.pos)).map(fragment => fragment.pos)
      for (const segment of new Set(row.fragments.map(fragment => fragment.segment).filter(Boolean))) {
        const candidate = firstPosition(segment, index)
        if (candidate === null) return null
        candidates.push(candidate)
      }
      if (!candidates.length) return null
      const relative = Math.min(...candidates) - pos - 1
      // marks/widget 会把 DOM Text 拆段；向前收口到全段 grapheme 边界，仍不切开跨 mark 的组合字符。
      let low = 0; let high = graphemes.length
      while (low < high) { const middle = Math.floor((low + high) / 2); if (graphemes[middle] <= relative) low = middle + 1; else high = middle }
      positions.push(pos + 1 + graphemes[Math.max(0, low - 1)])
    }
  } catch { return null }
  positions[0] = pos + 1
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) return null
  const starts = rows.map((row, index) => index === 0 ? naturalTop : (rows[index - 1].bottom + row.top) / 2)
  const bottom = naturalTop + naturalHeight
  if (starts.some((start, index) => !Number.isFinite(start) || start < naturalTop - EPSILON || start >= bottom || index > 0 && start <= starts[index - 1])) return null
  // 在 contentEnd 插 widget 会与 PM 维护的 trailingBreak 再造空行；尾部空行并入前组，只在真实内部位置分页。
  if (positions.length > 1 && positions.at(-1) === pos + node.nodeSize - 1) { positions.pop(); starts.pop() }
  return starts.map((start, index) => ({ pos: positions[index], start: round(Math.max(0, start)), height: round((starts[index + 1] ?? bottom) - start) }))
}
