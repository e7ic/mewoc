/**
 * 管理文档根属性中的批注线程及文字上的定位 marks，并为面板和导出计算实时引用。
 * 创建、编辑、解决和删除通过正文事务提交，使元数据与定位一起保存和撤销；孤立线程继续保留。
 */
import { TextSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { createId } from "./create-id.js"

// 限制线程数、正文和创建时引用长度，避免批注作为正文外元数据绕过文档容量约束。
export const MAX_COMMENTS = 200
export const MAX_COMMENT_LENGTH = 2000
export const MAX_COMMENT_QUOTE_LENGTH = 500
const THREAD_KEYS = ["id", "text", "quote", "createdAt", "updatedAt", "resolved"]
const CONTAINER_TYPES = new Set(["paragraph", "heading", "codeBlock", "blockquote", "bulletList", "orderedList", "listItem", "table", "tableRow", "tableCell", "tableHeader"])

// 批注身份仅允许短字母、数字和连字符，供线程校验与面板操作共同使用。
export function isCommentId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value)
}

// 允许常规换行和制表符用于批注排版，拒绝不可显示控制字符；正文还可以要求非空白。
function isSafeText(value, maxLength, nonempty = false) {
  return typeof value === "string" && value.length <= maxLength
    && (!nonempty || !!value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
}

// 同时校验 ISO 表达形式、可解析性和真实日历范围，避免导入时接受浏览器自动顺延的日期。
function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) return false
  // Date.parse 会把 2 月 30 日顺延到 3 月；显式检查日历，避免“有效时间戳”掩盖无效日期。
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60 && second < 60
}

// null 是旧文档和无批注文档的缺省值；外部文件不做静默修复，非法元数据直接拒绝。
export function validateCommentThreads(value) {
  if (value === null || value === undefined) return value
  if (!Array.isArray(value) || value.length > MAX_COMMENTS) throw new Error("批注列表格式无效，最多保存 200 条批注")
  // 线程字段严格按固定契约接受，并检查 ID 去重；不补齐或丢弃非法字段，以便提示损坏输入。
  const ids = new Set()
  for (const thread of value) {
    if (!thread || typeof thread !== "object" || Array.isArray(thread)
      || Object.keys(thread).length !== THREAD_KEYS.length || Object.keys(thread).some(key => !THREAD_KEYS.includes(key))
      || !isCommentId(thread.id) || ids.has(thread.id)
      || !isSafeText(thread.text, MAX_COMMENT_LENGTH, true) || !isSafeText(thread.quote, MAX_COMMENT_QUOTE_LENGTH)
      || !isIsoDate(thread.createdAt) || !isIsoDate(thread.updatedAt) || typeof thread.resolved !== "boolean") {
      throw new Error("批注内容无效，请检查 ID、正文、引用文字及时间字段")
    }
    ids.add(thread.id)
  }
  return value
}

// 读取前重新校验并浅克隆每个线程，面板临时编辑不会直接修改文档根属性。
export function getCommentThreads(doc) {
  const value = doc?.attrs?.commentThreads
  validateCommentThreads(value)
  return (value || []).map(thread => ({ ...thread }))
}

// JSON 分支只计算标准文档容器的位置；文本和叶节点的长度与 ProseMirror 一致。
function visitJsonText(node, pos, visit) {
  if (node.type === "text") {
    visit(node, pos)
    return node.text?.length || 0
  }
  const root = node.type === "doc"
  const container = root || CONTAINER_TYPES.has(node.type) || Array.isArray(node.content)
  if (!container) return 1
  let offset = root ? pos : pos + 1
  for (const child of node.content || []) offset += visitJsonText(child, offset, visit)
  return offset - pos + (root ? 0 : 1)
}

