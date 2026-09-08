import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"

// 异步读取结束后仍需验证选区属于当前 doc，且未跨段、进入代码块或处于组合输入中。
export function canInsertAttachment(editor, selection) {
  return Boolean(editor && !editor.isDestroyed && editor.isEditable && !editor.view.composing &&
    selection instanceof TextSelection && selection.$from.doc === editor.state.doc &&
    selection.$from.sameParent(selection.$to) && !selection.$from.parent.type.spec.code)
}

export function insertAttachmentNode(editor, selection, assetId) {
  if (!canInsertAttachment(editor, selection)) return false
  const inserted = editor.chain().command(({ tr }) => {
    closeHistory(tr)
    tr.setSelection(selection)
    return true
  }).insertContent({ type: "attachment", attrs: { assetId } }).run()
  if (inserted) editor.view.dispatch(closeHistory(editor.state.tr))
  return inserted
}

// 只删除正文节点，不删除资源 Blob，让撤销能恢复完整附件；存储清理由保存流程处理。
export function removeAttachment(editor) {
  if (!editor || editor.isDestroyed || !editor.isEditable || editor.view.composing) return false
  const selection = editor.state.selection
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "attachment") return false
  editor.view.dispatch(closeHistory(editor.state.tr).delete(selection.from, selection.to))
  editor.view.dispatch(closeHistory(editor.state.tr))
  return true
}
