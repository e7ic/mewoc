/** 实测正文行、列表、嵌套容器与表格安全行组的屏幕分页，保持单一 EditorView、节点资源与完整撤销历史。 */
import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { DEFAULT_PAGINATION_SETTINGS, emptyPaginationLayout, normalizePaginationSettings, planPagePagination } from "../tools/page-pagination.js"
import { analyzeTablePagination } from "../tools/table-pagination.js"
import { measureParagraphLines } from "../tools/paragraph-pagination.js"
import { PAGINATION_CONTAINER_TYPES, analyzeContainerPagination, getContainerPaginationDOM } from "../tools/container-pagination.js"
import { measureCodeBlockLines } from "../tools/code-pagination.js"

export const PAGE_PAGINATION_KEY = new PluginKey("mewocPagePagination")

export function getPagePagination(editor) {
  return editor && !editor.isDestroyed ? PAGE_PAGINATION_KEY.getState(editor.state)?.layout || emptyPaginationLayout() : emptyPaginationLayout()
}

// 重复表头只是同一张表内的静态屏幕提示；原表头和全部真实单元格始终只有一个 NodeView。
function tableBoundary(doc, pos) {
  const resolved = doc.resolve(pos)
  return resolved.parent.type.spec.tableRole === "table" ? { node: resolved.parent, pos: resolved.before(resolved.depth) } : null
}

function repeatedHeader(view, getPos, index, gap) {
  // widget 的位置会随正文映射，闭包中的旧表格/表头绝对位置不能用于后来重新创建的 DOM。
  const table = tableBoundary(view.state.doc, getPos())
  let headerPos = table.pos + 1
  for (let row = 0; row < index; row += 1) headerPos += table.node.child(row).nodeSize
  const source = view.nodeDOM(headerPos)
  const row = source.cloneNode(true)
  const width = parseFloat(view.dom.ownerDocument.defaultView.getComputedStyle(view.dom).width)
  const scale = width > 0 ? view.dom.getBoundingClientRect().width / width || 1 : 1
  // 净化播放器、勾选框后仍保留原行的纸面高度，避免校准把缩短的表头推离续页顶部。
  row.style.height = `${source.getBoundingClientRect().height / scale}px`
  row.dataset.mewocRepeatHeader = ""
  row.dataset.mewocTablePagination = "header"
  row.dataset.pagePos = String(gap.pos)
  row.dataset.pageIndex = String(gap.pageIndex)
  row.setAttribute("aria-hidden", "true")
  row.setAttribute("inert", "")
  row.contentEditable = "false"
  for (const element of [row, ...row.querySelectorAll("*")]) {
    for (const attr of ["id", "data-navigation-id", "data-bookmark-name", "data-selected", "tabindex", "autofocus", "contenteditable"]) element.removeAttribute(attr)
    element.classList.remove("selectedCell", "ProseMirror-selectednode", "mewoc-focused-paragraph", "find-and-replace-result", "find-and-replace-result-current", "is-editor-empty")
    if (element.tagName === "A") element.removeAttribute("href")
    if (element.tagName === "SUMMARY") element.tabIndex = -1
  }
  // 详情的按钮同时承载持久摘要；转换为静态标题，不能把用户内容当作操作控件删掉。
  row.querySelectorAll("[data-details-toggle]").forEach(toggle => {
    const title = view.dom.ownerDocument.createElement("div")
    title.dataset.detailsToggle = "true"
    title.className = toggle.className
    title.style.cssText = toggle.style.cssText
    toggle.querySelectorAll("[data-details-chevron]").forEach(element => element.remove())
    title.append(...toggle.childNodes)
    toggle.replaceWith(title)
  })
  // 媒体只保留原有文件信息；额外显示长打印提示会在窄列撑高表头，行高声明只是最小值。
  // 播放器、下载按钮和编辑手柄不能成为第二份交互资源。
  row.querySelectorAll("audio,video,button,input,select,textarea,[data-resize-handle],[data-mewoc-format-mark],[data-media-actions],[data-media-error],[data-media-print]").forEach(element => element.remove())
  row.contentEditable = "false"
  return row
}

