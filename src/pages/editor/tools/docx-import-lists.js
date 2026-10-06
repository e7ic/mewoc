/**
 * 将段落分组按源 XML 的编号身份组装为嵌套列表。
 * stack 只记录当前范围的活动层级；计数值已在 XML 阶段算好，因此这里只负责结构和续项边界。
 */
// 分组范围是正文或单元格；编号数值由 XML 阶段计算，跨范围续编也能保留正确的起点。
export function createDocxLists(groups, warnings) {
  const result = []
  const stack = []
  for (const { blocks, metadata = {} } of groups) {
    const numbering = metadata.numbering
    // 无编号但与当前列表正文对齐的普通段/图片可作为同项后续块，其余内容终止当前嵌套链。
    if (!numbering) {
      const active = stack.at(-1)
      if (active && !metadata.heading && metadata.indent > 0 && metadata.indent >= active.indent && blocks.every(block => ["paragraph", "image"].includes(block.type))) {
        active.item.content.push(...blocks)
        warnings.add("与列表文字对齐的后续段落按同一列表项导入，请复核多段列表项边界")
      } else {
        stack.length = 0
        result.push(...blocks)
      }
      continue
    }
    const { id, level, format, value } = numbering
    // 回退到当前层级；身份、格式或下一编号不连续时关闭旧列表，让新列表保留正确起点。
    while (stack.length && stack.at(-1).level > level) stack.pop()
    let active = stack.at(-1)
    if (active?.level === level && (active.id !== id || active.format !== format || (format !== "bullet" && active.next !== value))) {
      stack.pop()
      active = stack.at(-1)
    }
    // 深一层的列表挂到父项；源文档跳层时收拢缺失空层，并通过 warning 提示结构变化。
    if (!active || active.level < level) {
      const list = { type: format === "bullet" ? "bulletList" : "orderedList", ...(format !== "bullet" && { attrs: { start: value, type: format } }), content: [] }
      if (active) active.item.content.push(list)
      else result.push(list)
      if ((active && level > active.level + 1) || (!active && level > 0)) warnings.add("列表跳过的空层级已收拢，保留实际项目顺序及编号")
      active = { id, level, format, list, indent: metadata.indent, next: value }
      stack.push(active)
    }
    // 列表项 Schema 首块必须为段落，编号标题降为段落，图片等开头则补一个空段落。
    const content = blocks.map(block => block.type === "heading" ? { type: "paragraph", content: block.content } : block)
    if (content[0]?.type !== "paragraph") content.unshift({ type: "paragraph" })
    active.item = { type: "listItem", content }
    active.next = value + 1
    active.list.content.push(active.item)
  }
  return result
}