// 支持 ProseMirror 文档和便携 JSON 两种输入；合并线程元数据、当前位置范围与当前引用文字。
export function getCommentEntries(doc) {
  const entries = getCommentThreads(doc).map(thread => ({ ...thread, ranges: [], anchorText: "", orphaned: true }))
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const fragments = new Map(entries.map(entry => [entry.id, []]))
  // 只收集带有效线程 ID 的文字锚点；邻接文本合并范围，非邻接片段在引用中用换行区分。
  const visit = (node, pos) => {
    if (!node.isText && node.type !== "text") return
    const text = node.text || ""
    for (const mark of node.marks || []) {
      if ((mark.type.name || mark.type) !== "commentAnchor") continue
      const entry = byId.get(mark.attrs?.id)
      if (!entry) continue
      const previous = entry.ranges.at(-1)
      if (previous?.to === pos) previous.to += text.length
      else entry.ranges.push({ from: pos, to: pos + text.length })
      fragments.get(entry.id).push({ pos, text })
      entry.orphaned = false
    }
  }
  if (typeof doc?.descendants === "function") doc.descendants(visit)
  else if (doc) visitJsonText(doc, 0, visit)
  for (const entry of entries) {
    let previousEnd = null
    entry.anchorText = fragments.get(entry.id).map(fragment => {
      const separator = previousEnd !== null && previousEnd !== fragment.pos ? "\n" : ""
      previousEnd = fragment.pos + fragment.text.length
      return separator + fragment.text
    }).join("")
  }
  return entries
}

// 批注正文操作统一拒绝只读、销毁和组合输入，避免输入法尚未提交时拆分文字定位。
function canEdit(editor) {
  return !!editor && !editor.isDestroyed && editor.isEditable && !editor.view.composing
}

// 按操作条件逐层返回可展示的原因：生命周期、选区身份、容量，再检查具体文字内容。
// 非文字原子节点和已有批注不接受新锚点，避免定位范围含义不清或批注重叠。
export function getCommentSelectionError(editor, selection = editor?.state?.selection) {
  if (!editor || editor.isDestroyed || !editor.isEditable) return "只读文档不能添加批注"
  if (editor.view.composing) return "请先完成输入法候选，再添加批注"
  if (selection?.$from?.doc !== editor.state.doc || selection?.$to?.doc !== editor.state.doc) return "正文已变化，请重新选择文字"
  if (!(selection instanceof TextSelection) || selection.empty) return "请先选中需要批注的文字"
  if (!editor.state.schema.marks.commentAnchor) return "当前文档不支持批注"
  if (getCommentThreads(editor.state.doc).length >= MAX_COMMENTS) return "批注已达到 200 条上限"
  let error = ""
  let hasText = false
  // 逐节点检查实际相交文字及父节点 mark 能力，不能只凭选区首尾推断中间内容都可批注。
  editor.state.doc.nodesBetween(selection.from, selection.to, (node, pos, parent) => {
    if (error) return false
    if (node.type.name === "codeBlock" || (node.isAtom && !node.isText)) {
      error = "请选择普通文字，批注选区不能包含代码块、图片、公式或附件"
      return false
    }
    if (!node.isText || pos >= selection.to || pos + node.nodeSize <= selection.from) return
    hasText = true
    if (!parent.type.allowsMarkType(editor.state.schema.marks.commentAnchor)) error = "这段文字不能添加批注"
    else if (node.marks.some(mark => mark.type.name === "commentAnchor")) error = "当前选区包含已有批注，请选择其他文字"
  })
  if (!error && hasText && !isSafeText(editor.state.doc.textBetween(selection.from, selection.to, "\n").slice(0, MAX_COMMENT_QUOTE_LENGTH), MAX_COMMENT_QUOTE_LENGTH)) {
    error = "所选文字含有不支持的控制字符，请重新选择文字"
  }
  return error || (hasText ? "" : "请先选中需要批注的文字")
}

// 提交时去掉首尾空白并验证正文，使用 null 明确区分非法输入与合法字符串。
function normalizedText(text) {
  if (typeof text !== "string") return null
  const value = text.trim()
  return isSafeText(value, MAX_COMMENT_LENGTH, true) ? value : null
}

