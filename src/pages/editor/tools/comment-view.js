/** 批注界面订阅纯数据投影，避免默认深比较进入 ProseMirror Node/MarkType 的 schema 循环引用。 */
import { getCommentEntries } from "./document-comments.js"

// PM doc 不可变，按身份缓存一次锚点扫描；WeakMap 不延长已销毁会话和旧正文的生命周期。
const entriesByDocument = new WeakMap()
let nextDocumentVersion = 0

export function selectCommentViewState({ editor }) {
  const { doc, selection } = editor.state
  if (!entriesByDocument.has(doc)) entriesByDocument.set(doc, { entries: getCommentEntries(doc), version: ++nextDocumentVersion })
  const cached = entriesByDocument.get(doc)
  return {
    entries: cached.entries,
    // 文档变化即使不改变批注数量和坐标，也可能改变可批注范围（例如切换代码格式）。
    // 用数字版本驱动读取最新权限，避免把 editor.isEditable 缓存在订阅结果中。
    documentVersion: cached.version,
    selection: { from: selection.from, to: selection.to, empty: selection.empty, type: selection.toJSON().type }
  }
}