function gapDecorations(doc, layout, settings) {
  const widgets = []
  for (const gap of layout.breaks) {
    const table = Number.isInteger(gap.tablePos)
    const paragraph = Number.isInteger(gap.paragraphPos)
    const code = Number.isInteger(gap.codePos)
    const list = gap.listPagination === true
    const signature = table ? JSON.stringify((gap.headerRows || []).map(pos => doc.nodeAt(pos)?.toJSON())) : ""
    widgets.push(Decoration.widget(gap.pos, view => {
      const dom = view.dom.ownerDocument.createElement(table ? "tr" : paragraph || code ? "span" : list ? "li" : "div")
      dom.dataset.mewocPageGap = ""
      dom.dataset.pageIndex = String(gap.pageIndex)
      dom.dataset.pagePos = String(gap.pos)
      dom.dataset.pageHeight = String(gap.height)
      const spacerHeight = Math.max(0, gap.height - (gap.headerHeight || 0))
      dom.style.height = `${spacerHeight}px`
      if (paragraph) dom.dataset.mewocParagraphPagination = ""
      if (code) dom.dataset.mewocCodePagination = ""
      if (list || gap.containerPagination) dom.dataset.mewocContainerPagination = list ? "list" : "block"
      if (table) {
        dom.dataset.mewocTablePagination = "gap"
        const cell = dom.appendChild(view.dom.ownerDocument.createElement("td"))
        cell.colSpan = gap.columns
        const spacer = cell.appendChild(view.dom.ownerDocument.createElement("div"))
        spacer.style.height = `${spacerHeight}px`
      }
      dom.setAttribute("aria-hidden", "true")
      dom.contentEditable = "false"
      return dom
    }, { key: `page-${gap.pos}-${gap.pageIndex}-${gap.height}-${gap.headerHeight || 0}-${paragraph}-${code}-${list}-${signature}`, side: -2,
      ...(paragraph || code ? { marks: [] } : {}), paragraphPagination: paragraph, containerPagination: list || code || gap.containerPagination === true,
      tablePagination: table, tablePos: gap.tablePos, ignoreSelection: true, stopEvent: () => true }))
    if (table && gap.headerHeight > 0) gap.headerRows.forEach((_pos, index) => {
      widgets.push(Decoration.widget(gap.pos, (view, getPos) => repeatedHeader(view, getPos, index, gap), {
        key: `header-${gap.pos}-${gap.pageIndex}-${index}-${gap.headerHeight}-${signature}`, side: -1 + index / (gap.headerRows.length + 1),
        tablePagination: true, tablePos: gap.tablePos, ignoreSelection: true, stopEvent: () => true
      }))
    })
  }
  // 仅裁去页脚/纸间留白中的外壳绘制；保留同一容器与内部资源、按钮和选择位置。
  for (const container of layout.containers || []) {
    if (!["blockquote", "textBox", "details", "codeBlock"].includes(container.type)) continue
    if (!layout.breaks.some(gap => gap.pos > container.pos && gap.pos < container.pos + container.nodeSize)) continue
    const polygon = layout.pages.map(page => {
      const top = Math.max(container.top, page.top + settings.marginTopPx)
      const bottom = Math.min(container.top + container.height, page.top + page.height - settings.marginBottomPx)
      if (bottom <= top) return null
      const y = top - container.top; const end = bottom - container.top
      return `-12px ${y}px,calc(100% + 12px) ${y}px,calc(100% + 12px) ${end}px,-12px ${end}px,-12px ${y}px`
    }).filter(Boolean).join(",")
    if (polygon) widgets.push(Decoration.node(container.pos, container.pos + container.nodeSize, {
      "data-mewoc-container-fragment": "", style: `--mewoc-container-clip:polygon(evenodd,${polygon})`
    }, { containerPagination: true }))
  }
  // 当前段落的淡背景也按纸面断开，否则长段落的整块 ::before 会涂满页脚和纸间隙。
  for (const pos of new Set(layout.breaks.filter(gap => Number.isInteger(gap.paragraphPos)).map(gap => gap.paragraphPos))) {
    const node = doc.nodeAt(pos)
    if (!node?.isTextblock) continue
    const lines = (layout.placements || []).filter(line => line.pos >= pos && line.pos < pos + node.nodeSize)
    if (!lines.length) continue
    const fragments = []
    for (const line of lines) {
      const last = fragments.at(-1)
      if (last?.pageIndex === line.pageIndex) last.bottom = line.top + line.height
      else fragments.push({ pageIndex: line.pageIndex, top: line.top, bottom: line.top + line.height })
    }
    const origin = fragments[0].top
    const polygon = fragments.map(fragment => {
      const top = Math.max(0, fragment.top - origin)
      const bottom = fragment.bottom - origin + 10
      return `0 ${top}px,100% ${top}px,100% ${bottom}px,0 ${bottom}px,0 ${top}px`
    }).join(",")
    widgets.push(Decoration.node(pos, pos + node.nodeSize, { style: `--mewoc-paragraph-focus-clip:polygon(evenodd,${polygon})` }, { paragraphPagination: true }))
  }
  return DecorationSet.create(doc, widgets)
}

