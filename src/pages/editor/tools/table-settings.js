/**
 * 处理表格设置的真实单元格范围、目标身份、混合值读取和批量属性提交。
 * 单元格外观作用于原选格，边框作用于整表，宽高按逻辑列/行处理；事务维护合并单元格一致性。
 */
import { CellSelection, TableMap, cellAround } from "@tiptap/pm/tables"
import { closeHistory } from "@tiptap/pm/history"
import { TextSelection } from "@tiptap/pm/state"
import { ReplaceAroundStep } from "@tiptap/pm/transform"
import { isTableInteger, isValidTableCellAppearance, normalizeTableCellAppearance } from "../extensions/table-appearance.js"

export const TABLE_MIXED = "mixed"
const cellKeys = ["backgroundColor", "verticalAlign", "paddingX", "paddingY"]
const borderKeys = ["borderColor", "borderWidth", "borderStyle"]
const unavailable = "原表格或选中的单元格已被删除或替换，请关闭后重新选择。"

// 把单格内光标和多格 CellSelection 统一为表格上下文，拒绝跨表文字范围或有结构问题的 TableMap。
// 逻辑行列来自单元格覆盖矩形，合并单元格可能覆盖多个行列，不能只用单元格序号推算。
function contextFromSelection(doc, selection) {
  const anchor = selection instanceof CellSelection ? selection.$anchorCell : cellAround(selection.$anchor)
  const head = selection instanceof CellSelection ? selection.$headCell : cellAround(selection.$head)
  if (!anchor || !head || anchor.node(-1).type.spec.tableRole !== "table" || anchor.start(-1) !== head.start(-1)) return null
  if (!(selection instanceof CellSelection) && anchor.pos !== head.pos) return null
  const table = anchor.node(-1)
  const start = anchor.start(-1)
  const map = TableMap.get(table)
  if (map.problems?.length) return null
  const cells = []
  if (selection instanceof CellSelection) selection.forEachCell((_node, pos) => { cells.push(pos) })
  else cells.push(anchor.pos)
  const columns = new Set()
  const rows = new Set()
  cells.forEach(pos => {
    const rect = map.findCell(pos - start)
    for (let column = rect.left; column < rect.right; column += 1) columns.add(column)
    for (let row = rect.top; row < rect.bottom; row += 1) rows.add(row)
  })
  return { table, tablePos: start - 1, start, map, cells, columns: [...columns].sort((a, b) => a - b), rows: [...rows].sort((a, b) => a - b), selection }
}

// 弹窗打开时捕获真实正文选区。focus 改变后仍使用此书签，禁止把草稿施加到后来点击的另一张表。
export function captureTableTarget(editor) {
  if (!editor || editor.isDestroyed || !editor.state) return null
  const { state } = editor
  const context = contextFromSelection(state.doc, state.selection)
  if (!context) return null
  return { doc: state.doc, bookmark: state.selection.getBookmark(), tablePos: context.tablePos, cells: context.cells, storedMarks: state.storedMarks, valid: true }
}

// 识别保留内部内容的节点外壳修改，供身份映射区分属性变化与真正替换。
function isNodeMarkup(step, pos, node) {
  return step instanceof ReplaceAroundStep && step.from === pos && step.to === pos + node.nodeSize &&
    step.gapFrom === pos + 1 && step.gapTo === pos + node.nodeSize - 1 && step.insert === 1 && step.structure
}

// 内容起点可能恰好是首行或首段的外层 token；对齐/行高更新它们时不能误判整表或 cell 被替换。
// 逐步核对原节点自己的开头 token，放行保留内容的 setNodeMarkup，拒绝同位置整节点替换。
export function mapTableTarget(target, transaction) {
  if (!target?.valid) return false
  if (target.doc !== transaction.before) {
    target.valid = false
    return false
  }
  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index]
    const before = transaction.docs[index]
    const after = transaction.docs[index + 1] || transaction.doc
    const mapping = step.getMap()
    const positions = []
    for (const [positionIndex, pos] of [target.tablePos, ...target.cells].entries()) {
      const node = before.nodeAt(pos)
      const mapped = mapping.mapResult(pos, 1)
      const allowedRoles = positionIndex === 0 ? ["table"] : ["cell", "header_cell"]
      if (!node || !allowedRoles.includes(node.type.spec.tableRole) || mapped.deleted && !isNodeMarkup(step, pos, node) || !allowedRoles.includes(after.nodeAt(mapped.pos)?.type.spec.tableRole)) {
        target.valid = false
        return false
      }
      positions.push(mapped.pos)
    }
    target.tablePos = positions[0]
    target.cells = positions.slice(1)
  }
  target.bookmark = target.bookmark.map(transaction.mapping)
  target.doc = transaction.doc
  return target.valid
}

