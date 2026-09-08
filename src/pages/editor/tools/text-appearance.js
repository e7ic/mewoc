export function getTextAppearance(editor, position, marks = []) {
  const resolved = editor.state.doc.resolve(position)
  const node = resolved.parent
  const element = resolved.depth ? editor.view.nodeDOM(resolved.before()) : editor.view.dom
  const css = element?.nodeType === 1 ? element.ownerDocument.defaultView.getComputedStyle(element) : null
  const attrs = marks.find(mark => mark.type.name === "textStyle")?.attrs || {}
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

function toPointSize(value) {
  if (!value || !/^[\d.]+(?:px|pt)$/.test(value)) return null
  // CSS 计算字号不受纸张 transform 缩放影响；1 pt = 96 / 72 px。
  const points = parseFloat(value) * (value.endsWith("px") ? 0.75 : 1)
  return `${Number(points.toFixed(4))}pt`
}

function toHexColor(value) {
  if (/^#[0-9a-f]{6}$/i.test(value || "")) return value
  const match = value?.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/)
  return match ? `#${match.slice(1).map(channel => Number(channel).toString(16).padStart(2, "0")).join("")}` : null
}

function getLineHeight(css) {
  if (!css || !parseFloat(css.lineHeight)) return null
  if (/^[\d.]+$/.test(css.lineHeight)) return Number(css.lineHeight)
  const size = parseFloat(css.fontSize)
  return size ? Number((parseFloat(css.lineHeight) / size).toFixed(4)) : null
}
