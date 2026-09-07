import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { CODE_LANGUAGES } from "../constants/code-languages.js"

export function getCodeBlockTarget(selection) {
  if (selection instanceof NodeSelection && selection.node.type.name === "codeBlock") {
    return { node: selection.node, pos: selection.from }
  }
  if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)
    || selection.$from.parent.type.name !== "codeBlock") return null
  return { node: selection.$from.parent, pos: selection.$from.before() }
}

function canEditCode(editor, selection = editor.state.selection) {
  return !editor.isDestroyed && editor.isEditable && !editor.view.composing
    && selection?.$from.doc === editor.state.doc
}

function dispatchCodeChange(editor, transaction) {
  if (!transaction.docChanged) {
    editor.view.dispatch(transaction)
    return
  }
  editor.view.dispatch(closeHistory(transaction))
  // 工具操作两侧都隔开历史，避免紧接着输入时把整次缩进或语言修改一起撤销。
  editor.view.dispatch(closeHistory(editor.state.tr))
}

export function insertCodeBlock(editor) {
  const { selection, schema } = editor.state
  if (!canEditCode(editor) || !(selection instanceof TextSelection)
    || !selection.$from.sameParent(selection.$to)) return false
  const node = selection.$from.parent
  if (!["paragraph", "heading"].includes(node.type.name) || !schema.nodes.codeBlock) return false
  let hasInlineNodes = false
  node.forEach(child => { if (!child.isText) hasInlineNodes = true })
  if (hasInlineNodes) return false
  const pos = selection.$from.before()
  const transaction = editor.state.tr.setBlockType(pos, pos + node.nodeSize, schema.nodes.codeBlock, { language: "plaintext" })
  if (!transaction.docChanged) return false
  dispatchCodeChange(editor, transaction)
  return true
}

export function setCodeBlockLanguage(editor, language, selection = editor.state.selection) {
  if (!canEditCode(editor, selection) || !CODE_LANGUAGES.some(item => item.value === language)) return false
  const target = getCodeBlockTarget(selection)
  if (!target) return false
  if (target.node.attrs.language === language) return true
  dispatchCodeChange(editor, editor.state.tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, language }))
  return true
}

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
  for (const change of changes.reverse()) {
    if (reverse) transaction.delete(change.pos, change.pos + change.length)
    else transaction.insertText("  ", change.pos)
  }
  const anchor = transaction.mapping.map(selection.anchor, selection.anchor === selection.from ? -1 : 1)
  const head = transaction.mapping.map(selection.head, selection.head === selection.from ? -1 : 1)
  transaction.setSelection(TextSelection.create(transaction.doc, anchor, head))
  dispatchCodeChange(editor, transaction)
  return true
}

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
