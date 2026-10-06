/**
 * 目录、书签和内部链接的安全编辑命令。
 * 面板保存原节点身份与选区，完整事务链逐步映射；删除、整体替换和身份改变后目标永久失效。
 */
import { getMarkRange } from "@tiptap/core"
import { closeHistory } from "@tiptap/pm/history"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform"
import { createId } from "./create-id.js"
import { canEditRibbon } from "./ribbon-commands.js"
import { captureQuickInsertTarget, getQuickInsertSelection, mapQuickInsertTarget } from "./quick-insert.js"
import { collectNavigationTargets, getTableOfContentsEntries, isNavigationId, isNavigationName, NAVIGATION_UPDATE_META, TABLE_OF_CONTENTS_DEFAULTS, validateTableOfContentsAttrs } from "./document-navigation.js"

const textBlocks = ["paragraph", "heading"]
const missingTarget = "原导航目标已被删除或替换，请关闭面板后重新选择。"

export function listNavigationTargets(editor) {
  return editor && !editor.isDestroyed ? collectNavigationTargets(editor.getJSON()) : []
}

function currentTextBlock(editor) {
  const selection = editor.state.selection
  if (selection instanceof NodeSelection && textBlocks.includes(selection.node.type.name)) return { pos: selection.from, node: selection.node }
  if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to) || !textBlocks.includes(selection.$from.parent.type.name)) return null
  return { pos: selection.$from.before(), node: selection.$from.parent }
}

export function supportsNavigationBlockSelection(editor) {
  return Boolean(editor && !editor.isDestroyed && currentTextBlock(editor))
}

export function captureNavigationBlockTarget(editor, pos = null) {
  if (!editor || editor.isDestroyed) return null
  if (pos !== null && (!Number.isInteger(pos) || pos < 0 || pos >= editor.state.doc.content.size)) return null
  const current = pos === null ? currentTextBlock(editor) : { pos, node: editor.state.doc.nodeAt(pos) }
  if (!current || !textBlocks.includes(current.node?.type.name)) return null
  return { doc: editor.state.doc, pos: current.pos, type: current.node.type.name, id: current.node.attrs.navigationId, bookmark: Boolean(current.node.attrs.bookmarkName), valid: true }
}

function isNodeMarkup(step, pos, node) {
  return step instanceof ReplaceAroundStep && step.structure && step.from === pos && step.to === pos + node.nodeSize && step.gapFrom === pos + 1 && step.gapTo === pos + node.nodeSize - 1 && step.insert === 1
}

// atom 没有可追踪的内部 token；只放行本模块标记的等长、同类型单节点属性替换，真正删除不能放行。
function isTocMarkup(step, pos) {
  return step instanceof ReplaceStep && step.from === pos && step.to === pos + 1 && step.slice.openStart === 0 && step.slice.openEnd === 0
    && step.slice.content.childCount === 1 && step.slice.content.firstChild.type.name === "tableOfContents" && step.slice.content.firstChild.nodeSize === 1
}

function mapTarget(target, transaction, toc = false) {
  if (!target?.valid) return false
  if (target.doc !== transaction.before) { target.valid = false; return false }
  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index]
    const before = transaction.docs[index].nodeAt(target.pos)
    const mapped = step.getMap().mapResult(target.pos, 1)
    const after = (transaction.docs[index + 1] || transaction.doc).nodeAt(mapped.pos)
    const ownUpdate = Boolean(transaction.getMeta(NAVIGATION_UPDATE_META))
    if (!before || !after || before.type.name !== target.type || after.type.name !== target.type || mapped.deleted && !(toc ? ownUpdate && isTocMarkup(step, target.pos) : isNodeMarkup(step, target.pos, before))) {
      target.valid = false
      return false
    }
    if (!toc) {
      if (after.attrs.navigationId !== target.id) {
        if ((target.id === null || target.id === undefined) && ownUpdate && isNavigationId(after.attrs.navigationId)) target.id = after.attrs.navigationId
        else { target.valid = false; return false }
      }
      if (target.bookmark && !after.attrs.bookmarkName) { target.valid = false; return false }
    }
    target.pos = mapped.pos
  }
  target.doc = transaction.doc
  return true
}

export const mapNavigationBlockTarget = (target, transaction) => mapTarget(target, transaction)
export const mapTableOfContentsTarget = (target, transaction) => mapTarget(target, transaction, true)

export function readNavigationBlockTarget(editor, target) {
  if (!editor || editor.isDestroyed || !target?.valid || target.doc !== editor.state.doc) return null
  const node = editor.state.doc.nodeAt(target.pos)
  if (!node || node.type.name !== target.type || node.attrs.navigationId !== target.id || target.bookmark && !node.attrs.bookmarkName) return null
  return { type: target.type, attrs: { ...node.attrs }, text: node.textContent, pos: target.pos }
}

