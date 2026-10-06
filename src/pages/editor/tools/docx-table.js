/**
 * 编辑器合并表格到 OOXML 的映射：先验证完整逻辑网格，再计算列宽并输出行/格。
 * 单元格正文递归委托 createBlocks，合并续格只输出占位结构，避免重复正文或重复 SDK 合并节点。
 */
import { Paragraph, Table, TableCell, TableRow } from "docx"

// 先展开逻辑网格，再生成 Word 单元格。纵向合并的续行由本模块显式输出，
// 不再传 rowSpan，避免 SDK 自动插入第二份续行；合并区的列宽、底色和边框保持一致。
export async function createDocxTable(node, context, createBlocks) {
  const { warnings, signal } = context
  const grid = node.content.map(() => [])
  const columns = []
  let count = 0
  let width = 0
  // 每个起始格引用一个 entry，跨行/跨列的位置共享它，后续可据 rowIndex 判断合并续格。
  node.content.forEach((row, rowIndex) => {
    let column = 0
    row.content.forEach(cell => {
      // 先跳过前行 rowspan 覆盖的位置，再放当前物理单元格，发现重叠立即拒绝。
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
      // colwidth 每项对应一个逻辑列；同列各格声明冲突时取较大值并告知，避免压缩内容。
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
  // 完整矩形是后续固定列宽和纵向合并的前提，不能凭空补格修复已损坏的源结构。
  for (const row of grid) {
    if (row.length !== width || Array.from({ length: width }, (_, index) => !row[index]).some(Boolean)) throw new Error("表格存在缺失单元格，请修复表格后导出")
  }
  const available = context.widthPx - context.indent / 15
  if (available < 24) throw new Error("表格可用宽度过小，请减少嵌套或缩进后导出")
  // 未指定的列分配剩余空间，并保留最低估计宽度；整体太宽时统一按比例收窄。
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
  // px 转 twip 后向下取整，保证各列总宽度不会因四舍五入超出可用区域。
  const twips = sizes.map(size => Math.max(1, Math.floor(size * ratio * 15)))
  const rows = []
  let header = true
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
    signal?.throwIfAborted()
    const row = grid[rowIndex]
    // 只有开头连续、每格都是未纵向合并表头的行才重复；之后的表头样式行不重启此标记。
    header = header && row.every(entry => entry.cell.type === "tableHeader" && entry.rowspan === 1)
    const children = []
    for (let column = 0; column < width;) {
      const entry = row[column]
      const { cell, colspan, rowspan } = entry
      let cellWidth = 0
      twips.slice(column, column + colspan).forEach(size => { cellWidth += size })
      // 合并续格沿用起始格的外观及跨度，正文仅由起始行输出，续格补合法空段落。
      const continuation = rowIndex !== entry.rowIndex
      const paddingX = cell.attrs?.paddingX ?? 10
      const paddingY = cell.attrs?.paddingY ?? 8
      // Word 固定列宽不能提供负的正文区域；极窄列只收窄横向内边距，并明确报告转换。
      const effectivePaddingX = Math.min(paddingX, Math.max(0, (cellWidth / 15 - 24) / 2))
      if (effectivePaddingX < paddingX) warnings.add("窄单元格的左右内边距在 Word 中已缩小，以保留正文区域")
      // 格内可用宽度扣除有效内边距；嵌套块重新从零缩进/列表深度开始，宽度约束继续传递。
      const content = continuation ? [] : await createBlocks(cell.content, {
        ...context, widthPx: cellWidth / 15 - effectivePaddingX * 2, indent: 0, listDepth: 0,
        inTable: true, header: cell.type === "tableHeader"
      })
      // OOXML 要求单元格以段落结束，嵌套表格后补空段而不是依赖渲染器修复文件。
      if (!(content.at(-1) instanceof Paragraph)) content.push(new Paragraph({ spacing: { after: 0 } }))
      // 文档按 px 保存，OOXML 的边框使用 1/8 pt、内边距使用 twip（1 px = 15 twip）。
      const borderStyle = cell.attrs?.borderStyle || "solid"
      const borderWidth = cell.attrs?.borderWidth ?? 1
      const border = {
        style: borderStyle === "none" || borderWidth === 0 ? "nil" : { solid: "single", dashed: "dashed", dotted: "dotted" }[borderStyle],
        size: borderWidth * 6,
        color: (cell.attrs?.borderColor || "#d9dbe5").slice(1).toUpperCase()
      }
      const background = cell.attrs?.backgroundColor || (cell.type === "tableHeader" ? "#f2f1f8" : null)
      children.push(new TableCell({
        width: { size: cellWidth, type: "dxa" }, columnSpan: colspan,
        ...(rowspan > 1 && { verticalMerge: continuation ? "continue" : "restart" }),
        borders: { top: border, bottom: border, left: border, right: border },
        margins: { top: paddingY * 15, bottom: paddingY * 15, left: Math.round(effectivePaddingX * 15), right: Math.round(effectivePaddingX * 15) },
        verticalAlign: cell.attrs?.verticalAlign === "middle" ? "center" : cell.attrs?.verticalAlign || "top",
        ...(background && { shading: { fill: background.slice(1).toUpperCase() } }),
        children: content
      }))
      column += colspan
    }
    // 允许长行跨页，避免单个大单元格将整张表挤出纸张；只有连续、未纵向合并的表头重复。
    rows.push(new TableRow({
      tableHeader: header, cantSplit: false,
      // 行高是内容可继续撑开的最小值，不把长文字裁到固定高度。
      ...(node.content[rowIndex].attrs?.minHeight && { height: { value: node.content[rowIndex].attrs.minHeight * 15, rule: "atLeast" } }),
      children
    }))
  }
  // 表格宽度使用最终列宽之和，固定布局与 gridCol/单元格宽度使用同一套尺寸，避免 Word 重算冲突。
  let tableWidth = 0
  twips.forEach(size => { tableWidth += size })
  return new Table({
    layout: "fixed", width: { size: tableWidth, type: "dxa" },
    indent: { size: context.indent, type: "dxa" }, columnWidths: twips, rows
  })
}
