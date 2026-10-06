/** 上下标使用互斥的文字标记；原生 sup/sub 同时用于内部剪贴板与独立 HTML。 */
import { isMarkActive, Mark } from "@tiptap/core"
import { runEditingCommand } from "./editing-history.js"

// 选择判定不依赖编辑/只读状态，UI selector 缓存它后仍能在 setEditable(false, false) 往返时恢复。
function getScriptSelection(state, name, action) {
  if (!["superscript", "subscript"].includes(name)) return null
  const type = state.schema.marks[name]
  if (!type) return null
  const opposite = name === "superscript" ? "subscript" : "superscript"
  const remove = action === "unset" || (action === "toggle" && isMarkActive(state, name))
  const permits = (parent, marks) => parent.type.allowsMarkType(type)
    && (remove || !marks.some(mark => mark.type.name !== opposite && mark.type !== type && mark.type.excludes(type)))
  if (state.selection.empty) {
    const marks = state.storedMarks || state.selection.$from.marks()
    return permits(state.selection.$from.parent, marks) ? { type, remove, ranges: null } : null
  }
  const ranges = []
  state.selection.ranges.forEach(({ $from, $to }) => state.doc.nodesBetween($from.pos, $to.pos, (node, pos, parent) => {
    const from = Math.max(pos, $from.pos)
    const to = Math.min(pos + node.nodeSize, $to.pos)
    if (node.isText && from < to && permits(parent, node.marks)) ranges.push({ from, to })
  }))
  return ranges.length ? { type, remove, ranges } : null
}

export function supportsTextScriptSelection(editor, name) {
  return !!editor && !!getScriptSelection(editor.state, name, "toggle")
}

function applyScript(context, name, action) {
  return runEditingCommand(context, () => {
    const { state, tr, dispatch } = context
    const target = getScriptSelection(state, name, action)
    if (!target) return false
    const { type, remove, ranges } = target
    if (ranges === null) {
      if (dispatch) {
        if (remove) tr.removeStoredMark(type)
        else tr.addStoredMark(type.create())
      }
      return true
    }
    // 官方 setMark 的 can 探测会把相反上下标视为阻塞标记；这里允许显式互换，仍排除行内代码。
    if (dispatch) ranges.forEach(({ from, to }) => {
      if (remove) tr.removeMark(from, to, type)
      else tr.addMark(from, to, type.create())
    })
    return true
  })
}

function createScriptMark(name, tag, opposite) {
  const commandName = name[0].toUpperCase() + name.slice(1)
  return Mark.create({
    name,
    excludes: `${name} ${opposite}`,
    parseHTML: () => [{ tag }, { style: `vertical-align=${tag === "sup" ? "super" : "sub"}` }],
    renderHTML: () => [tag, 0],
    addCommands() {
      return {
        [`set${commandName}`]: () => context => applyScript(context, name, "set"),
        [`toggle${commandName}`]: () => context => applyScript(context, name, "toggle"),
        [`unset${commandName}`]: () => context => applyScript(context, name, "unset")
      }
    }
  })
}

export const Superscript = createScriptMark("superscript", "sup", "subscript")
export const Subscript = createScriptMark("subscript", "sub", "superscript")
