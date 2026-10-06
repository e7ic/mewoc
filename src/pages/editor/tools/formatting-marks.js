/** 收集编辑视图中的不可打印标记位置；只读取正文，不往节点 attrs 或文本中写入符号。 */
const TEXT_BLOCK_TYPES = new Set(["paragraph", "heading"])
const WHITESPACE_TYPES = { " ": "space", "\u00a0": "nbsp", "\t": "tab" }

// 同一文字节点中的连续同类空白共用一个背景装饰，长空格串不会产生逐字符 DOM。
// 不跨 marks 边界合并，背景尺寸始终沿用对应文字的字体及空白宽度。
function collectTextWhitespace(text, position, ranges) {
  const expression = /([ \u00a0\t])\1*/g
  let match
  while ((match = expression.exec(text))) {
    ranges.push({
      kind: WHITESPACE_TYPES[match[1]],
      from: position + match.index,
      to: position + match.index + match[0].length,
      count: match[0].length
    })
  }
}

export function collectFormattingMarkRanges(doc) {
  const ranges = []
  doc.descendants((node, position) => {
    // 代码保留原始源码；公式、图片、附件等原子节点有独立视图，不能深入装饰其内容。
    if (node.type.spec.code || (node.isAtom && !node.isText)) return false
    if (!TEXT_BLOCK_TYPES.has(node.type.name)) return true
    node.forEach((child, offset) => {
      const childPosition = position + 1 + offset
      if (child.type.name === "hardBreak") {
        ranges.push({ kind: "hardBreak", from: childPosition, to: childPosition })
      } else if (child.isText && !child.marks.some(mark => mark.type.spec.code)) {
        collectTextWhitespace(child.text, childPosition, ranges)
      }
    })
    const end = position + node.nodeSize - 1
    ranges.push({ kind: "paragraph", from: end, to: end })
    // 这里已经按直属 inline 子节点读取，外层 descendants 无需再次遍历整段文字。
    return false
  })
  return ranges
}
