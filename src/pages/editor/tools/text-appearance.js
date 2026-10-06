/**
 * 从实际段落 CSS 与文字 marks 计算工具栏回显和格式刷需要的外观值。
 * 默认标题外观由样式继承，因此不能只读 JSON；写入格式刷时只固化必要差异，以保留文档语义结构。
 */
/**
 * 工具栏回显与格式刷共用的实际外观来源：显式 mark 优先，缺省值读取所在段落的 CSS。
 * 默认标题样式并不一定存在于 JSON 中，仅读取 textStyle 会遗漏字号、颜色和字重。
 */
export function getTextAppearance(editor, position, marks = []) {
  const resolved = editor.state.doc.resolve(position)
  const node = resolved.parent
  const element = resolved.depth ? editor.view.nodeDOM(resolved.before()) : editor.view.dom
  const css = element?.nodeType === 1 ? element.ownerDocument.defaultView.getComputedStyle(element) : null
  const attrs = marks.find(mark => mark.type.name === "textStyle")?.attrs || {}
  // bold 的视觉字重依赖继承基准，按浏览器相对加粗档位推导，避免标题默认粗体被当作普通 400。
  const baseWeight = Number(css?.fontWeight) || 400
  const boldWeight = baseWeight < 350 ? 400 : baseWeight < 550 ? 700 : 900
  return {
    fontFamily: attrs.fontFamily || "",
    fontSize: attrs.fontSize || toPointSize(css?.fontSize) || "12pt",
    fontWeight: attrs.fontWeight || String(marks.some(mark => mark.type.name === "bold") ? boldWeight : baseWeight),
    color: attrs.color || toHexColor(css?.color) || "#252837",
    backgroundColor: attrs.backgroundColor || null,
    lineHeight: node.attrs.lineHeight || getLineHeight(css) || 1.75
  }
}

// 空选区读取待输入格式，范围选区逐段取值；同一属性出现多值时以 mixed 交给控件展示。
export function getSelectionTextStyle(editor) {
  const { selection, storedMarks, doc } = editor.state
  const formats = []
  if (selection.empty) formats.push(getTextAppearance(editor, selection.from, storedMarks || selection.$from.marks()))
  else {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.isText) formats.push(getTextAppearance(editor, Math.max(pos, selection.from), node.marks))
    })
  }
  const defaults = { fontFamily: "", fontSize: "12pt", color: "#252837", backgroundColor: "#fff1ad" }
  const result = { ...defaults }
  Object.keys(defaults).forEach(key => {
    const values = new Set(formats.map(format => format[key] || defaults[key]))
    result[key] = values.size > 1 ? "mixed" : [...values][0] || defaults[key]
  })
  return result
}

// 目标继承样式与来源一致时无需固化默认值；不一致时写显式属性，保持外观而不改标题结构。
export function getPaintedMarks(editor, range, source) {
  const base = getTextAppearance(editor, range.from)
  const marks = source.marks.filter(mark => mark.type !== "textStyle")
  const original = source.marks.find(mark => mark.type === "textStyle")?.attrs || {}
  const attrs = { ...original }
  const boldWeight = Number(base.fontWeight) < 350 ? "400" : Number(base.fontWeight) < 550 ? "700" : "900"
  for (const name of ["fontSize", "color", "fontWeight"]) {
    const inherited = name === "fontWeight" && marks.some(mark => mark.type === "bold") ? boldWeight : base[name]
    attrs[name] = original[name] || (source.appearance[name] === inherited ? null : source.appearance[name])
  }
  if (Object.values(attrs).some(Boolean)) marks.push({ type: "textStyle", attrs })
  return marks.map(mark => editor.schema.marks[mark.type].create(mark.attrs))
}

// 将可识别的计算字号统一为文档契约使用的 pt，限制小数尾差，无法理解的 CSS 值交给上层默认。
function toPointSize(value) {
  if (!value || !/^[\d.]+(?:px|pt)$/.test(value)) return null
  // CSS 计算字号不受纸张 transform 缩放影响；1 pt = 96 / 72 px。
  const points = parseFloat(value) * (value.endsWith("px") ? 0.75 : 1)
  return `${Number(points.toFixed(4))}pt`
}

// 把浏览器不透明 rgb 色值转换为持久白名单要求的六位 HEX；不支持的颜色形式不强行解释。
function toHexColor(value) {
  if (/^#[0-9a-f]{6}$/i.test(value || "")) return value
  const match = value?.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/)
  return match ? `#${match.slice(1).map(channel => Number(channel).toString(16).padStart(2, "0")).join("")}` : null
}

// CSS 无单位行高直接作为倍数，像素行高除以字号换算；normal 等不可计算值由上层提供默认。
function getLineHeight(css) {
  if (!css || !parseFloat(css.lineHeight)) return null
  if (/^[\d.]+$/.test(css.lineHeight)) return Number(css.lineHeight)
  const size = parseFloat(css.fontSize)
  return size ? Number((parseFloat(css.lineHeight) / size).toFixed(4)) : null
}
