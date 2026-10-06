/**
 * 把附件资源引用写入或移出 ProseMirror 正文，资源字节由会话单独持有。
 * 命令返回是否成功；异步选文件带回的旧选区必须重新核对正文身份，操作各自独立撤销。
 */
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"

// 异步读取结束后仍需验证选区属于当前 doc，且未跨段、进入代码块或处于组合输入中。
export function canInsertAttachment(editor, selection) {
  return Boolean(editor && !editor.isDestroyed && editor.isEditable && !editor.view.composing &&
    selection instanceof TextSelection && selection.$from.doc === editor.state.doc &&
    selection.$from.sameParent(selection.$to) && !selection.$from.parent.type.spec.code)
}

// 恢复选文件之前捕获的文字选区，再插入仅携带 assetId 的附件节点；不在这里读写 Blob。
export function insertAttachmentNode(editor, selection, assetId) {
  if (!canInsertAttachment(editor, selection)) return false
  const inserted = editor.chain().command(({ tr }) => {
    closeHistory(tr)
    // 文件选择器会转移焦点，显式恢复原范围才能让插入替换用户原先选中的文字。
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
