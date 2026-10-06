/**
 * 格式刷的来源快照、目标应用和交互状态机。
 * 来源保存在插件状态中，文字/段落修改使用正文事务；单次模式完成后清空，连续模式保留来源。
 */
import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, TextSelection, AllSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { getTextAppearance, getPaintedMarks } from "../tools/text-appearance.js"
import { normalizeParagraphLayout } from "./paragraph-layout.js"

export const FORMAT_PAINTER_KEY = new PluginKey("formatPainter")

// 只复制外观标记；链接、行内代码和目标段落类型不属于格式刷的替换范围。
const MARK_NAMES = ["bold", "italic", "underline", "strike", "textStyle", "superscript", "subscript"]
const TEXT_ATTRIBUTES = ["fontFamily", "fontSize", "color", "backgroundColor", "fontWeight"]
const isParagraph = node => ["paragraph", "heading"].includes(node.type.name)

// 截取选区内可刷的实际文本片段，并记录所属段落位置；代码、非文字节点不参与。
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

// 范围选区取首个可刷文本作为来源；空选区优先采用下一次输入将使用的 storedMarks。
// appearance 补齐 CSS 提供的默认标题样式，locked 表示刷完一次后仍保留来源。
const copySource = (editor, state, locked) => {
  const { selection, storedMarks } = state
  let source = getTextRanges(state)[0]
  if (selection instanceof TextSelection && selection.empty && isParagraph(selection.$from.parent)) {
    source = { from: selection.from, paragraph: selection.$from.parent, marks: storedMarks || selection.$from.marks() }
    if (source.marks.some(mark => mark.type.name === "code")) return null
  }
  if (!source) return null
  // 复制普通数据而非原 mark 对象；textStyle 显式包含空值，使目标多余外观也能被清除。
  const marks = source.marks.filter(mark => MARK_NAMES.includes(mark.type.name)).map(mark => ({
    type: mark.type.name,
    attrs: mark.type.name === "textStyle"
      ? Object.fromEntries(TEXT_ATTRIBUTES.map(name => [name, mark.attrs[name] ?? null])) : undefined
  }))
  const appearance = getTextAppearance(editor, source.from, source.marks)
  const { textAlign, firstLineIndent, leftIndent } = source.paragraph.attrs
  // 复制显式段落设置；null 仍表示沿用目标段落类型的默认间距/分页规则。
  const layout = normalizeParagraphLayout(source.paragraph.attrs)
  return { marks, appearance, paragraph: { textAlign, lineHeight: appearance.lineHeight, firstLineIndent, leftIndent, ...layout }, locked, source: { from: selection.from, to: selection.to } }
}

// 按来源替换允许的文字外观，再对去重后的段落写入外观；链接等非外观标记保持原样，段落属性合并保留。
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
  // 一个段落可能含多个文本片段，Map 保证只写一次；与目标默认相同的行距继续保留 null。
  paragraphs.forEach((node, pos) => {
    const paragraph = { ...source.paragraph }
    if (node.attrs.lineHeight === null && getTextAppearance(editor, pos + 1).lineHeight === paragraph.lineHeight) paragraph.lineHeight = null
    if (Object.keys(paragraph).some(name => node.attrs[name] !== paragraph[name])) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...paragraph })
    }
  })
  // 只有实际变更才关闭正文历史组；即使样式相同，也按单次/连续规则更新插件状态。
  const applied = !tr.doc.eq(doc)
  if (applied) closeHistory(tr)
  const value = source.locked ? { ...source, source: { from: tr.selection.from, to: tr.selection.to } } : null
  tr.setMeta(FORMAT_PAINTER_KEY, { value, applied })
}

// 监听选区完成事件后延迟一帧应用，避免浏览器尚未同步选区时刷到原来源位置。
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
    // 等浏览器完成本轮选区更新后再应用；文档或格式来源已变时丢弃这次延迟操作。
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
        // 显式格式刷元数据优先；其它正文修改会使来源失效，纯选区事务则继续保留。
        const change = tr.getMeta(FORMAT_PAINTER_KEY)
        if (change) return change.value
        return tr.docChanged ? null : value
      }
    },
    // 在格式事务之后再关闭历史分组，避免后续输入与本次格式修改被一起撤销。
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
          // 失焦取消尚未执行的帧，来源仍可在用户回到正文后继续使用。
          cancelFrame()
          return false
        },
        compositionstart: () => {
          // 开始输入法组合时退出格式刷，避免候选确认与延迟样式事务竞争。
          cancelFrame()
          if (FORMAT_PAINTER_KEY.getState(editor.state)) editor.commands.clearFormat()
          return false
        }
      }
    },
    view: () => ({ destroy: cancelFrame })
  })
}

// 命令统一区分 can() 探测与真实 dispatch：复制/清空仅改插件状态，应用才修改正文。
export const FormatPainter = Extension.create({
  name: "formatPainter",
  addCommands() {
    return {
      copyFormat: (locked = false) => ({ state, tr, dispatch, editor }) => {
        // 只有普通文字来源可复制；locked 由连续模式入口提供。
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
        // 提交前重新核对编辑与输入法状态，空选区或无可刷文字不消费来源。
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
