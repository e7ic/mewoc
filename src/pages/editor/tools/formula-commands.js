/**
 * 管理公式弹窗提交后的插入、源码更新和删除事务。
 * 弹窗保存的是原选区和公式身份，提交时重新核对，避免异步交互期间覆盖已变化的目标。
 */
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { FORMULA_TYPES, getFormulaSourceError } from "./formula.js"

// 编辑旧公式时同时校验节点类型和打开弹窗时的源码，避免覆盖期间已被修改的目标。
function isFormulaTarget(editor, selection, original) {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing || !selection || selection.$from.doc !== editor.state.doc) return false
  if (original) {
    return selection instanceof NodeSelection && selection.node.type.name === original.type
      && selection.node.attrs.latex === original.latex
  }
  return selection instanceof TextSelection && !selection.$from.parent.type.spec.code && !selection.$to.parent.type.spec.code
}

// original 区分编辑与新插入；编辑只改源码，不在行内/独立类型之间隐式转换。
export function applyFormula(editor, selection, values, original = null) {
  if (!FORMULA_TYPES.includes(values.type) || getFormulaSourceError(values.latex) || !isFormulaTarget(editor, selection, original)) return false
  // 已有公式只更新同一种节点的源码，避免一次编辑隐式改变行内/独立布局；源码未变则直接成功。
  if (original) {
    if (original.type !== values.type) return false
    if (original.latex !== values.latex) {
      editor.view.dispatch(closeHistory(editor.state.tr).setNodeMarkup(selection.from, undefined, { latex: values.latex }))
      editor.view.dispatch(closeHistory(editor.state.tr))
    }
    return true
  }
  // 新公式使用弹窗打开时的选区，前后关闭历史分组，让整次插入可独立撤销。
  const inserted = editor.chain().command(({ tr }) => {
    closeHistory(tr)
    tr.setSelection(selection)
    return true
  }).insertContent({ type: values.type, attrs: { latex: values.latex } }).run()
  if (inserted) editor.view.dispatch(closeHistory(editor.state.tr))
  return inserted
}

// 只有仍匹配原公式的节点选区可以删除，防止旧弹窗删除后来插入到同位置的其他内容。
export function removeFormula(editor, selection, original) {
  if (!original || !isFormulaTarget(editor, selection, original)) return false
  editor.view.dispatch(closeHistory(editor.state.tr).delete(selection.from, selection.to))
  editor.view.dispatch(closeHistory(editor.state.tr))
  return true
}
