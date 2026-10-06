/**
 * 按正文结构和真实选区计算字符、去空白字符与段落数量，并提供全选操作。
 * 统计不修改文档，使用多个范围支持不连续单元格选择，字符按 Unicode 码点计数。
 */
const PARAGRAPH_TYPES = ["paragraph", "heading", "codeBlock"]

// 只截取范围实际覆盖的文本，显式换行算字符；段落位置用集合去重，防止多范围重复计段。
function readStatistics(doc, ranges) {
  let text = ""
  const paragraphs = new Set()
  for (const { from, to } of ranges) {
    doc.nodesBetween(from, to, (node, pos) => {
      if (PARAGRAPH_TYPES.includes(node.type.name) && from <= pos + node.nodeSize - 1 && to > pos + 1) paragraphs.add(pos)
      if (node.isText) text += node.text.slice(Math.max(0, from - pos), Math.min(node.nodeSize, to - pos))
      else if (node.type.name === "hardBreak") text += "\n"
    })
  }
  return {
    characters: [...text].length,
    charactersWithoutWhitespace: [...text.replace(/\s/g, "")].length,
    paragraphs: paragraphs.size
  }
}

// 字符来自正文 text 和显式换行；段落边界单独计数，不人为补换行、图片说明或公式源码。
export function getDocumentStatistics(doc, selection) {
  // 选区范围先排序和合并重叠，避免同一文字被多个 range 重复统计；空光标没有选区统计。
  const ranges = []
  for (const { $from, $to } of [...selection.ranges].sort((a, b) => a.$from.pos - b.$from.pos)) {
    if ($from.pos === $to.pos) continue
    const previous = ranges[ranges.length - 1]
    if (previous && $from.pos <= previous.to) previous.to = Math.max(previous.to, $to.pos)
    else ranges.push({ from: $from.pos, to: $to.pos })
  }
  // CellSelection 的实际范围可能不连续，不用其 from/to 包围盒统计未选中的单元格。
  return {
    document: readStatistics(doc, [{ from: 0, to: doc.content.size }]),
    selection: ranges.length ? readStatistics(doc, ranges) : null
  }
}

// 全选只改变选区，允许只读查看；文档切换、销毁与输入法组合期间仍拦截焦点操作。
export function selectDocumentContents(editor, blocked = false) {
  if (!editor || editor.isDestroyed || editor.view.composing || blocked) return false
  return editor.chain().focus().selectAll().run()
}