function measureBlocks(view) {
  const round = value => Math.round(value * 100) / 100
  const style = view.dom.ownerDocument.defaultView.getComputedStyle(view.dom)
  const width = parseFloat(style.width)
  const rect = view.dom.getBoundingClientRect()
  // CSS transform 只改变屏幕坐标；块高必须还原为纸面未缩放尺寸。
  const scale = width > 0 && rect.width > 0 ? rect.width / width : 1
  const widgets = [...view.dom.querySelectorAll("[data-mewoc-page-gap],[data-mewoc-repeat-header]")].map(dom => ({ dom, height: dom.getBoundingClientRect().height / scale }))
  const gapHeight = widgets.reduce((sum, widget) => sum + widget.height, 0)
  const previousHeight = dom => widgets.reduce((sum, widget) => sum + (dom.compareDocumentPosition(widget.dom) & 2 ? widget.height : 0), 0)
  const insideHeight = dom => widgets.reduce((sum, widget) => sum + (dom.contains(widget.dom) ? widget.height : 0), 0)
  const naturalStart = dom => Math.max(0, round((dom.getBoundingClientRect().top - rect.top) / scale - previousHeight(dom)))
  const renderedBreaks = widgets.filter(widget => widget.dom.hasAttribute("data-mewoc-page-gap")).map(({ dom }) => ({
    pos: Number(dom.dataset.pagePos), pageIndex: Number(dom.dataset.pageIndex), height: Number(dom.dataset.pageHeight ?? parseFloat(dom.style.height)),
    actualHeight: widgets.filter(widget => widget.dom.dataset.pagePos === dom.dataset.pagePos && widget.dom.dataset.pageIndex === dom.dataset.pageIndex).reduce((sum, widget) => sum + widget.height, 0)
  }))
  // 直接读取浏览器实现的相邻间距与空隙高度，不能把 computed 0.5pt 声明当作 used-pixel 累加。
  const blocks = []
  const containers = []
  const measureLeaf = (node, pos, ancestors = [], leafIndex = -1) => {
    const dom = view.nodeDOM(pos)
    if (!dom || dom.nodeType !== 1 || dom.closest("[data-details-content][hidden]")) return
    const appearance = view.dom.ownerDocument.defaultView.getComputedStyle(dom)
    const start = naturalStart(dom)
    const height = round(Math.max(0, dom.getBoundingClientRect().height / scale - insideHeight(dom)))
    const manual = node.type.name === "pageBreak"
    const segments = []
    if (["paragraph", "heading"].includes(node.type.name)) {
      const lines = measureParagraphLines(view, node, pos, { scale, widgets, nested: ancestors.length > 0 })
      if (lines?.length > 1) {
        const keepWithNext = node.attrs.keepWithNext ?? node.type.name === "heading"
        lines.forEach((line, index) => segments.push({
          pos: index === 0 ? pos : line.pos, nodeSize: Math.max(1, (lines[index + 1]?.pos ?? pos + node.nodeSize - 1) - line.pos),
          type: node.type.name, start: line.start, height: line.height,
          minimumGap: Number.isFinite(parseFloat(appearance.lineHeight)) ? parseFloat(appearance.lineHeight) : line.height,
          marginTop: index === 0 ? Math.max(0, round(line.start - start + (parseFloat(appearance.marginTop) || 0))) : 0,
          marginBottom: index === lines.length - 1 ? Math.max(0, round(parseFloat(appearance.marginBottom) || 0)) : 0,
          keepWithNext: index === lines.length - 1 ? keepWithNext : node.type.name === "heading" && keepWithNext,
          paragraph: { pos, firstLine: index, lastLine: index, lineCount: lines.length }
        }))
      }
    }
    if (node.type.name === "table") {
      const analysis = analyzeTablePagination(node, pos)
      const rows = []
      node.forEach((_row, offset) => { const rowPos = pos + 1 + offset; rows.push({ pos: rowPos, dom: view.nodeDOM(rowPos) }) })
      if (analysis && rows.every(row => row.dom?.nodeType === 1 && row.dom.tagName === "TR")) {
        const headerRows = analysis.headerRows.map(index => rows[index].pos)
        const headerHeight = headerRows.length ? round((rows[headerRows.length - 1].dom.getBoundingClientRect().bottom - rows[0].dom.getBoundingClientRect().top) / scale - previousHeight(rows[headerRows.length - 1].dom) + previousHeight(rows[0].dom)) : 0
        analysis.groups.forEach((group, index) => {
          const first = rows[group.firstRow].dom; const last = rows[group.lastRow].dom
          const groupStart = naturalStart(first)
          const groupHeight = round((last.getBoundingClientRect().bottom - first.getBoundingClientRect().top) / scale - previousHeight(last) + previousHeight(first))
          segments.push({
            pos: group.pos, nodeSize: group.nodeSize, type: "tableRow", start: groupStart, height: Math.max(0, groupHeight),
            marginTop: index === 0 ? Math.max(0, round(groupStart - start + (parseFloat(appearance.marginTop) || 0))) : 0,
            marginBottom: index === analysis.groups.length - 1 ? Math.max(0, round(start + height - groupStart - groupHeight + (parseFloat(appearance.marginBottom) || 0))) : 0,
            keepWithNext: group.lastRow < headerRows.length && group.lastRow < node.childCount - 1,
            table: { pos, firstRow: group.firstRow, columns: analysis.columns, headerRows, headerHeight }
          })
        })
      }
    }
    if (node.type.name === "codeBlock") {
      const lines = measureCodeBlockLines(view, node, pos, { scale, widgets })
      if (lines?.length > 1) {
        containers.push({ pos, nodeSize: node.nodeSize, type: node.type.name, start, height,
          renderedTop: round((dom.getBoundingClientRect().top - rect.top) / scale), renderedHeight: round(dom.getBoundingClientRect().height / scale) })
        lines.forEach((line, index) => segments.push({
          pos: index === 0 ? pos : line.pos, nodeSize: line.nodeSize || Math.max(1, (lines[index + 1]?.pos ?? pos + node.nodeSize - 1) - line.pos),
          type: "codeBlock", start: line.start, height: line.height,
          marginTop: index === 0 ? Math.max(0, round(line.start - start + (parseFloat(appearance.marginTop) || 0))) : 0,
          marginBottom: index === lines.length - 1 ? Math.max(0, round(start + height - line.start - line.height + (parseFloat(appearance.marginBottom) || 0))) : 0,
          code: { pos, firstLine: line.firstLine, lastLine: line.lastLine, lineCount: line.lineCount }
        }))
      }
    }
    if (!segments.length) segments.push({
      pos, nodeSize: node.nodeSize, type: node.type.name, start, height: manual ? 0 : height,
      marginTop: manual ? 0 : Math.max(0, round(parseFloat(appearance.marginTop) || 0)),
      marginBottom: manual ? 0 : Math.max(0, round(parseFloat(appearance.marginBottom) || 0)),
      keepWithNext: node.attrs.keepWithNext ?? node.type.name === "heading"
    })
    // 外壳首尾预算归属于实际首末叶子：标题、checkbox、padding 与边框不能孤零零留在上一张页。
    const firstShell = ancestors.find(shell => shell.firstLeaf === leafIndex)
    const lastShell = ancestors.find(shell => shell.lastLeaf === leafIndex)
    const first = segments[0]; const last = segments.at(-1)
    if (!manual && firstShell) {
      const shellDOM = view.nodeDOM(firstShell.pos)
      const shellStyle = view.dom.ownerDocument.defaultView.getComputedStyle(shellDOM)
      first.marginTop = Math.max(0, round(first.start - naturalStart(shellDOM) + (parseFloat(shellStyle.marginTop) || 0)))
      first.boundary = { pos: firstShell.pos, kind: ["listItem", "taskItem"].includes(firstShell.type) ? "list" : "block" }
    } else if (ancestors.length && !manual) first.boundary = { pos, kind: "block" }
    if (!manual && lastShell) {
      const shellDOM = view.nodeDOM(lastShell.pos)
      const shellStyle = view.dom.ownerDocument.defaultView.getComputedStyle(shellDOM)
      const bottom = naturalStart(shellDOM) + shellDOM.getBoundingClientRect().height / scale - insideHeight(shellDOM)
      last.marginBottom = Math.max(0, round(bottom - last.start - last.height + (parseFloat(shellStyle.marginBottom) || 0)))
    }
    if (blocks.length === 0 && !manual) first.marginTop = first.start
    blocks.push(...segments)
  }
  view.state.doc.forEach((node, pos) => {
    if (!PAGINATION_CONTAINER_TYPES.includes(node.type.name)) { measureLeaf(node, pos); return }
    const analysis = analyzeContainerPagination(node, pos, { isDetailsExpanded: (current, position) => getContainerPaginationDOM(view, current, position)?.expanded === true })
    if (!analysis || analysis.containers.some(shell => !getContainerPaginationDOM(view, shell.node, shell.pos))) { measureLeaf(node, pos); return }
    analysis.containers.forEach(shell => {
      const { dom } = getContainerPaginationDOM(view, shell.node, shell.pos)
      containers.push({ pos: shell.pos, nodeSize: shell.node.nodeSize, type: shell.type, start: naturalStart(dom),
        height: Math.max(0, round(dom.getBoundingClientRect().height / scale - insideHeight(dom))),
        renderedTop: round((dom.getBoundingClientRect().top - rect.top) / scale), renderedHeight: round(dom.getBoundingClientRect().height / scale) })
    })
    analysis.leaves.forEach((leaf, index) => measureLeaf(leaf.node, leaf.pos, leaf.ancestors, index))
  })
  const last = blocks.at(-1)
  if (last && last.type !== "pageBreak") {
    last.marginBottom = Math.max(0, round(rect.height / scale - gapHeight - last.start - last.height))
  }
  return { blocks, containers, renderedBreaks, actualHeight: round(rect.height / scale) }
}

