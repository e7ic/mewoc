/**
 * 屏幕分页的纯排版器。输入来自真实 DOM 的块尺寸，输出只用于编辑视图，不进入文档 JSON。
 * 段落在真实行边界、源码在原换行、列表与容器在安全首叶边界换页；表格保留完整 rowspan 行组。
 * 不能安全拆分的块或行组独占展开页，保留全部内容，并明确区别于打印物理页。
 */
export const DEFAULT_PAGINATION_SETTINGS = Object.freeze({
  enabled: false, pageHeightPx: 297 * 96 / 25.4,
  marginTopPx: 20 * 96 / 25.4, marginBottomPx: 20 * 96 / 25.4, gapPx: 24
})

const SETTINGS_KEYS = Object.keys(DEFAULT_PAGINATION_SETTINGS)
const EPSILON = 0.1

/** 完整几何必须有效；命令可先与当前设置合并，再调用此函数验证。 */
export function normalizePaginationSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Reflect.ownKeys(value).some(key => !SETTINGS_KEYS.includes(key)) || typeof value.enabled !== "boolean" ||
    !SETTINGS_KEYS.slice(1).every(key => Number.isFinite(value[key]) && value[key] >= 0) ||
    value.pageHeightPx <= value.marginTopPx + value.marginBottomPx) {
    throw new Error("自动分页尺寸无效")
  }
  return Object.fromEntries(SETTINGS_KEYS.map(key => [key, value[key]]))
}

export function emptyPaginationLayout() {
  return { pages: [], pageCount: 0, overflowCount: 0, contentHeight: 0, status: "disabled", breaks: [], placements: [], constraintCount: 0 }
}

/**
 * 每个块包含 {pos,nodeSize,height,marginTop,marginBottom,type,keepWithNext}。
 * 可选 start 为去除旧分页空隙后的真实自然流坐标；用于保留浏览器 used-margin，避免小数间距累计漂移。
 * 表格行组额外携带 table={pos,firstRow,columns,headerRows,headerHeight}。
 * 段落行额外携带 paragraph={pos,firstLine,lastLine,lineCount}；首行仍在段落外换页，续行在字符位置插屏幕空隙。
 * code 使用同形行元数据但只在原换行后插空隙；可选 boundary={pos,kind:list|block} 把首叶断点提升到合法外壳。
 * headerRows 为原始连续表头行的绝对位置，重复表头只存在于视图装饰中，不添加持久行。
 * height 为 border-box，两个 margin 单独计入；首项默认顶部空白由正文 CSS 决定，显式段前距必须保留。
 * pageBreak 不占正文高度，首尾及连续分页符仍各自产生一页，不能悄悄吞掉用户边界。
 */
