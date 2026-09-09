import { Paragraph, Table, TableCell, TableRow } from "docx"

// 先展开逻辑网格，再生成 Word 单元格。纵向合并的续行由本模块显式输出，
// 不再传 rowSpan，避免 SDK 自动插入第二份续行；合并区的列宽、底色和边框保持一致。
export async function createDocxTable(node, context, createBlocks) {
  const { warnings, signal } = context
  const grid = node.content.map(() => [])
  const columns = []
  let count = 0
  let width = 0
  node.content.forEach((row, rowIndex) => {
    let column = 0
    row.content.forEach(cell => {
      while (grid[rowIndex][column]) column += 1
      const colspan = cell.attrs?.colspan || 1
      const rowspan = cell.attrs?.rowspan || 1
      count += colspan * rowspan
      if (column + colspan > 1000 || count > 100000) throw new Error("表格网格过大，请拆分表格后导出 Word")
      if (rowIndex + rowspan > grid.length) throw new Error("表格合并区域超出行数，请修复表格后导出")
      const entry = { cell, rowIndex, column, colspan, rowspan }
      for (let y = rowIndex; y < rowIndex + rowspan; y += 1) {
        for (let x = column; x < column + colspan; x += 1) {
          if (grid[y][x]) throw new Error("表格合并区域重叠，请修复表格后导出")
          grid[y][x] = entry
        }
      }
      for (let index = 0; index < colspan; index += 1) {
        const size = cell.attrs?.colwidth?.[index]
        if (!size) continue
        if (columns[column + index] && columns[column + index] !== size) warnings.add("表格同列存在不同宽度，已采用较大的列宽")
        columns[column + index] = Math.max(columns[column + index] || 0, size)
      }
      column += colspan
      width = Math.max(width, column)
    })
  })
  for (const row of grid) {
    if (row.length !== width || Array.from({ length: width }, (_, index) => !row[index]).some(Boolean)) throw new Error("表格存在缺失单元格，请修复表格后导出")
  }
  const available = context.widthPx - context.indent / 15
  if (available < 24) throw new Error("表格可用宽度过小，请减少嵌套或缩进后导出")
  let specified = 0
  let missing = 0
  for (let index = 0; index < width; index += 1) {
    if (columns[index]) specified += columns[index]
    else missing += 1
  }
  const fallback = Math.max(35, (available - specified) / (missing || 1))
  const sizes = Array.from({ length: width }, (_, index) => columns[index] || fallback)
  let total = 0
  sizes.forEach(size => { total += size })
  const ratio = Math.min(1, available / total)
  if (ratio < 1) warnings.add("超出正文或单元格宽度的表格已等比收窄，文字会重新换行")
  const twips = sizes.map(size => Math.max(1, Math.floor(size * ratio * 15)))
  const rows = []
  let header = true
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
    signal?.throwIfAborted()
    const row = grid[rowIndex]
    header = header && row.every(entry => entry.cell.type === "tableHeader" && entry.rowspan === 1)
    const children = []
    for (let column = 0; column < width;) {
      const entry = row[column]
      const { cell, colspan, rowspan } = entry
      let cellWidth = 0
      twips.slice(column, column + colspan).forEach(size => { cellWidth += size })
      const continuation = rowIndex !== entry.rowIndex
      const content = continuation ? [] : await createBlocks(cell.content, {
        ...context, widthPx: cellWidth / 15 - 20, indent: 0, listDepth: 0,
        inTable: true, header: cell.type === "tableHeader"
      })
      // OOXML 要求单元格以段落结束，嵌套表格后补空段而不是依赖渲染器修复文件。
      if (!(content.at(-1) instanceof Paragraph)) content.push(new Paragraph({ spacing: { after: 0 } }))
      const border = { style: "single", size: 4, color: "D9DBE5" }
      children.push(new TableCell({
        width: { size: cellWidth, type: "dxa" }, columnSpan: colspan,
        ...(rowspan > 1 && { verticalMerge: continuation ? "continue" : "restart" }),
        borders: { top: border, bottom: border, left: border, right: border },
        margins: { top: 120, bottom: 120, left: 150, right: 150 },
        verticalAlign: "top",
        ...(cell.type === "tableHeader" && { shading: { fill: "F2F1F8" } }),
        children: content
      }))
      column += colspan
    }
    // 允许长行跨页，避免单个大单元格将整张表挤出纸张；只有连续、未纵向合并的表头重复。
    rows.push(new TableRow({ tableHeader: header, cantSplit: false, children }))
  }
  let tableWidth = 0
  twips.forEach(size => { tableWidth += size })
  return new Table({
    layout: "fixed", width: { size: tableWidth, type: "dxa" },
    indent: { size: context.indent, type: "dxa" }, columnWidths: twips, rows
  })
}
