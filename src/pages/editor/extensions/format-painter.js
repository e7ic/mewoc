import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, TextSelection, AllSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { getTextAppearance, getPaintedMarks } from "../tools/text-appearance.js"

export const FORMAT_PAINTER_KEY = new PluginKey("formatPainter")

const MARK_NAMES = ["bold", "italic", "underline", "strike", "textStyle"]
const TEXT_ATTRIBUTES = ["fontFamily", "fontSize", "color", "backgroundColor", "fontWeight"]
const isParagraph = node => ["paragraph", "heading"].includes(node.type.name)

const getTextRanges = ({ doc, selection }) => {
  const ranges = []
  if (selection.empty || !(selection instanceof TextSelection || selection instanceof AllSelection)) return ranges
  doc.nodesBetween(selection.from, selection.to, (node, pos, parent) => {
    if (!node.isText || !isParagraph(parent) || node.marks.some(mark => mark.type.name === "code")) return
    const from = Math.max(pos, selection.from)
    const to = Math.min(pos + node.nodeSize, selection.to)
    if (from < to) ranges.push({ from, to, marks: node.marks, paragraph: parent, pos: doc.resolve(pos).before() })
  })
  return ranges
}

const copySource = (editor, state, locked) => {
  const { selection, storedMarks } = state
  let source = getTextRanges(state)[0]
  if (selection instanceof TextSelection && selection.empty && isParagraph(selection.$from.parent)) {
    source = { from: selection.from, paragraph: selection.$from.parent, marks: storedMarks || selection.$from.marks() }
    if (source.marks.some(mark => mark.type.name === "code")) return null
  }
  if (!source) return null
  const marks = source.marks.filter(mark => MARK_NAMES.includes(mark.type.name)).map(mark => ({
    type: mark.type.name,
    attrs: mark.type.name === "textStyle"
      ? Object.fromEntries(TEXT_ATTRIBUTES.map(name => [name, mark.attrs[name] ?? null])) : undefined
  }))
  const appearance = getTextAppearance(editor, source.from, source.marks)
  const { textAlign, firstLineIndent, leftIndent } = source.paragraph.attrs
  return { marks, appearance, paragraph: { textAlign, lineHeight: appearance.lineHeight, firstLineIndent, leftIndent }, locked, source: { from: selection.from, to: selection.to } }
}

const applySource = (editor, tr, ranges, source) => {
  // 一次格式应用独立成组，前后的普通输入各自保留撤销边界。
  const doc = tr.doc
  const paragraphs = new Map()
  ranges.forEach(range => {
    const marks = getPaintedMarks(editor, range, source)
    MARK_NAMES.forEach(name => {
      const current = range.marks.find(mark => mark.type.name === name)
      const next = marks.find(mark => mark.type.name === name)
      if (current && (!next || !current.eq(next))) tr.removeMark(range.from, range.to, current)
      if (next && (!current || !next.eq(current))) tr.addMark(range.from, range.to, next)
    })
    paragraphs.set(range.pos, range.paragraph)
  })
  paragraphs.forEach((node, pos) => {
    const paragraph = { ...source.paragraph }
    if (node.attrs.lineHeight === null && getTextAppearance(editor, pos + 1).lineHeight === paragraph.lineHeight) paragraph.lineHeight = null
    if (Object.keys(paragraph).some(name => node.attrs[name] !== paragraph[name])) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...paragraph })
    }
  })
  const applied = !tr.doc.eq(doc)
  if (applied) closeHistory(tr)
  const value = source.locked ? { ...source, source: { from: tr.selection.from, to: tr.selection.to } } : null
  tr.setMeta(FORMAT_PAINTER_KEY, { value, applied })
}

const createPainterPlugin = editor => {
  let frame = null
  const cancelFrame = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }
  const scheduleApply = view => {
    cancelFrame()
    const source = FORMAT_PAINTER_KEY.getState(view.state)
    const doc = view.state.doc
    if (!source) return false
    frame = requestAnimationFrame(() => {
      frame = null
      if (editor.isDestroyed || !editor.isEditable || view.composing || !view.hasFocus()) return
      if (view.state.doc !== doc || FORMAT_PAINTER_KEY.getState(view.state) !== source) return
      const { from, to } = view.state.selection
      if (from === source.source.from && to === source.source.to) return
      editor.commands.applyFormat()
    })
    return false
  }
  return new Plugin({
    key: FORMAT_PAINTER_KEY,
    state: {
      init: () => null,
      apply: (tr, value) => {
        const change = tr.getMeta(FORMAT_PAINTER_KEY)
        if (change) return change.value
        return tr.docChanged ? null : value
      }
    },
    appendTransaction: (transactions, oldState, state) => transactions.some(tr => tr.getMeta(FORMAT_PAINTER_KEY)?.applied)
      ? closeHistory(state.tr).setMeta("addToHistory", false) : null,
    props: {
      attributes: state => FORMAT_PAINTER_KEY.getState(state) ? { "data-format-painter": "active" } : {},
      handleKeyDown: (view, event) => {
        if (event.key !== "Escape" || event.isComposing || !FORMAT_PAINTER_KEY.getState(view.state)) return false
        cancelFrame()
        return editor.commands.clearFormat()
      },
      handleDOMEvents: {
        mouseup: (view, event) => event.button === 0 ? scheduleApply(view) : false,
        keyup: (view, event) => {
          // 按住 Shift 连续扩展选区时，等松开 Shift 后再刷，避免首个箭头就消耗单次模式。
          if (event.key === "Shift" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")) {
            return scheduleApply(view)
          }
          return false
        },
        blur: () => {
          cancelFrame()
          return false
        },
        compositionstart: () => {
          cancelFrame()
          if (FORMAT_PAINTER_KEY.getState(editor.state)) editor.commands.clearFormat()
          return false
        }
      }
    },
    view: () => ({ destroy: cancelFrame })
  })
}

export const FormatPainter = Extension.create({
  name: "formatPainter",
  addCommands() {
    return {
      copyFormat: (locked = false) => ({ state, tr, dispatch, editor }) => {
        if (!editor.isEditable || editor.view.composing) return false
        const value = copySource(editor, state, locked)
        if (!value) return false
        if (dispatch) tr.setMeta(FORMAT_PAINTER_KEY, { value })
        return true
      },
      clearFormat: () => ({ tr, dispatch }) => {
        if (dispatch) tr.setMeta(FORMAT_PAINTER_KEY, { value: null })
        return true
      },
      applyFormat: () => ({ state, tr, dispatch, editor }) => {
        const source = FORMAT_PAINTER_KEY.getState(state)
        if (!source || !editor.isEditable || editor.view.composing) return false
        const ranges = getTextRanges(state)
        if (!ranges.length) return false
        if (dispatch) applySource(editor, tr, ranges, source)
        return true
      }
    }
  },
  addProseMirrorPlugins() {
    return [createPainterPlugin(this.editor)]
  }
})
