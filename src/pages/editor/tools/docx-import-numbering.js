/**
 * 从 Word 原始 XML 计算每个有效段落的标题、缩进及列表编号元数据。
 * 样式继承和 numId/lvl 定义在这里解释，后续 HTML 转换不再承担 Word 的计数规则。
 */
import { getWordChild, getWordValue, WORD_XML } from "./docx-import-xml.js"
import { createDocxNumberingReader, readCompositeNumbering } from "./docx-import-numbering-definitions.js"
import { readDocxLetterSegment } from "./docx-letter-numbering.js"

// 编号身份属于 numId，层级定义来自 abstractNum；同一身份被普通段落打断后仍继续计数。
export function readDocxParagraphs(xml, numbering, styles, warnings) {
  // 建索引后按样式 ID/编号身份查找，计数器按 numId 独立保存，跨普通段落和表格仍能续编。
  const styleMap = new Map(Array.from(styles?.getElementsByTagNameNS(WORD_XML, "style") || []).map(style => [style.getAttributeNS(WORD_XML, "styleId"), style]))
  const definition = createDocxNumberingReader(numbering)
  // basedOn 从当前样式向基类回溯，再倒序应用属性；直接段落属性最后覆盖继承值。
  const getStyleProperties = id => {
    const properties = []
    const visited = new Set()
    while (id && styleMap.has(id)) {
      if (visited.has(id) || visited.size > 32) throw new Error("Word 段落样式存在循环或层级过多")
      visited.add(id)
      const style = styleMap.get(id)
      properties.unshift(getWordChild(style, "pPr"))
      id = getWordValue(style, "basedOn")
    }
    return properties.filter(Boolean)
  }
  // 过滤 Mammoth 不输出的纵向合并续格，使后续 HTML 段落与 XML 元信息仍逐项对应。
  const paragraphs = Array.from(xml.getElementsByTagNameNS(WORD_XML, "p")).filter(paragraph => {
    let parent = paragraph.parentNode
    while (parent && parent !== xml) {
      if (parent.namespaceURI === WORD_XML && parent.localName === "tc") {
        const merge = getWordChild(getWordChild(parent, "tcPr"), "vMerge")
        if (merge && merge.getAttributeNS(WORD_XML, "val") !== "restart") {
          // 合并续格由 Mammoth 消除；仅允许空占位，不能顺带丢掉其中的正文。
          if (parent.textContent.trim() || parent.getElementsByTagNameNS(WORD_XML, "drawing").length) throw new Error("纵向合并续格包含正文，无法可靠导入")
          return false
        }
      }
      parent = parent.parentNode
    }
    return true
  }).map(paragraph => {
    const direct = getWordChild(paragraph, "pPr")
    const styleId = getWordValue(direct, "pStyle")
    const styleName = getWordValue(styleMap.get(styleId), "name") || styleId || ""
    const properties = [...getStyleProperties(styleId), direct].filter(Boolean)
    let numId
    let level = 0
    let indent = 0
    let hasIndent = false
    let heading = Number(/^heading\s*([1-9])$/i.exec(styleName)?.[1]) || undefined
    // 每层仅覆盖实际声明的属性；outlineLvl 能覆盖样式名称推断出的标题，包括显式取消大纲级别。
    for (const propertiesNode of properties) {
      const numPr = getWordChild(propertiesNode, "numPr")
      numId = getWordValue(numPr, "numId") ?? numId
      level = Number(getWordValue(numPr, "ilvl") ?? level)
      const left = getWordChild(propertiesNode, "ind")
      if (left?.hasAttributeNS(WORD_XML, "left") || left?.hasAttributeNS(WORD_XML, "start")) {
        indent = Number(left.getAttributeNS(WORD_XML, left.hasAttributeNS(WORD_XML, "start") ? "start" : "left"))
        hasIndent = true
      }
      const outline = getWordValue(propertiesNode, "outlineLvl")
      if (outline !== undefined) heading = Number(outline) < 9 ? Number(outline) + 1 : undefined
    }
    if (heading > 6) warnings.add("七至九级标题已转换为六级标题")
    const metadata = { indent, heading: heading ? Math.min(6, heading) : undefined }
    // numId=0 是 Word 的显式取消编号；仍保留标题/缩进以供普通段落或列表续项判断。
    if (numId === undefined || numId === "0") return metadata
    if (!Number.isInteger(level) || level < 0 || level > 8) throw new Error("Word 列表仅支持零至八级编号定义")
    const entry = definition(numId, level)
    // 未直接/继承声明缩进时使用编号定义的缩进；两者都缺失才采用每层 480 twip 的估计值。
    if (!hasIndent) {
      const ind = getWordChild(getWordChild(entry.entry, "pPr"), "ind")
      metadata.indent = Number(ind?.getAttributeNS(WORD_XML, "left") || ind?.getAttributeNS(WORD_XML, "start") || (level + 1) * 480)
    }
    const letter = readDocxLetterSegment(styleMap.get(styleId), entry, level)
    return { ...metadata, numbering: { id: numId, level, entry, letter } }
  })
  return numberParagraphs(paragraphs, definition, warnings)
}