// 每次读取/提交都恢复并核对原表与原选格，书签解析失败或目标转向其他单元格时返回 null。
function getContext(editor, target) {
  if (!target?.valid || !editor || editor.isDestroyed || target.doc !== editor.state.doc) return null
  try {
    const selection = target.bookmark.resolve(editor.state.doc)
    const context = contextFromSelection(editor.state.doc, selection)
    if (!context || context.tablePos !== target.tablePos || context.cells.some(pos => !target.cells.includes(pos))) return null
    return context
  } catch { return null }
}

// 聚合设置回显：没有可读数据返回 null，多种值返回 mixed，其余保留共同值包括 0/false。
function common(values) {
  if (!values.length) return null
  return values.every(value => value === values[0]) ? values[0] : TABLE_MIXED
}

// TableMap 对合并格重复存位置，先去重再读取节点；记录逻辑起始列供各列宽数组更新。
function allCells(context) {
  return [...new Set(context.map.map)].map(pos => ({ pos: context.start + pos, node: context.table.nodeAt(pos), column: context.map.colCount(pos) }))
}

// 按真实 nodeSize 累计绝对行位置，只返回原选格覆盖的逻辑行，避免按等长假设定位。
function rowPositions(context) {
  const result = []
  let offset = context.start
  context.table.forEach((node, _relative, index) => {
    if (context.rows.includes(index)) result.push({ pos: offset, node })
    offset += node.nodeSize
  })
  return result
}

// 收集选格内部可水平对齐的段落和标题，节点相对位置转换为当前文档绝对位置。
function selectedParagraphs(editor, context) {
  const paragraphs = []
  context.cells.forEach(pos => {
    const cell = editor.state.doc.nodeAt(pos)
    cell.descendants((node, relative) => {
      // 外层单元格的水平对齐不覆盖内嵌表格自己的段落设置。
      if (node.type.spec.tableRole === "table") return false
      if (["paragraph", "heading"].includes(node.type.name)) {
        paragraphs.push({ node, pos: pos + 1 + relative })
        return false
      }
    })
  })
  return paragraphs
}

// 分别聚合单格属性、所选段落对齐、整表边框以及选中行列尺寸，scope 返回界面需要的影响范围。
export function readTableSettings(editor, target) {
  const context = getContext(editor, target)
  if (!context) return null
  const selected = context.cells.map(pos => normalizeTableCellAppearance(editor.state.doc.nodeAt(pos).attrs))
  const cells = allCells(context)
  const appearances = cells.map(cell => normalizeTableCellAppearance(cell.node.attrs))
  const widths = context.columns.flatMap(column => cells.filter(cell => column >= cell.column && column < cell.column + cell.node.attrs.colspan)
    .map(cell => cell.node.attrs.colwidth?.[column - cell.column] || null))
  return {
    cell: Object.fromEntries(cellKeys.map(key => [key, common(selected.map(attrs => attrs[key]))])),
    paragraph: { textAlign: common(selectedParagraphs(editor, context).map(({ node }) => node.attrs.textAlign || "left")) },
    border: Object.fromEntries(borderKeys.map(key => [key, common(appearances.map(attrs => attrs[key]))])),
    dimensions: { columnWidth: common(widths), rowMinHeight: common(rowPositions(context).map(row => row.node.attrs.minHeight ?? null)) },
    scope: { cells: selected.length, columns: context.columns.length, rows: context.rows.length, tableColumns: context.map.width }
  }
}

// 按分组白名单校验部分修改，保留未提供字段；均分列宽和指定列宽互斥，避免提交含义不清。
function validatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false
  if (Object.keys(patch).some(key => !["cell", "paragraph", "border", "dimensions"].includes(key))) return false
  for (const [group, allowed] of [["cell", cellKeys], ["paragraph", ["textAlign"]], ["border", borderKeys], ["dimensions", ["columnWidth", "rowMinHeight", "distributeColumns"]]]) {
    const values = patch[group]
    if (values === undefined) continue
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).some(key => !allowed.includes(key))) return false
  }
  if (!isValidTableCellAppearance({ ...patch.cell, ...patch.border })) return false
  if (patch.paragraph && "textAlign" in patch.paragraph && !["left", "center", "right", "justify"].includes(patch.paragraph.textAlign)) return false
  const dimensions = patch.dimensions || {}
  if ("columnWidth" in dimensions && !isTableInteger(dimensions.columnWidth, 35, 2000)) return false
  if ("rowMinHeight" in dimensions && dimensions.rowMinHeight !== null && !isTableInteger(dimensions.rowMinHeight, 1, 1000)) return false
  if ("distributeColumns" in dimensions && typeof dimensions.distributeColumns !== "boolean") return false
  if (dimensions.distributeColumns && "columnWidth" in dimensions) return false
  return true
}