// 线程和文字锚点已在一个事务中准备完成，派发后关闭分组，避免批注修改与继续打字合并撤销。
function dispatchChange(editor, transaction) {
  editor.view.dispatch(closeHistory(transaction))
  // 将批注操作与前后的输入分别隔开；元数据和锚点仍在同一事务内撤销。
  editor.view.dispatch(closeHistory(editor.state.tr))
}

// 创建固定的原始引用和时间，再把线程及锚点原子提交；成功返回新 ID，供面板立即选中。
export function addDocumentComment(editor, selection = editor?.state?.selection, text) {
  const value = normalizedText(text)
  if (value === null || getCommentSelectionError(editor, selection)) return false
  const threads = getCommentThreads(editor.state.doc)
  const id = createId()
  const time = new Date().toISOString()
  const quote = editor.state.doc.textBetween(selection.from, selection.to, "\n").slice(0, MAX_COMMENT_QUOTE_LENGTH)
  const thread = { id, text: value, quote, createdAt: time, updatedAt: time, resolved: false }
  const transaction = editor.state.tr
    .setDocAttribute("commentThreads", [...threads, thread])
    .addMark(selection.from, selection.to, editor.state.schema.marks.commentAnchor.create({ id }))
  dispatchChange(editor, transaction)
  return id
}

// 仅更新匹配线程的正文与更新时间，保留原引用和定位；内容相同则不产生无意义编辑。
export function updateDocumentComment(editor, id, text) {
  const value = normalizedText(text)
  if (!canEdit(editor) || !isCommentId(id) || value === null) return false
  const threads = getCommentThreads(editor.state.doc)
  const target = threads.find(thread => thread.id === id)
  if (!target) return false
  if (target.text === value) return true
  const updated = { ...target, text: value, updatedAt: new Date().toISOString() }
  dispatchChange(editor, editor.state.tr.setDocAttribute("commentThreads", threads.map(thread => thread.id === id ? updated : thread)))
  return true
}

// 解决状态只影响线程元数据，不移除锚点；恢复未解决状态仍能定位原文字。
export function setCommentResolved(editor, id, resolved) {
  if (!canEdit(editor) || !isCommentId(id) || typeof resolved !== "boolean") return false
  const threads = getCommentThreads(editor.state.doc)
  const target = threads.find(thread => thread.id === id)
  if (!target) return false
  if (target.resolved === resolved) return true
  const updated = { ...target, resolved, updatedAt: new Date().toISOString() }
  dispatchChange(editor, editor.state.tr.setDocAttribute("commentThreads", threads.map(thread => thread.id === id ? updated : thread)))
  return true
}

// 先验证线程存在，再在同一事务删除线程与所有匹配文字 marks，使撤销能完整恢复批注。
export function removeDocumentComment(editor, id) {
  if (!canEdit(editor) || !isCommentId(id)) return false
  const threads = getCommentThreads(editor.state.doc)
  if (!threads.some(thread => thread.id === id)) return false
  const transaction = editor.state.tr.setDocAttribute("commentThreads", threads.filter(thread => thread.id !== id))
  // 只移除本条锚点；跨段或被编辑拆开的多个片段都在同一个事务中清理。
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find(item => item.type.name === "commentAnchor" && item.attrs.id === id)
    if (mark) transaction.removeMark(pos, pos + node.nodeSize, mark)
  })
  dispatchChange(editor, transaction)
  return true
}

// 根据最新正文计算的范围定位；引用已全部删除的孤立线程可阅读，但没有可恢复的文字选区。
export function focusDocumentComment(editor, id) {
  if (!editor || editor.isDestroyed || editor.view.composing || !isCommentId(id)) return false
  const entry = getCommentEntries(editor.state.doc).find(item => item.id === id)
  if (!entry || entry.orphaned) return false
  const from = entry.ranges[0].from
  const to = entry.ranges.at(-1).to
  // 只改选区，历史预览等只读编辑器也能定位，不触发文档更新或自动保存。
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)).scrollIntoView())
  return true
}