function numberParagraphs(paragraphs, definition, warnings) {
  // 只在实际出现组合模板时转换整个 numId，避免同组父项自动编号、子项静态前缀相互错位。
  const staticIds = new Set(paragraphs.filter(value => value.numbering && !value.numbering.entry.simple && !value.numbering.letter).map(value => value.numbering.id))
  const counters = new Map()
  return paragraphs.map(metadata => {
    if (!metadata.numbering) return metadata
    const { id, level, entry, letter } = metadata.numbering
    const isStatic = staticIds.has(id)
    const start = isStatic && entry.origin === undefined ? 0 : entry.start
    if (!isStatic && start < 1) throw new Error("Word 列表编号起始值暂不支持")
    if (isStatic) readCompositeNumbering(entry, level)
    else if (entry.text?.endsWith(")")) warnings.add("列表编号后的右括号已转换为句点")
    if (!counters.has(id)) counters.set(id, new Map())
    const state = counters.get(id)
    // 仅已见过的深层计数需要复位，restart=0 表示永不随父级复位。
    for (const [depth, counter] of state) {
      if (depth > level && counter.restart && level <= counter.restart - 1) {
        counter.next = counter.start
        counter.current = undefined
      }
    }
    // 取当前值后推进下一项；安全整数检查避免长列表在 JS 数值精度丢失后产生错误编号。
    const counter = state.get(level) || { next: start, start, restart: entry.restart }
    const value = counter.next++
    if (!Number.isSafeInteger(value)) throw new Error("列表编号数值过大")
    counter.current = value
    state.set(level, counter)
    const numbering = { id, level, format: entry.format, value }
    if (letter) {
      // Word 段内计数超过 z 会再次重复字母，不能把变更后的显示值误认成浏览器的下一项。
      if (value < 1 || value > 26 || isStatic) throw new Error("Mewoc 字母编号分段已越界，请在原文档复核编号后重新导出")
      numbering.id = letter.id
      numbering.value = letter.offset + value
    }
    if (isStatic) {
      // 引用的是祖先当前值；从未出现或已重启但尚未再次使用的父级无法可靠确定，不能读旧 last。
      const label = entry.text.replace(/%([1-9])/g, (_, digit) => {
        const depth = Number(digit) - 1
        if (definition(id, depth).format !== "1") throw new Error("组合静态编号暂仅支持十进制层级")
        const current = state.get(depth)?.current
        if (current === undefined) throw new Error("组合编号引用了尚未确定当前值的祖先层级，请保留原 DOCX")
        return String(current)
      })
      numbering.prefix = label + (entry.suffix === "nothing" ? "" : " ")
      warnings.add("组合编号整组已转换为静态编号文字，不会自动续编；保留层级缩进，原制表间隔改为单个空格，请保留原 DOCX")
    }
    return { ...metadata, numbering }
  })
}
