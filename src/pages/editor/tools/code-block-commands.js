/**
 * 代码块的插入、语言切换、退出、缩进和换行命令。
 * 所有位置使用未变化的文档坐标；事务负责映射选区，公共入口拒绝只读、组合输入和过期选区。
 */
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { CODE_LANGUAGES } from "../constants/code-languages.js"

// 支持整块选中或同一代码块内的文本选区，跨块选区不适用代码缩进和语言修改。
export function getCodeBlockTarget(selection) {
  if (selection instanceof NodeSelection && selection.node.type.name === "codeBlock") {
    return { node: selection.node, pos: selection.from }
  }
  if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)
    || selection.$from.parent.type.name !== "codeBlock") return null
  return { node: selection.$from.parent, pos: selection.$from.before() }
}

// 统一检查编辑生命周期与选区所属正文，防止弹层持有的旧位置误改新文档。
function canEditCode(editor, selection = editor.state.selection) {
  return !editor.isDestroyed && editor.isEditable && !editor.view.composing
    && selection?.$from.doc === editor.state.doc
}

// 选区变化可以正常派发；只有正文变化需要隔开撤销分组，让一次工具操作对应一次撤销。
function dispatchCodeChange(editor, transaction) {
  if (!transaction.docChanged) {
    editor.view.dispatch(transaction)
    return
  }
  editor.view.dispatch(closeHistory(transaction))
  // 工具操作两侧都隔开历史，避免紧接着输入时把整次缩进或语言修改一起撤销。
  editor.view.dispatch(closeHistory(editor.state.tr))
}

// 把当前普通段落或标题整体转为纯文本代码块，保留原文字而不额外创建重复内容。
export function insertCodeBlock(editor) {
  const { selection, schema } = editor.state
  if (!canEditCode(editor) || !(selection instanceof TextSelection)
    || !selection.$from.sameParent(selection.$to)) return false
  const node = selection.$from.parent
  if (!["paragraph", "heading"].includes(node.type.name) || !schema.nodes.codeBlock) return false
  let hasInlineNodes = false
  node.forEach(child => { if (!child.isText) hasInlineNodes = true })
  // 转换块类型会丢弃公式等非文本节点，遇到此类内容时拒绝转换。
  if (hasInlineNodes) return false
  const pos = selection.$from.before()
  const transaction = editor.state.tr.setBlockType(pos, pos + node.nodeSize, schema.nodes.codeBlock, { language: "plaintext" })
  if (!transaction.docChanged) return false
  dispatchCodeChange(editor, transaction)
  return true
}

// 只接受菜单支持的语言并只改目标块的 language 属性；选择当前语言视为成功但不新增历史。
export function setCodeBlockLanguage(editor, language, selection = editor.state.selection) {
  if (!canEditCode(editor, selection) || !CODE_LANGUAGES.some(item => item.value === language)) return false
  const target = getCodeBlockTarget(selection)
  if (!target) return false
  if (target.node.attrs.language === language) return true
  dispatchCodeChange(editor, editor.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, language }))
  return true
}

// 把光标移到代码块之后的普通段落；已有相邻段落时复用，缺少时先检查父节点能否插入。
export function exitCodeBlock(editor) {
  if (!canEditCode(editor)) return false
  const target = getCodeBlockTarget(editor.state.selection)
  if (!target) return false
  const { doc, schema } = editor.state
  const after = target.pos + target.node.nodeSize
  const transaction = editor.state.tr
  if (doc.nodeAt(after)?.type !== schema.nodes.paragraph) {
    const position = doc.resolve(after)
    const index = position.index()
    if (!schema.nodes.paragraph || !position.parent.canReplaceWith(index, index, schema.nodes.paragraph)) return false
    transaction.insert(after, schema.nodes.paragraph.create())
  }
  transaction.setSelection(TextSelection.create(transaction.doc, after + 1))
  dispatchCodeChange(editor, transaction)
  return true
}

// 普通 Tab 在空光标处插入两个空格，范围选择则逐行处理；反向操作最多删除一档缩进。
export function indentCodeBlock(editor, reverse = false) {
  const { selection } = editor.state
  if (!canEditCode(editor) || !(selection instanceof TextSelection)) return false
  const target = getCodeBlockTarget(selection)
  if (!target) return false
  const transaction = editor.state.tr
  if (selection.empty && !reverse) {
    dispatchCodeChange(editor, transaction.insertText("  ", selection.from))
    return true
  }
  const changes = getCodeIndentChanges(target, selection, reverse)
  if (!changes.length) return true
  // 从末行向前编辑，前面尚未处理的原始位置不会被后面的插入/删除偏移。
  for (const change of changes.reverse()) {
    if (reverse) transaction.delete(change.pos, change.pos + change.length)
    else transaction.insertText("  ", change.pos)
  }
  // 保留正向/反向选区；边界关联方向决定新增缩进是否仍包含在选区内。
  const anchor = transaction.mapping.map(selection.anchor, selection.anchor === selection.from ? -1 : 1)
  const head = transaction.mapping.map(selection.head, selection.head === selection.from ? -1 : 1)
  transaction.setSelection(TextSelection.create(transaction.doc, anchor, head))
  dispatchCodeChange(editor, transaction)
  return true
}

// 先用原源码计算每一行的绝对编辑位置，返回计划而不修改正文，供调用方倒序提交。
// 反向缩进将一个制表符或最多两个行首空格视为一档，不触碰行内空白。
function getCodeIndentChanges(target, selection, reverse) {
  const text = target.node.textContent
  const base = target.pos + 1
  const from = selection.from - base
  // 选区恰好结束在下一行起点时，该行未被选中。
  const end = selection.empty ? from : selection.to - base - 1
  let start = from ? text.lastIndexOf("\n", from - 1) + 1 : 0
  const changes = []
  while (start <= end) {
    const line = text.slice(start)
    const length = line.startsWith("\t") ? 1 : Math.min(line.match(/^ */)[0].length, 2)
    if (!reverse || length) changes.push({ pos: base + start, length })
    const newline = text.indexOf("\n", start)
    if (newline === -1) break
    start = newline + 1
  }
  return changes
}

// 替换当前选择为换行和本行缩进，使代码输入延续排版；只处理同一个代码块内部的文字。
export function insertCodeNewline(editor) {
  const { selection } = editor.state
  if (!canEditCode(editor) || !(selection instanceof TextSelection)) return false
  const target = getCodeBlockTarget(selection)
  if (!target) return false
  const from = selection.from - target.pos - 1
  const text = target.node.textContent
  const start = from ? text.lastIndexOf("\n", from - 1) + 1 : 0
  // 只继承光标前已有的缩进，避免在行首换行时复制右侧尚未经过的空白。
  const indent = text.slice(start, from).match(/^[\t ]*/)[0]
  dispatchCodeChange(editor, editor.state.tr.insertText(`\n${indent}`, selection.from, selection.to))
  return true
}