// 虚拟 TR 会计入浏览器 rowspan。增删行或改变合并结构时先撤掉旧表内装饰，避免旧断点切断新跨度。
function changedTableStructure(transaction, decorations) {
  const positions = new Set(decorations.find().filter(item => item.spec.tablePagination).map(item => tableBoundary(transaction.before, item.from)?.pos))
  const shape = table => table?.type.spec.tableRole === "table" ? JSON.stringify([...table.content.content].map(row => row.content.content.map(cell => [cell.type.name, cell.attrs.rowspan, cell.attrs.colspan]))) : ""
  for (const pos of positions) if (pos === undefined || shape(transaction.before.nodeAt(pos)) !== shape(transaction.doc.nodeAt(transaction.mapping.map(pos, 1)))) return true
  return false
}

export const PagePagination = Extension.create({
  name: "pagePagination",
  addCommands() {
    return {
      setPaginationSettings: values => ({ editor, tr, dispatch }) => {
        if (editor.isDestroyed || !values || typeof values !== "object" || Array.isArray(values)) return false
        const previous = PAGE_PAGINATION_KEY.getState(editor.state)?.settings || DEFAULT_PAGINATION_SETTINGS
        let settings
        try { settings = normalizePaginationSettings({ ...previous, ...values }) } catch { return false }
        if (dispatch && JSON.stringify(settings) !== JSON.stringify(previous)) tr.setMeta(PAGE_PAGINATION_KEY, { settings }).setMeta("addToHistory", false)
        return true
      }
    }
  },
  addProseMirrorPlugins() {
    const { editor } = this
    return [new Plugin({
      key: PAGE_PAGINATION_KEY,
      state: {
        init: () => ({ settings: { ...DEFAULT_PAGINATION_SETTINGS }, layout: emptyPaginationLayout(), decorations: DecorationSet.empty, pending: false }),
        apply(transaction, previous) {
          const meta = transaction.getMeta(PAGE_PAGINATION_KEY)
          const settings = meta?.settings || previous.settings
          if (!settings.enabled) return settings === previous.settings && !previous.settings.enabled ? previous :
            { settings, layout: emptyPaginationLayout(), decorations: DecorationSet.empty, pending: false }
          if (meta?.layout) return { settings, layout: meta.layout, decorations: gapDecorations(transaction.doc, meta.layout, settings), pending: false }
          if (meta?.resetParagraphs) return { ...previous, settings, pending: true,
            decorations: previous.decorations.remove(previous.decorations.find().filter(item => item.spec.paragraphPagination || item.spec.containerPagination)) }
          if (!transaction.docChanged && settings === previous.settings) return previous
          // 输入法期间仅映射已有空隙，不重新建 DOM；结束后读取最终正文实际布局。
          let decorations = transaction.docChanged && changedTableStructure(transaction, previous.decorations) ?
            previous.decorations.remove(previous.decorations.find().filter(item => item.spec.tablePagination)) : previous.decorations
          // 旧续行 widget 会强制在旧字符处换行。正文/纸宽变化后必须先恢复自然折行再实测；IME 中仅映射，结束后清除重排。
          if (!editor.view?.composing) decorations = decorations.remove(decorations.find().filter(item => item.spec.paragraphPagination || item.spec.containerPagination))
          return { ...previous, settings, pending: true, decorations: decorations.map(transaction.mapping, transaction.doc) }
        }
      },
      props: {
        attributes: state => PAGE_PAGINATION_KEY.getState(state).settings.enabled ? { "data-mewoc-pagination": "true" } : {},
        decorations: state => PAGE_PAGINATION_KEY.getState(state).decorations
      },
      view(view) {
        const win = view.dom.ownerDocument.defaultView
        let frame = 0
        let timer = 0
        let destroyed = false
        let lastEmitted = null
        let measuredWidth = 0
        let fontsChanged = false
        let containerState = ""
        const emit = () => {
          const layout = PAGE_PAGINATION_KEY.getState(view.state).layout
          if (layout !== lastEmitted) { lastEmitted = layout; editor.emit("paginationUpdate", layout) }
        }
        const measure = () => {
          frame = 0
          if (destroyed || view.isDestroyed || view.composing) return
          const current = PAGE_PAGINATION_KEY.getState(view.state)
          if (!current.settings.enabled) return
          const width = parseFloat(win.getComputedStyle(view.dom).width)
          const visibleState = [...view.dom.querySelectorAll("[data-details-view]")].map(dom => dom.dataset.expanded).join(",")
          const containersChanged = visibleState !== containerState
          containerState = visibleState
          if ((current.pending || fontsChanged || containersChanged || Math.abs(width - measuredWidth) > 0.1)
            && current.decorations.find().some(item => item.spec.paragraphPagination || item.spec.containerPagination)) {
            fontsChanged = false
            measuredWidth = width
            view.dispatch(view.state.tr.setMeta(PAGE_PAGINATION_KEY, { resetParagraphs: true }).setMeta("addToHistory", false))
            schedule()
            return
          }
          fontsChanged = false
          measuredWidth = width
          const { blocks, containers, renderedBreaks, actualHeight } = measureBlocks(view)
          // 隐藏的预览/标签页等待 ResizeObserver 恢复尺寸，不能把零高正文当作验收结果。
          if (!view.dom.getBoundingClientRect().width) return
          const layout = planPagePagination(blocks, current.settings, renderedBreaks)
          const plannedBreaks = JSON.stringify(layout.breaks)
          const sameBreaks = plannedBreaks === JSON.stringify(current.layout.breaks)
          // 收敛后直接采用真实 DOM 浮点矩形。CSS 声明高度不等于 used-height，不能累加声明值再裁容器。
          layout.containers = containers.map(({ renderedTop, renderedHeight, ...container }) => ({ ...container,
            top: current.settings.marginTopPx + (sameBreaks ? renderedTop : container.start + layout.breaks.filter(gap => gap.pos <= container.pos).reduce((sum, gap) => sum + gap.height, 0)),
            height: sameBreaks ? renderedHeight : container.height + layout.breaks.filter(gap => gap.pos > container.pos && gap.pos < container.pos + container.nodeSize).reduce((sum, gap) => sum + gap.height, 0)
          }))
          if (sameBreaks) layout.contentHeight = actualHeight
          if (!current.pending && JSON.stringify(layout) === JSON.stringify(current.layout)) return
          view.dispatch(view.state.tr.setMeta(PAGE_PAGINATION_KEY, { layout }).setMeta("addToHistory", false))
          // 新空隙进入 DOM 后再读取真实正文高，既不猜 min-height，也不依赖旧 widget 坐标。
          if (!sameBreaks) schedule()
        }
        const schedule = () => {
          if (destroyed || frame || !PAGE_PAGINATION_KEY.getState(view.state).settings.enabled) return
          frame = win.requestAnimationFrame(measure)
        }
        const endComposition = () => {
          win.clearTimeout(timer)
          // ProseMirror 自己先提交候选文字，再进行仅视图排版。
          timer = win.setTimeout(schedule, 30)
        }
        const observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(schedule) : null
        observer?.observe(view.dom)
        // 折叠是 NodeView 的视图状态，没有正文事务；监听该状态才能在同宽下撤掉隐藏正文的旧断点。
        const mutations = typeof win.MutationObserver === "function" ? new win.MutationObserver(schedule) : null
        mutations?.observe(view.dom, { subtree: true, attributes: true, attributeFilter: ["hidden", "data-expanded"] })
        view.dom.addEventListener("compositionend", endComposition)
        view.dom.addEventListener("load", schedule, true)
        view.dom.addEventListener("loadedmetadata", schedule, true)
        win.addEventListener("resize", schedule)
        const fonts = view.dom.ownerDocument.fonts
        const fontLoaded = () => { fontsChanged = true; schedule() }
        fonts?.addEventListener?.("loadingdone", fontLoaded)
        return {
          update(_view, previousState) {
            const current = PAGE_PAGINATION_KEY.getState(view.state)
            const previous = PAGE_PAGINATION_KEY.getState(previousState)
            emit()
            if (current.settings !== previous.settings || current.pending || view.state.doc !== previousState.doc) schedule()
          },
          destroy() {
            destroyed = true
            if (frame) win.cancelAnimationFrame(frame)
            win.clearTimeout(timer)
            observer?.disconnect()
            mutations?.disconnect()
            view.dom.removeEventListener("compositionend", endComposition)
            view.dom.removeEventListener("load", schedule, true)
            view.dom.removeEventListener("loadedmetadata", schedule, true)
            win.removeEventListener("resize", schedule)
            fonts?.removeEventListener?.("loadingdone", fontLoaded)
          }
        }
      }
    })]
  }
})