function dispatchChange(editor, tr) {
  if (tr.docChanged) closeHistory(tr).setMeta(NAVIGATION_UPDATE_META, true)
  editor.view.dispatch(tr)
  if (tr.docChanged) editor.view.dispatch(closeHistory(editor.state.tr))
}

function createNavigationIdAllocator(doc) {
  const ids = new Set()
  doc.descendants(node => { if (isNavigationId(node.attrs.navigationId)) ids.add(node.attrs.navigationId) })
  return () => {
    let id
    do { id = `nav-${createId()}` } while (ids.has(id))
    ids.add(id)
    return id
  }
}

// 标题 ID 按需求建立。内部链接创建可复用此函数的原子事务，避免 ID 与链接分成两次撤销。
function ensureTargetId(tr, pos, allocate = null) {
  const node = tr.doc.nodeAt(pos)
  if (isNavigationId(node.attrs.navigationId)) return node.attrs.navigationId
  const id = (allocate || createNavigationIdAllocator(tr.doc))()
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, navigationId: id })
  return id
}

export function ensureHeadingTarget(editor, target, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，无法建立标题链接。" }
  const current = readNavigationBlockTarget(editor, target)
  if (!current || current.type !== "heading") return { ok: false, error: missingTarget }
  const tr = editor.state.tr
  const id = ensureTargetId(tr, target.pos)
  const changed = tr.docChanged
  if (changed) dispatchChange(editor, tr)
  return { ok: true, id, changed }
}

export function setBookmarkName(editor, target, name, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再设置书签。" }
  const current = readNavigationBlockTarget(editor, target)
  if (!current) return { ok: false, error: missingTarget }
  if (!isNavigationName(name)) return { ok: false, error: "书签名称须为 1–80 个单行字符。" }
  const tr = editor.state.tr
  const id = ensureTargetId(tr, target.pos)
  const node = tr.doc.nodeAt(target.pos)
  if (node.attrs.bookmarkName !== name) tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, bookmarkName: name })
  const changed = tr.docChanged
  if (changed) dispatchChange(editor, tr)
  return { ok: true, id, changed }
}

export function removeBookmarkName(editor, target, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再删除书签。" }
  const current = readNavigationBlockTarget(editor, target)
  if (!current) return { ok: false, error: missingTarget }
  if (!current.attrs.bookmarkName) return { ok: true, changed: false }
  dispatchChange(editor, editor.state.tr.setNodeMarkup(target.pos, undefined, { ...current.attrs, bookmarkName: null, navigationId: current.type === "heading" ? current.attrs.navigationId : null }))
  return { ok: true, changed: true }
}

// 插入目录不替换所选文字。普通单光标可拆开原段；列表、单元格和跨段范围先要求明确的正文位置。
export function supportsNavigationInsertSelection(editor) {
  if (!editor || editor.isDestroyed) return false
  const { selection } = editor.state
  if (!(selection instanceof TextSelection) || !selection.empty || !textBlocks.includes(selection.$from.parent.type.name)) return false
  for (let depth = 1; depth < selection.$from.depth; depth += 1) if (!["blockquote", "textBox", "details"].includes(selection.$from.node(depth).type.name)) return false
  return true
}

export function captureNavigationInsertTarget(editor) {
  return canEditRibbon(editor) && supportsNavigationInsertSelection(editor) ? captureQuickInsertTarget(editor) : null
}
export const mapNavigationInsertTarget = mapQuickInsertTarget
export const getNavigationInsertSelection = getQuickInsertSelection

export function insertTableOfContentsAtTarget(editor, target, attrs = {}, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再插入目录。" }
  const error = validateTableOfContentsAttrs(attrs)
  if (error || Object.hasOwn(attrs, "entries")) return { ok: false, error: error || "目录条目由正文标题自动生成。" }
  const selection = getQuickInsertSelection(editor, target)
  if (!selection || !selection.empty) return { ok: false, error: missingTarget }
  const candidate = { isDestroyed: false, state: { selection } }
  if (!supportsNavigationInsertSelection(candidate)) return { ok: false, error: "请选择普通正文段落的光标位置。" }
  const tr = editor.state.tr.setSelection(selection)
  // 首次建立目录可能包含大量无 ID 标题；只收集一次已有身份，不为每个标题再次扫描整篇正文。
  const allocate = createNavigationIdAllocator(tr.doc)
  tr.doc.descendants((node, pos) => { if (node.type.name === "heading") ensureTargetId(tr, pos, allocate) })
  const values = { ...TABLE_OF_CONTENTS_DEFAULTS, ...attrs }
  values.entries = getTableOfContentsEntries(tr.doc.toJSON(), values.maxLevel)
  const toc = editor.schema.nodes.tableOfContents.create(values)
  try {
    tr.replaceSelectionWith(toc, false)
    let position = null
    tr.doc.descendants((node, pos) => { if (node === toc) position = pos; return position === null })
    if (position === null) return { ok: false, error: "当前位置无法插入目录。" }
    tr.setSelection(NodeSelection.create(tr.doc, position)).scrollIntoView()
  } catch { return { ok: false, error: "当前位置无法插入目录。" } }
  dispatchChange(editor, tr)
  return { ok: true, changed: true }
}

