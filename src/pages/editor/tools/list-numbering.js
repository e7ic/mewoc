/**
 * 为编号设置固定原有序列表与正文选区，弹层抢焦点或正文移动不会改写另一份列表。
 * 只修改编号外观和起始号，不创建列表，也不改变列表层级与项目内容。
 */
import { TextSelection } from "@tiptap/pm/state"
import { ReplaceAroundStep } from "@tiptap/pm/transform"
import { closeHistory } from "@tiptap/pm/history"
import { canEditRibbon } from "./ribbon-commands.js"

export const LIST_NUMBERING_TYPES = ["1", "a", "A", "i", "I"]
export const LIST_NUMBERING_MAX_START = 999999999
const unavailable = "原有序列表已被删除或替换，请关闭后重新选择。"

// 最近一层普通/待办列表阻断祖先查询，不能在无序或待办子项中意外修改外层编号。
function nearestOrderedList(point) {
  for (let depth = point.depth; depth > 0; depth -= 1) {
    const type = point.node(depth).type.name
    if (["orderedList", "bulletList", "taskList"].includes(type)) return type === "orderedList" ? point.before(depth) : null
  }
  return null
}

function selectedList(doc, selection) {
  if (!(selection instanceof TextSelection)) return null
  const pos = nearestOrderedList(selection.$anchor)
  if (pos === null || nearestOrderedList(selection.$head) !== pos) return null
  // 两端同属外层列表时，中间仍可能选中另一个嵌套有序列表；逐文字块核对整个范围。
  let sameList = true
  if (!selection.empty) doc.nodesBetween(selection.from, selection.to, (node, nodePos) => {
    if (!node.isTextblock) return
    if (nearestOrderedList(doc.resolve(nodePos + 1)) !== pos) sameList = false
    return false
  })
  return sameList ? { pos, node: doc.nodeAt(pos), selection } : null
}

// 可用性只取决于选区结构，避免 setEditable 恢复编辑却没有事务时缓存了旧禁用状态。
export function supportsListNumberingSelection(editor) {
  return Boolean(editor && !editor.isDestroyed && selectedList(editor.state.doc, editor.state.selection))
}

const settingsOf = node => ({ type: node.attrs.type || "1", start: node.attrs.start ?? 1 })

export function getListNumberingState(editor) {
  if (!editor || editor.isDestroyed) return null
  const context = selectedList(editor.state.doc, editor.state.selection)
  return context ? settingsOf(context.node) : null
}

// 保留 editor 身份、原 doc、列表开头 token 和选区书签；光标后来移到别处不能改变操作对象。
export function captureListNumberingTarget(editor) {
  if (!canEditRibbon(editor)) return null
  const { doc, selection, storedMarks } = editor.state
  const context = selectedList(doc, selection)
  return context ? { editor, doc, pos: context.pos, bookmark: selection.getBookmark(), storedMarks, valid: true } : null
}

// setNodeMarkup 仅替换列表外壳并保留内容，属于同一目标；整节点 replaceWith 即使内容相同也拒绝。
function isListMarkup(step, pos, node) {
  return step instanceof ReplaceAroundStep && step.structure && step.from === pos && step.to === pos + node.nodeSize &&
    step.gapFrom === pos + 1 && step.gapTo === pos + node.nodeSize - 1 && step.insert === 1
}

// 调用方按顺序映射主事务和所有追加事务，原列表消失后永久失效，不能被新列表复活。
export function mapListNumberingTarget(target, transaction) {
  if (!target?.valid) return false
  if (target.doc !== transaction.before) { target.valid = false; return false }
  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index]
    const node = transaction.docs[index].nodeAt(target.pos)
    const after = transaction.docs[index + 1] || transaction.doc
    const mapped = step.getMap().mapResult(target.pos, 1)
    if (node?.type.name !== "orderedList" || mapped.deleted && !isListMarkup(step, target.pos, node) || after.nodeAt(mapped.pos)?.type.name !== "orderedList") {
      target.valid = false
      return false
    }
    target.pos = mapped.pos
  }
  target.bookmark = target.bookmark.map(transaction.mapping)
  target.doc = transaction.doc
  return true
}

function getTarget(editor, target) {
  if (!editor || editor.isDestroyed || target?.editor !== editor || !target.valid || target.doc !== editor.state.doc) return null
  try {
    const context = selectedList(editor.state.doc, target.bookmark.resolve(editor.state.doc))
    return context?.pos === target.pos ? context : null
  } catch { return null }
}

export function readListNumberingSettings(editor, target) {
  const context = getTarget(editor, target)
  return context ? settingsOf(context.node) : null
}

// 完整草稿必须通过枚举、整数与上限检查；同值直接返回，不制造正文更新或撤销记录。
export function applyListNumbering(editor, target, value, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再应用。" }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["type", "start"].includes(key)) ||
    !LIST_NUMBERING_TYPES.includes(value.type) || !Number.isInteger(value.start) || value.start < 1 || value.start > LIST_NUMBERING_MAX_START) {
    return { ok: false, error: `请选择有效编号样式，起始编号须为 1–${LIST_NUMBERING_MAX_START} 的整数。` }
  }
  const context = getTarget(editor, target)
  if (!context) return { ok: false, error: unavailable }
  const current = settingsOf(context.node)
  if (current.type === value.type && current.start === value.start) return { ok: true, changed: false }
  const tr = closeHistory(editor.state.tr).setNodeMarkup(context.pos, undefined, { ...context.node.attrs, type: value.type, start: value.start })
  tr.setSelection(context.selection.map(tr.doc, tr.mapping))
  if (tr.selection.empty) tr.setStoredMarks(target.storedMarks || null)
  editor.view.dispatch(tr.scrollIntoView())
  // 编号调整与前后文字输入分别撤销，一次应用两个字段仍只产生一个正文事务。
  editor.view.dispatch(closeHistory(editor.state.tr))
  return { ok: true, changed: true }
}
