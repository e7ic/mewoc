import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { TableMap, cellAround } from "@tiptap/pm/tables"

export const TableColumnResize = Extension.create({
  name: "tableColumnResize",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("mewocColumnResize"),
      view: view => bindColumnResize(view)
    })]
  }
})

function getResizeColumn(view, event) {
  const cell = event.target.closest?.("td, th")
  if (!cell || !view.dom.contains(cell)) return null
  const edge = cell.getBoundingClientRect().right - event.clientX
  // 6 个屏幕像素是拖动热区，与文档缩放后的逻辑列宽分开。
  if (edge < -2 || edge > 6) return null
  const resolved = cellAround(view.state.doc.resolve(view.posAtDOM(cell, 0)))
  if (!resolved) return null
  const table = resolved.node(-1)
  const start = resolved.start(-1)
  const map = TableMap.get(table)
  const column = map.colCount(resolved.pos - start) + resolved.nodeAfter.attrs.colspan - 1
  const element = cell.closest("table")
  const scale = element.getBoundingClientRect().width / element.offsetWidth
  const columns = [...element.querySelector("colgroup").children]
  return { table, start, map, column, element, columns, scale }
}

function bindColumnResize(view) {
  let drag = null
  const win = view.dom.ownerDocument.defaultView
  const stopDrag = () => {
    if (drag) {
      drag.columns.forEach((column, index) => { column.style.width = drag.styles[index] })
      drag.element.style.width = drag.tableWidth
    }
    drag = null
    win.removeEventListener("mousemove", handleDrag)
    win.removeEventListener("mouseup", handleFinish)
    win.removeEventListener("blur", stopDrag)
    view.dom.classList.remove("resize-cursor")
  }
  const handleDrag = event => {
    // 窗口外释放时可能收不到 mouseup；恢复预览，避免后续悬停继续改变列宽。
    if (!drag || !view.editable || !(event.buttons & 1)) return stopDrag()
    const width = Math.round(drag.widths[drag.column] + (event.clientX - drag.x) / drag.scale)
    drag.nextWidth = Math.max(35, Math.min(2000, width))
    const widths = drag.widths.map((value, index) => index === drag.column ? drag.nextWidth : value)
    drag.columns.forEach((column, index) => { column.style.width = `${widths[index]}px` })
    drag.element.style.width = `${widths.reduce((total, value) => total + value, 0)}px`
  }
  const handleFinish = () => {
    if (!drag) return
    const completed = drag
    stopDrag()
    if (!view.editable || view.state.doc !== completed.doc) return
    updateColumnWidths(view, completed)
  }
  const handleMouseMove = event => {
    if (drag) return
    view.dom.classList.toggle("resize-cursor", view.editable && !!getResizeColumn(view, event))
  }
  const handleMouseDown = event => {
    if (!view.editable || event.button !== 0) return
    const column = getResizeColumn(view, event)
    if (!column) return
    event.preventDefault()
    event.stopImmediatePropagation()
    drag = createColumnDrag(column, event.clientX, view)
    win.addEventListener("mousemove", handleDrag)
    win.addEventListener("mouseup", handleFinish)
    win.addEventListener("blur", stopDrag)
  }
  view.dom.addEventListener("mousemove", handleMouseMove)
  view.dom.addEventListener("mousedown", handleMouseDown, true)
  return {
    update() { if (drag && (view.state.doc !== drag.doc || !view.editable)) stopDrag() },
    destroy() {
      stopDrag()
      view.dom.removeEventListener("mousemove", handleMouseMove)
      view.dom.removeEventListener("mousedown", handleMouseDown, true)
    }
  }
}

function createColumnDrag(column, x, view) {
  const widths = getRenderedColumnWidths(column, view)
  return {
    ...column, x, doc: view.state.doc, widths,
    nextWidth: widths[column.column],
    styles: column.columns.map(element => element.style.width),
    tableWidth: column.element.style.width
  }
}

function getRenderedColumnWidths({ table, start, map, scale }, view) {
  // Safari 的 col 元素没有可靠的布局矩形；从实际单元格边界重建逻辑列宽。
  const boundaries = Array(map.width + 1).fill(null)
  const weights = Array(map.width).fill(1)
  new Set(map.map).forEach(pos => {
    const node = table.nodeAt(pos)
    const column = map.colCount(pos)
    const rect = view.nodeDOM(start + pos).getBoundingClientRect()
    boundaries[column] = rect.left / scale
    boundaries[column + node.attrs.colspan] = rect.right / scale
    node.attrs.colwidth?.forEach((width, index) => { if (width > 0) weights[column + index] = width })
  })
  const widths = []
  for (let from = 0; from < map.width;) {
    let to = from + 1
    while (boundaries[to] === null) to += 1
    const total = weights.slice(from, to).reduce((sum, weight) => sum + weight, 0)
    // 如果所有行都合并了同一组列，内部边界不可测，按已有列宽比例分配。
    for (let column = from; column < to; column += 1) {
      widths[column] = Math.round((boundaries[to] - boundaries[from]) * weights[column] / total)
    }
    from = to
  }
  return widths
}

function updateColumnWidths(view, drag) {
  const widths = drag.widths.map((value, index) => index === drag.column ? drag.nextWidth : value)
  const positions = new Set(drag.map.map)
  const transaction = view.state.tr
  positions.forEach(pos => {
    const node = drag.table.nodeAt(pos)
    const column = drag.map.colCount(pos)
    transaction.setNodeMarkup(drag.start + pos, undefined, {
      ...node.attrs,
      colwidth: widths.slice(column, column + node.attrs.colspan)
    })
  })
  view.dispatch(transaction)
}