// offsetWidth 是布局像素，不受文档缩放 transform 的屏幕矩形影响。所有列已存宽时优先用数据。
export function unscaledTableWidth(editor, context) {
  const cells = allCells(context)
  const widths = Array.from({ length: context.map.width }, (_item, column) => {
    const values = cells.filter(cell => column >= cell.column && column < cell.column + cell.node.attrs.colspan)
      .map(cell => cell.node.attrs.colwidth?.[column - cell.column]).filter(value => isTableInteger(value, 35, 2000))
    return values.length && values.every(value => value === values[0]) ? values[0] : null
  })
  if (widths.every(width => width !== null)) return widths.reduce((total, width) => total + width, 0)
  try {
    const dom = editor.view.nodeDOM(context.tablePos)
    const table = dom?.tagName === "TABLE" ? dom : dom?.querySelector?.("table")
    const width = table?.offsetWidth
    return Number.isFinite(width) && width > 0 ? width : null
  } catch { return null }
}

// 只提交 dirty 字段：例如两个背景色不同的单元格只修改 padding 时，背景色各自保留。
// 所有 cell、row、逻辑列宽在同一事务内提交；前后 closeHistory 保证一次保存可以独立撤销。
export function applyTableSettings(editor, target, patch, blocked = false) {
  if (!editor || editor.isDestroyed || !editor.isEditable || editor.view?.composing || blocked) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再应用。" }
  const context = getContext(editor, target)
  if (!context) return { ok: false, error: unavailable }
  if (!validatePatch(patch)) return { ok: false, error: "请输入有效的表格设置；列宽为 35–2000，行高为 1–1000。" }
  const paragraphs = selectedParagraphs(editor, context)
  if (patch.paragraph && "textAlign" in patch.paragraph && (!paragraphs.length || paragraphs.some(({ node }) => !node.type.attrs.textAlign))) return { ok: false, error: "选中的单元格没有可水平对齐的段落。" }
  const cells = allCells(context)
  const dimensions = patch.dimensions || {}
  let distributed = null
  // 均分以整表未缩放宽度和全部逻辑列为基准，读取不到或超范围时拒绝，不能猜测一个默认列宽。
  if (dimensions.distributeColumns) {
    const total = unscaledTableWidth(editor, context)
    const width = total === null ? null : Math.round(total / context.map.width)
    if (!isTableInteger(width, 35, 2000)) return { ok: false, error: "暂时无法读取整表宽度，请先设置列宽后再均分。" }
    distributed = width
  }
  const tr = closeHistory(editor.state.tr)
  // 整表边框合并到每格，单格外观只合并到原选格；列宽更新所有覆盖相关逻辑列的格以保持一致。
  cells.forEach(({ pos, node, column }) => {
    const attrs = { ...node.attrs, ...patch.border, ...(context.cells.includes(pos) ? patch.cell : {}) }
    if (distributed !== null || "columnWidth" in dimensions) {
      // colwidth 每项对应合并格覆盖的一列，保留未修改列；0 表示未设宽度，不能丢失数组位置关系。
      const widths = Array.from({ length: node.attrs.colspan }, (_item, index) => node.attrs.colwidth?.[index] || 0)
      widths.forEach((_value, index) => {
        if (distributed !== null) widths[index] = distributed
        else if (context.columns.includes(column + index)) widths[index] = dimensions.columnWidth
      })
      if (widths.some(width => width > 0)) attrs.colwidth = widths
    }
    if (JSON.stringify(attrs) !== JSON.stringify(node.attrs)) tr.setNodeMarkup(pos, undefined, attrs)
  })
  // 行高与段落对齐继续写入同一事务，null 行高表示恢复默认；最终恢复原多格或文字选区。
  if ("rowMinHeight" in dimensions) rowPositions(context).forEach(({ pos, node }) => {
    if (node.attrs.minHeight !== dimensions.rowMinHeight) tr.setNodeMarkup(pos, undefined, { ...node.attrs, minHeight: dimensions.rowMinHeight })
  })
  if (patch.paragraph && "textAlign" in patch.paragraph) paragraphs.forEach(({ pos, node }) => {
    if (node.attrs.textAlign !== patch.paragraph.textAlign) tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: patch.paragraph.textAlign })
  })
  tr.setSelection(context.selection.map(tr.doc, tr.mapping)).scrollIntoView()
  if (context.selection.empty) tr.setStoredMarks(target.storedMarks || null)
  if (!tr.docChanged) {
    // 点击当前值也回到弹层打开时的选区，但不产生正文更新或新的撤销记录。
    if (!tr.selection.eq(editor.state.selection) || tr.storedMarks !== editor.state.storedMarks) editor.view.dispatch(tr)
    return { ok: true, changed: false }
  }
  editor.view.dispatch(tr)
  editor.view.dispatch(closeHistory(editor.state.tr))
  return { ok: true, changed: true }
}

// 保留书签选区的快捷入口，便于调用方聚焦正文后仍恢复原来的多单元格选择。
export function restoreTableTargetSelection(editor, target) {
  const context = getContext(editor, target)
  if (!context) return false
  const selection = context.selection instanceof CellSelection ? context.selection : TextSelection.create(editor.state.doc, context.selection.from, context.selection.to)
  editor.view.dispatch(editor.state.tr.setSelection(selection))
  return true
}
