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
  if (original) {
    if (original.type !== values.type) return false
    if (original.latex !== values.latex) {
      editor.view.dispatch(closeHistory(editor.state.tr).setNodeMarkup(selection.from, undefined, { latex: values.latex }))
      editor.view.dispatch(closeHistory(editor.state.tr))
    }
    return true
  }
  const inserted = editor.chain().command(({ tr }) => {
    closeHistory(tr)
    tr.setSelection(selection)
    return true
  }).insertContent({ type: values.type, attrs: { latex: values.latex } }).run()
  if (inserted) editor.view.dispatch(closeHistory(editor.state.tr))
  return inserted
}

export function removeFormula(editor, selection, original) {
  if (!original || !isFormulaTarget(editor, selection, original)) return false
  editor.view.dispatch(closeHistory(editor.state.tr).delete(selection.from, selection.to))
  editor.view.dispatch(closeHistory(editor.state.tr))
  return true
}