export function getTableOfContentsTarget(editor) {
  if (!editor || editor.isDestroyed) return null
  const selection = editor.state.selection
  return selection instanceof NodeSelection && selection.node.type.name === "tableOfContents" ? { type: "tableOfContents", pos: selection.from, attrs: { ...selection.node.attrs } } : null
}

export function captureTableOfContentsTarget(editor) {
  const current = getTableOfContentsTarget(editor)
  return current ? { doc: editor.state.doc, pos: current.pos, type: current.type, valid: true } : null
}

export function readTableOfContentsSettings(editor, target) {
  if (!editor || editor.isDestroyed || !target?.valid || target.doc !== editor.state.doc) return null
  const node = editor.state.doc.nodeAt(target.pos)
  return node?.type.name === "tableOfContents" ? { type: "tableOfContents", attrs: { ...node.attrs }, pos: target.pos } : null
}

export function applyTableOfContentsSettings(editor, target, patch, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再设置目录。" }
  const current = readTableOfContentsSettings(editor, target)
  if (!current) return { ok: false, error: missingTarget }
  const error = validateTableOfContentsAttrs(patch)
  if (error || Object.hasOwn(patch, "entries")) return { ok: false, error: error || "目录条目由正文标题自动生成。" }
  const attrs = { ...current.attrs, ...patch }
  attrs.entries = getTableOfContentsEntries(editor.getJSON(), attrs.maxLevel)
  if (JSON.stringify(attrs) === JSON.stringify(current.attrs)) return { ok: true, changed: false }
  dispatchChange(editor, editor.state.tr.setNodeMarkup(target.pos, undefined, attrs))
  return { ok: true, changed: true }
}

export function refreshTableOfContents(editor, target = captureTableOfContentsTarget(editor), blocked = false) {
  return applyTableOfContentsSettings(editor, target, {}, blocked)
}

export function removeTableOfContents(editor, target = captureTableOfContentsTarget(editor), blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再删除目录。" }
  if (!readTableOfContentsSettings(editor, target)) return { ok: false, error: missingTarget }
  dispatchChange(editor, editor.state.tr.delete(target.pos, target.pos + 1).scrollIntoView())
  return { ok: true, changed: true }
}

// 原生点击、大纲和书签列表共用定位，不写属性、不产生正文更新或撤销；只读仍可浏览目标。
export function navigateToTarget(editor, id, blocked = false) {
  if (!editor || editor.isDestroyed || editor.view.composing || blocked || !isNavigationId(id)) return { ok: false, error: "当前无法定位此链接。" }
  let position = null
  editor.state.doc.descendants((node, pos) => { if (textBlocks.includes(node.type.name) && node.attrs.navigationId === id && position === null) position = pos })
  if (position === null) return { ok: false, error: "链接目标已不存在，请选择其他标题或书签。" }
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position + 1)).setMeta("addToHistory", false).scrollIntoView())
  editor.view.focus()
  return { ok: true, changed: false }
}

export function captureNavigationLinkTarget(editor) {
  if (!canEditRibbon(editor)) return null
  const target = captureQuickInsertTarget(editor)
  if (!target) return null
  const { selection, schema } = editor.state
  if (selection.empty) {
    const range = getMarkRange(selection.$from, schema.marks.link)
    if (range) {
      const expanded = TextSelection.create(editor.state.doc, range.from, range.to)
      target.bookmark = expanded.getBookmark()
      target.from = expanded.from
      target.to = expanded.to
    }
  }
  return target
}
export const mapNavigationLinkTarget = mapQuickInsertTarget
export const getNavigationLinkSelection = getQuickInsertSelection

export function applyInternalNavigationLink(editor, source, destination, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再应用链接。" }
  const selection = getQuickInsertSelection(editor, source)
  const current = readNavigationBlockTarget(editor, destination)
  if (!selection || !current || current.type !== "heading" && !current.attrs.bookmarkName) return { ok: false, error: missingTarget }
  const tr = editor.state.tr.setSelection(selection)
  const id = ensureTargetId(tr, destination.pos)
  const mark = editor.schema.marks.link.create({ href: `#${id}`, target: "_self", rel: "noopener noreferrer" })
  if (selection.empty) tr.setStoredMarks([...(source.storedMarks || selection.$from.marks()).filter(item => item.type !== mark.type), mark])
  else tr.addMark(selection.from, selection.to, mark)
  const changed = tr.docChanged
  dispatchChange(editor, tr.scrollIntoView())
  return { ok: true, changed, id }
}

export const addBookmark = setBookmarkName
export const renameBookmark = setBookmarkName
export const removeBookmark = removeBookmarkName
export const insertTableOfContents = insertTableOfContentsAtTarget
export const applyTocSettings = applyTableOfContentsSettings
export const removeToc = removeTableOfContents
export const locateNavigationTarget = navigateToTarget
