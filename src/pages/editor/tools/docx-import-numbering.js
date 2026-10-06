/**
 * 从 Word 原始 XML 计算每个有效段落的标题、缩进及列表编号元数据。
 * 样式继承和 numId/lvl 定义在这里解释，后续 HTML 转换不再承担 Word 的计数规则。
 */
import { getXmlChildren, getWordChild, getWordValue, WORD_XML } from "./docx-import-xml.js"

// 将支持的 OOXML 编号类型映射为编辑器的列表属性；未映射的类型必须明确拒绝。
const FORMATS = { decimal: "1", lowerLetter: "a", upperLetter: "A", lowerRoman: "i", upperRoman: "I", bullet: "bullet" }

// 编号身份属于 numId，层级定义来自 abstractNum；同一身份被普通段落打断后仍继续计数。
export function readDocxParagraphs(xml, numbering, styles, warnings) {
  // 建索引后按样式 ID/编号身份查找，计数器按 numId 独立保存，跨普通段落和表格仍能续编。
  const styleMap = new Map(Array.from(styles?.getElementsByTagNameNS(WORD_XML, "style") || []).map(style => [style.getAttributeNS(WORD_XML, "styleId"), style]))
  const abstracts = new Map(Array.from(numbering?.getElementsByTagNameNS(WORD_XML, "abstractNum") || []).map(node => [node.getAttributeNS(WORD_XML, "abstractNumId"), node]))
  const definitions = new Map(Array.from(numbering?.getElementsByTagNameNS(WORD_XML, "num") || []).map(node => [node.getAttributeNS(WORD_XML, "numId"), node]))
  const counters = new Map()
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
  return Array.from(xml.getElementsByTagNameNS(WORD_XML, "p")).filter(paragraph => {
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
    const definition = definitions.get(numId)
    const abstract = abstracts.get(getWordValue(definition, "abstractNumId"))
    if (!definition || !abstract || getWordChild(abstract, "numStyleLink")) throw new Error("Word 列表编号定义缺失或使用暂不支持的样式链接")
    // 实例级 lvlOverride 优先于抽象定义；起点也优先采用 startOverride，不能一律从 1 开始。
    const override = getXmlChildren(definition).find(node => node.localName === "lvlOverride" && node.getAttributeNS(WORD_XML, "ilvl") === String(level))
    const entry = getWordChild(override, "lvl") || getXmlChildren(abstract).find(node => node.localName === "lvl" && node.getAttributeNS(WORD_XML, "ilvl") === String(level))
    const format = FORMATS[getWordValue(entry, "numFmt")]
    const start = Number(getWordValue(override, "startOverride") ?? getWordValue(entry, "start") ?? 1)
    if (!entry || !format || !Number.isSafeInteger(start) || start < 1) throw new Error("Word 列表编号样式或起始值暂不支持")
    // 编辑器只能表示单级数字/字母/罗马编号，复合父级前缀和自定义装饰不能静默简化。
    const text = getWordValue(entry, "lvlText")
    if (format !== "bullet" && text !== `%${level + 1}.` && text !== `%${level + 1})`) throw new Error("组合编号或自定义编号前后缀暂不支持，请先转换为单级数字或字母编号")
    if (text?.endsWith(")")) warnings.add("列表编号后的右括号已转换为句点")
    if (getWordChild(entry, "isLgl") || getWordChild(entry, "lvlPicBulletId")) throw new Error("法律编号或图片项目符号暂不支持")
    const restart = Number(getWordValue(entry, "lvlRestart") ?? level)
    if (!Number.isInteger(restart) || restart < 0 || restart > level) throw new Error("列表重新编号层级无效")
    // 未直接/继承声明缩进时使用编号定义的缩进；两者都缺失才采用每层 480 twip 的估计值。
    if (!hasIndent) {
      const ind = getWordChild(getWordChild(entry, "pPr"), "ind")
      metadata.indent = Number(ind?.getAttributeNS(WORD_XML, "left") || ind?.getAttributeNS(WORD_XML, "start") || (level + 1) * 480)
    }
    let state = counters.get(numId)
    if (!state) {
      state = new Map()
      counters.set(numId, state)
    }
    // 仅已见过的深层计数需要复位，restart=0 表示永不随父级复位。
    for (const [depth, counter] of state) {
      if (depth > level && counter.restart && level <= counter.restart - 1) counter.next = counter.start
    }
    // 取当前值后推进下一项；安全整数检查避免长列表在 JS 数值精度丢失后产生错误编号。
    const counter = state.get(level) || { next: start, start, restart }
    const value = counter.next++
    if (!Number.isSafeInteger(value)) throw new Error("列表编号数值过大")
    state.set(level, counter)
    return { ...metadata, numbering: { id: numId, level, format, value } }
  })
}