export function planPagePagination(input, options, renderedBreaks = []) {
  const settings = normalizePaginationSettings(options)
  if (!settings.enabled) return emptyPaginationLayout()
  if (!Array.isArray(input)) throw new Error("分页块尺寸无效")
  let naturalCursor = 0
  const blocks = input.map(block => {
    if (!block || !Number.isInteger(block.pos) || block.pos < 0 || !Number.isInteger(block.nodeSize) || block.nodeSize < 1 ||
      ![block.height, block.marginTop ?? 0, block.marginBottom ?? 0].every(value => Number.isFinite(value) && value >= 0) ||
      (block.start !== undefined && (!Number.isFinite(block.start) || block.start < 0))) {
      throw new Error("分页块尺寸无效")
    }
    if (block.minimumGap !== undefined && (!Number.isFinite(block.minimumGap) || block.minimumGap < 0)) throw new Error("分页块尺寸无效")
    if (block.boundary !== undefined && (!block.boundary || typeof block.boundary !== "object" || Array.isArray(block.boundary)
      || !Number.isInteger(block.boundary.pos) || block.boundary.pos < 0 || block.boundary.pos > block.pos
      || !["list", "block"].includes(block.boundary.kind))) throw new Error("分页容器边界无效")
    if (block.table !== undefined) {
      const table = block.table
      if (!table || typeof table !== "object" || Array.isArray(table)
        || !Number.isInteger(table.pos) || table.pos < 0
        || !Number.isInteger(table.firstRow) || table.firstRow < 0
        || !Number.isInteger(table.columns) || table.columns < 1
        || !Array.isArray(table.headerRows) || !table.headerRows.every(pos => Number.isInteger(pos) && pos >= 0)
        || !Number.isFinite(table.headerHeight) || table.headerHeight < 0) throw new Error("分页表格行组无效")
    }
    if (block.paragraph !== undefined) {
      const paragraph = block.paragraph
      if (!paragraph || typeof paragraph !== "object" || Array.isArray(paragraph)
        || !Number.isInteger(paragraph.pos) || paragraph.pos < 0
        || !Number.isInteger(paragraph.lineCount) || paragraph.lineCount < 1
        || !Number.isInteger(paragraph.firstLine) || paragraph.firstLine < 0
        || !Number.isInteger(paragraph.lastLine) || paragraph.lastLine < paragraph.firstLine
        || paragraph.lastLine >= paragraph.lineCount || block.table || block.code
        || (paragraph.firstLine === 0 ? block.pos !== paragraph.pos : block.pos <= paragraph.pos)) {
        throw new Error("分页段落行无效")
      }
    }
    if (block.code !== undefined) {
      const code = block.code
      if (!code || typeof code !== "object" || Array.isArray(code)
        || !Number.isInteger(code.pos) || code.pos < 0
        || !Number.isInteger(code.lineCount) || code.lineCount < 1
        || !Number.isInteger(code.firstLine) || code.firstLine < 0
        || !Number.isInteger(code.lastLine) || code.lastLine < code.firstLine
        || code.lastLine >= code.lineCount || block.table || block.paragraph
        || (code.firstLine === 0 ? block.pos !== code.pos : block.pos <= code.pos)) throw new Error("分页代码行无效")
    }
    const marginTop = block.marginTop || 0
    const marginBottom = block.marginBottom || 0
    const start = block.start ?? naturalCursor + marginTop
    naturalCursor = start + block.height + marginBottom
    return { ...block, marginTop, marginBottom, start }
  })
  const { pageHeightPx, marginTopPx, marginBottomPx, gapPx } = settings
  const available = pageHeightPx - marginTopPx - marginBottomPx
  const pages = [{ index: 0, top: 0, height: pageHeightPx, overflow: false }]
  const breaks = []
  const placements = []
  let page = pages[0]
  let insertedHeight = 0
  let hasContent = false
  let constraintCount = 0

  // 与下段同页按完整相邻链判断。无法放进标准页的链回退到逐块排版，报告约束未满足。
  const groups = new Map()
  for (let index = 0; index < blocks.length;) {
    const start = index
    while (index < blocks.length && blocks[index].type !== "pageBreak") {
      const block = blocks[index]
      index += 1
      if (!block.keepWithNext || blocks[index]?.type === "pageBreak") break
    }
    if (index - start > 1) {
      const first = blocks[start]
      const last = blocks[index - 1]
      const span = last.start + last.height + last.marginBottom - first.start
      if (first.marginTop + span > available + EPSILON) constraintCount += 1
      else groups.set(start, span)
    }
    if (index === start) index += 1
  }

  const rendered = new Map(renderedBreaks.map(item => [`${item.pos}:${item.pageIndex}`, item]))
  const nextPage = (pos, reason, currentTop, blockMarginTop = 0, height = pageHeightPx, overflow = false, boundary = null, minimumGap = 0, tailHeight = 0) => {
    const top = page.top + page.height + gapPx
    // 表内新页的正文行位于重复表头下方。装饰总高同时预算页尾、纸间距、页顶与表头。
    // 原表首行移动时始终使用顶层断点，不重复仍在正文中的原始表头。
    const nextCursor = top + marginTopPx + blockMarginTop + (boundary?.headerHeight || 0)
    // inline spacer 自己占一条空行。零边距/很大字号时至少保留父级 strut 行高，余量留在续页顶部，避免反复追逐不可实现的 0px 高度。
    const targetHeight = Math.max(0, nextCursor - currentTop, minimumGap)
    // 极大 strut 所需的顶部余量也属于正文预算。续行本身装不下时完整展开该页，不能把它推到下一页页脚之外。
    if (minimumGap > 0) {
      const requiredHeight = currentTop + targetHeight - top + tailHeight
      if (requiredHeight > height + EPSILON) { height = requiredHeight; overflow = true }
    }
    page = { index: pages.length, top, height, overflow }
    pages.push(page)
    const previous = rendered.get(`${pos}:${page.index}`)
    const observed = previous && Number.isFinite(previous.actualHeight) && previous.actualHeight >= 0 && Number.isFinite(previous.height)
    // 使用当前浏览器已经实现的高度；每个页面重新校准误差，不假设任何引擎的布局单位。
    const reuse = observed && Math.abs(previous.actualHeight - targetHeight) <= EPSILON
    const gapHeight = reuse ? previous.height : Math.max(0, targetHeight + (observed ? previous.height - previous.actualHeight : 0))
    insertedHeight += reuse ? previous.actualHeight : targetHeight
    breaks.push({ pos, height: gapHeight, pageIndex: page.index, reason, ...(boundary || {}) })
    hasContent = false
  }

  // 原表第一行前的空隙应插在整个 table 之前，表内行前的空隙则由跨列 tr 承载。
  // 重复表头不能挤掉完整行组；装不下时只省略本页表头，原始表头仍完整保留在正文中。
  const blockBoundary = (block, oversized) => {
    const table = block.table
    const outer = () => block.boundary ? { pos: block.boundary.pos,
      tableBreak: block.boundary.kind === "list" ? { listPagination: true } : { containerPagination: true } }
      : { pos: block.pos, tableBreak: null }
    if (!table) {
      if (block.paragraph?.firstLine > 0) return { pos: block.pos, tableBreak: { paragraphPos: block.paragraph.pos, paragraphLine: block.paragraph.firstLine } }
      if (block.code?.firstLine > 0) return { pos: block.pos, tableBreak: { codePos: block.code.pos, codeLine: block.code.firstLine } }
      return outer()
    }
    if (table.firstRow === 0) return block.boundary ? outer() : { pos: table.pos, tableBreak: null }
    const repeat = !oversized && table.headerRows.length > 0 && table.firstRow >= table.headerRows.length
      && table.headerHeight + block.marginTop + block.height + block.marginBottom <= available + EPSILON
    return {
      pos: block.pos,
      tableBreak: { tablePos: table.pos, columns: table.columns, headerRows: [...table.headerRows], headerHeight: repeat ? table.headerHeight : 0 }
    }
  }

  blocks.forEach((block, index) => {
    let currentTop = marginTopPx + block.start + insertedHeight
    if (block.type === "pageBreak") {
      placements.push({ pos: block.pos, pageIndex: page.index, top: currentTop, height: 0, type: block.type })
      nextPage(block.pos + block.nodeSize, "manual", currentTop)
      return
    }
    const outerHeight = block.marginTop + block.height + block.marginBottom
    const oversized = outerHeight > available + EPSILON
    const boundary = blockBoundary(block, oversized)
    const minimumGap = block.paragraph?.firstLine > 0 ? block.minimumGap || 0 : 0
    const tailHeight = block.height + block.marginBottom + marginBottomPx
    if (oversized) {
      const expandedHeight = marginTopPx + outerHeight + marginBottomPx
      if (hasContent || page.overflow) nextPage(boundary.pos, "overflow", currentTop, block.marginTop, expandedHeight, true, boundary.tableBreak, minimumGap, tailHeight)
      else { page.height = Math.max(expandedHeight, currentTop - page.top + block.height + block.marginBottom + marginBottomPx); page.overflow = true }
    } else {
      const requiredHeight = groups.get(index) ?? block.height + block.marginBottom
      const end = page.top + page.height - marginBottomPx
      if (page.overflow || (hasContent && currentTop + requiredHeight > end + EPSILON)) {
        if (groups.has(index) && minimumGap > 0) {
          const nextTop = page.top + page.height + gapPx
          const requestedGap = Math.max(0, nextTop + marginTopPx + block.marginTop - currentTop)
          const extraTop = Math.max(0, minimumGap - requestedGap)
          // 同页链原本可以放入标准页，最小 strut 新增的留白仍可能使它失效；退化必须如实计数。
          if (block.marginTop + requiredHeight + extraTop > available + EPSILON) constraintCount += 1
        }
        nextPage(boundary.pos, "automatic", currentTop, block.marginTop, pageHeightPx, false, boundary.tableBreak, minimumGap, tailHeight)
      }
    }
    currentTop = marginTopPx + block.start + insertedHeight
    placements.push({ pos: block.pos, pageIndex: page.index, top: currentTop, height: block.height, type: block.type })
    hasContent = true
  })
  const overflowCount = pages.filter(item => item.overflow).length
  return {
    pages, pageCount: pages.length, overflowCount,
    contentHeight: Math.max(0, naturalCursor + insertedHeight),
    status: overflowCount ? "expanded" : "paginated", breaks, placements, constraintCount
  }
}
