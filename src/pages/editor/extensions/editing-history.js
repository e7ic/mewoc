/** 工具栏格式与任务勾选的历史边界；普通连续输入仍使用编辑器原有的历史分组。 */
import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"

const EDITING_HISTORY_KEY = new PluginKey("mewocEditingHistory")

// 只有实际正文变化才隔开历史，can() 探测与空光标 storedMarks 不制造空撤销步骤。
export function runEditingCommand(context, command) {
  const { editor, tr, dispatch } = context
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return false
  const before = tr.doc
  const success = command()
  if (success && dispatch && !tr.doc.eq(before)) {
    closeHistory(tr).setMeta(EDITING_HISTORY_KEY, true)
  }
  return success
}

export const EditingHistory = Extension.create({
  name: "editingHistory",
  // 历史收尾必须排在 trailingNode 等正文补全插件之后。否则先 closeHistory 再追加空段，
  // 同一次“创建列表”会被拆成两个撤销事件，首次撤销只能删尾段，列表却仍然存在。
  priority: -1000,
  addProseMirrorPlugins() {
    return [new Plugin({
      key: EDITING_HISTORY_KEY,
      // 后续输入不能再合并到本次格式操作；这个收尾事务自身不进入历史。
      appendTransaction: (transactions, oldState, state) => transactions.some(tr => tr.getMeta(EDITING_HISTORY_KEY))
        ? closeHistory(state.tr).setMeta("addToHistory", false) : null
    })]
  }
})
