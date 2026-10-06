/**
 * 提取表格可分页的行组与可重复表头，只分析结构，不拆节点或写回正文。
 * rowspan 覆盖的行必须作为一个整体排版，避免分页空隙进入纵向合并格。
 */
import { TableMap } from "@tiptap/pm/tables"

/**
 * tablePos 是表格节点在文档中的绝对位置；返回位置指向组内首个 tableRow 的开头 token。
 * columns 使用 TableMap 的逻辑网格宽度，不能用首行 childCount 代替，否则 colspan 会少算列。
 * 任何结构问题返回 null，让调用方保留整张表的展开排版，不能猜测或自动修复用户内容。
 */
export function analyzeTablePagination(tableNode, tablePos) {
  if (tableNode?.type?.spec?.tableRole !== "table" || !Number.isSafeInteger(tablePos) || tablePos < 0 ||
    !Number.isSafeInteger(tablePos + tableNode.nodeSize) || !tableNode.childCount) return null

  const rows = []
  let valid = true
  tableNode.forEach((row, offset, index) => {
    if (row.type.spec.tableRole !== "row") { valid = false; return }
    let lastCoveredRow = index
    let repeatableHeader = row.childCount > 0
    // 只读当前行直接包含的单元格；嵌套表格有独立网格，不能把内层 rowspan 当作外表的行跨度。
    row.forEach(cell => {
      const role = cell.type.spec.tableRole
      const { colspan, rowspan } = cell.attrs
      if (!["cell", "header_cell"].includes(role) || !Number.isSafeInteger(colspan) || colspan < 1 ||
        !Number.isSafeInteger(rowspan) || rowspan < 1 || index + rowspan > tableNode.childCount) {
        valid = false
        return
      }
      lastCoveredRow = Math.max(lastCoveredRow, index + rowspan - 1)
      if (role !== "header_cell" || rowspan !== 1) repeatableHeader = false
    })
    rows.push({ pos: tablePos + 1 + offset, nodeSize: row.nodeSize, lastCoveredRow, repeatableHeader })
  })
  if (!valid) return null

  let map
  try { map = TableMap.get(tableNode) } catch { return null }
  // TableMap 的 problems 也包含列宽不一致；仍未修复的网格不能作为跨页布局的可信基础。
  if (map.problems?.length || map.height !== rows.length || !Number.isSafeInteger(map.width) || map.width < 1 ||
    map.map.length !== map.width * map.height || map.map.some(pos => !Number.isSafeInteger(pos) || pos < 1)) return null

  const headerRows = []
  for (let index = 0; index < rows.length && rows[index].repeatableHeader; index += 1) headerRows.push(index)

  const groups = []
  let firstRow = 0
  let lastRow = 0
  let nodeSize = 0
  rows.forEach((row, index) => {
    // 后续行可能开始另一段纵向合并；把它的终点继续纳入当前组，合并所有重叠和连锁跨度。
    // 仅在已走完所有被覆盖行时收口，既不切开 rowspan，也不把互不关联的相邻组强行连起来。
    lastRow = Math.max(lastRow, row.lastCoveredRow)
    nodeSize += row.nodeSize
    if (index === lastRow) {
      groups.push({ firstRow, lastRow, pos: rows[firstRow].pos, nodeSize })
      firstRow = index + 1
      lastRow = firstRow
      nodeSize = 0
    }
  })
  return { columns: map.width, headerRows, groups }
}
