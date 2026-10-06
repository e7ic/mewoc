/**
 * 文本框与折叠详情的属性契约、插入书签和结构操作。
 * 容器只是正文中的块级外壳；全部内容仍是正常节点，撤掉外壳不会展平列表、表格或文字格式。
 */
import { Fragment } from "@tiptap/pm/model"
import { closeHistory } from "@tiptap/pm/history"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { ReplaceAroundStep } from "@tiptap/pm/transform"
import { canEditRibbon } from "./ribbon-commands.js"
import { captureQuickInsertTarget, getQuickInsertSelection, mapQuickInsertTarget } from "./quick-insert.js"

export const BLOCK_CONTAINER_TYPES = Object.freeze(["textBox", "details"])
export const TEXT_BOX_DEFAULTS = Object.freeze({ backgroundColor: "#f5f3ff", borderColor: "#c8c3e6", borderWidth: 1, padding: 16 })
export const DETAILS_DEFAULTS = Object.freeze({ summary: "详细内容" })
const unavailable = "原内容块已被删除或替换，请关闭后重新选择。"
const ordinaryBlocks = ["paragraph", "heading"]

// 校验显式属性，不把 null、字符串数字或未知 CSS 自动变成默认值；默认值仅用于缺省字段。
export function validateBlockContainerAttrs(type, attrs = {}) {
  if (!BLOCK_CONTAINER_TYPES.includes(type) || !attrs || Array.isArray(attrs) || typeof attrs !== "object") return "内容块属性无效。"
  const defaults = type === "textBox" ? TEXT_BOX_DEFAULTS : DETAILS_DEFAULTS
  if (Object.keys(attrs).some(key => !Object.hasOwn(defaults, key))) return "内容块包含不支持的属性。"
  if (type === "details") {
    if (Object.hasOwn(attrs, "summary") && (typeof attrs.summary !== "string" || !attrs.summary.trim() || attrs.summary.length > 120 || /[\u0000-\u001f\u007f]/.test(attrs.summary))) return "详情标题须为 1–120 个字符，不能包含换行或控制字符。"
    return ""
  }
  if (["backgroundColor", "borderColor"].some(key => Object.hasOwn(attrs, key) && (typeof attrs[key] !== "string" || !/^#[\da-f]{6}$/i.test(attrs[key])))) return "文本框颜色须为六位十六进制纯色。"
  if (Object.hasOwn(attrs, "borderWidth") && (!Number.isInteger(attrs.borderWidth) || attrs.borderWidth < 0 || attrs.borderWidth > 6)) return "边框宽度须为 0–6 px 的整数。"
  if (Object.hasOwn(attrs, "padding") && (!Number.isInteger(attrs.padding) || attrs.padding < 0 || attrs.padding > 40)) return "内边距须为 0–40 px 的整数。"
  return ""
}

// 两个端点必须来自同一父节点中的普通文字块；列表、单元格和已有容器内不隐式创建新外壳。
function insertContext(editor, selection = editor.state.selection) {
  if (!(selection instanceof TextSelection)) return null
  const { $from, $to } = selection
  if (!ordinaryBlocks.includes($from.parent.type.name) || !ordinaryBlocks.includes($to.parent.type.name) || $from.depth !== $to.depth) return null
  if ($from.node($from.depth - 1) !== $to.node($to.depth - 1)) return null
  for (let depth = 1; depth < $from.depth; depth += 1) {
    if (!["blockquote"].includes($from.node(depth).type.name)) return null
  }
  const parent = $from.node($from.depth - 1)
  const start = $from.before()
  const end = $to.after()
  const startIndex = $from.index($from.depth - 1)
  const endIndex = $to.index($to.depth - 1) + 1
  // 非空选区只包裹完整段落/标题；部分文字范围不能悄悄把未选中的文字一起移入容器。
  if (!selection.empty && (selection.from !== $from.start() || selection.to !== $to.end())) return null
  for (let index = startIndex; index < endIndex; index += 1) if (!ordinaryBlocks.includes(parent.child(index).type.name)) return null
  return { kind: selection.empty ? "caret" : "wrap", start, end, parent, startIndex, endIndex }
}

// selector 只缓存结构能力；可编辑、组合输入和文档切换状态在执行入口实时检查。
export function supportsBlockContainerInsertSelection(editor) {
  return Boolean(editor && !editor.isDestroyed && insertContext(editor))
}

// 复用原文字块身份和选区映射，工具栏焦点或弹层草稿不会把操作改指向当前的新光标。
export function captureBlockContainerInsertTarget(editor) {
  if (!canEditRibbon(editor) || !supportsBlockContainerInsertSelection(editor)) return null
  const target = captureQuickInsertTarget(editor)
  if (!target) return null
  const context = insertContext(editor)
  const wrappedBlocks = []
  // 包裹范围包含多个原段落身份，不能仅跟踪两端；中间整段被替换后，旧工具目标也必须失效。
  if (context.kind === "wrap") {
    let position = context.start
    for (let index = context.startIndex; index < context.endIndex; index += 1) {
      wrappedBlocks.push(position)
      position += context.parent.child(index).nodeSize
    }
  }
  return { ...target, kind: context.kind, wrappedBlocks }
}

export function mapBlockContainerInsertTarget(target, transaction) {
  if (!target?.valid || target.doc !== transaction.before) return mapQuickInsertTarget(target, transaction)
  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index]
    const after = transaction.docs[index + 1] || transaction.doc
    const positions = []
    for (const pos of target.wrappedBlocks) {
      const node = transaction.docs[index].nodeAt(pos)
      const mapped = step.getMap().mapResult(pos, 1)
      if (!ordinaryBlocks.includes(node?.type.name) || mapped.deleted && !isNodeMarkup(step, pos, node) || !ordinaryBlocks.includes(after.nodeAt(mapped.pos)?.type.name)) {
        target.valid = false
        return false
      }
      positions.push(mapped.pos)
    }
    target.wrappedBlocks = positions
  }
  return mapQuickInsertTarget(target, transaction)
}

export function getBlockContainerInsertSelection(editor, target) {
  const selection = getQuickInsertSelection(editor, target)
  return selection && insertContext(editor, selection)?.kind === target.kind ? selection : null
}

// 工具改变前后各隔开历史；尾段等插件追加的事务仍与主事务属于同一次撤销。
function dispatchChange(editor, tr) {
  if (tr.docChanged) closeHistory(tr)
  editor.view.dispatch(tr)
  if (tr.docChanged) editor.view.dispatch(closeHistory(editor.state.tr))
}

// 空光标插入空内容块并保留段落两侧文字；整段选区直接移动原节点，不重建文字与 marks。
export function insertBlockContainerAtTarget(editor, target, type, attrs = {}, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再插入。" }
  const error = validateBlockContainerAttrs(type, attrs)
  if (error) return { ok: false, error }
  const selection = getBlockContainerInsertSelection(editor, target)
  if (!selection) return { ok: false, error: unavailable }
  const context = insertContext(editor, selection)
  const nodeType = editor.schema.nodes[type]
  if (!nodeType || !context.parent.canReplaceWith(context.startIndex, context.endIndex, nodeType)) return { ok: false, error: "请选择普通正文段落后再插入内容块。" }
  const tr = editor.state.tr.setSelection(selection)
  try {
    const content = context.kind === "wrap" ? tr.doc.slice(context.start, context.end).content : Fragment.from(editor.schema.nodes.paragraph.create())
    const container = nodeType.create(attrs, content)
    if (context.kind === "wrap") tr.replaceWith(context.start, context.end, container)
    // 文字选区的 marks 属于容器内部正文，不能让 replaceSelectionWith 把它们套在块级外壳上。
    else tr.replaceSelectionWith(container, false)
    let position = null
    tr.doc.descendants((node, pos) => {
      if (node === container) position = pos
      return position === null
    })
    if (position === null) return { ok: false, error: "当前位置无法插入内容块，请重新选择正文段落。" }
    tr.setSelection(TextSelection.near(tr.doc.resolve(position + 1))).scrollIntoView()
    if (context.kind === "caret") tr.setStoredMarks(target.storedMarks || selection.$from.marks())
  } catch { return { ok: false, error: "当前位置无法插入内容块，请重新选择正文段落。" } }
  dispatchChange(editor, tr)
  return { ok: true, changed: true }
}

// 支持整个容器节点或全部端点都位于同一容器内部的文字范围；跨容器选区没有单一设置目标。
export function getBlockContainerTarget(editor) {
  if (!editor || editor.isDestroyed) return null
  const { selection } = editor.state
  if (selection instanceof NodeSelection && BLOCK_CONTAINER_TYPES.includes(selection.node.type.name)) {
    return { type: selection.node.type.name, attrs: { ...selection.node.attrs }, pos: selection.from, node: selection.node }
  }
  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    const node = selection.$from.node(depth)
    if (BLOCK_CONTAINER_TYPES.includes(node.type.name) && selection.to < selection.$from.after(depth)) {
      return { type: node.type.name, attrs: { ...node.attrs }, pos: selection.$from.before(depth), node }
    }
  }
  return null
}

export function captureBlockContainerTarget(editor) {
  if (!canEditRibbon(editor)) return null
  const current = getBlockContainerTarget(editor)
  return current ? { doc: editor.state.doc, type: current.type, pos: current.pos, original: { ...current.attrs }, valid: true } : null
}

// 属性变更保留原容器身份；删除或替换外壳永久关闭草稿，撤销恢复同样内容也不能复活旧目标。
function isNodeMarkup(step, pos, node) {
  return step instanceof ReplaceAroundStep && step.structure && step.from === pos && step.to === pos + node.nodeSize && step.gapFrom === pos + 1 && step.gapTo === pos + node.nodeSize - 1 && step.insert === 1
}

export function mapBlockContainerTarget(target, transaction) {
  if (!target?.valid) return false
  if (target.doc !== transaction.before) { target.valid = false; return false }
  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index]
    const node = transaction.docs[index].nodeAt(target.pos)
    const mapped = step.getMap().mapResult(target.pos, 1)
    const after = transaction.docs[index + 1] || transaction.doc
    if (node?.type.name !== target.type || mapped.deleted && !isNodeMarkup(step, target.pos, node) || after.nodeAt(mapped.pos)?.type.name !== target.type) {
      target.valid = false
      return false
    }
    target.pos = mapped.pos
  }
  target.doc = transaction.doc
  return true
}

export function readBlockContainerSettings(editor, target) {
  if (!editor || editor.isDestroyed || !target?.valid || target.doc !== editor.state.doc) return null
  const node = editor.state.doc.nodeAt(target.pos)
  return node?.type.name === target.type ? { type: target.type, attrs: { ...node.attrs } } : null
}

// 表单提交只合并用户实际修改的字段，弹层打开期间另一事务改过的其他属性继续保留。
export function applyBlockContainerSettings(editor, target, patch, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再设置。" }
  const current = readBlockContainerSettings(editor, target)
  if (!current) return { ok: false, error: unavailable }
  const error = validateBlockContainerAttrs(current.type, patch)
  if (error) return { ok: false, error }
  // patch 由面板的脏字段组成；显式恢复原值也必须生效，即使打开期间当前值已被其他事务改动。
  const changes = { ...patch }
  const attrs = { ...current.attrs, ...changes }
  if (!Object.keys(changes).some(key => current.attrs[key] !== changes[key])) return { ok: true, changed: false }
  dispatchChange(editor, editor.state.tr.setNodeMarkup(target.pos, undefined, attrs).scrollIntoView())
  return { ok: true, changed: true }
}

// 只移除外壳，使用原 Fragment 原样替换；详情摘要转为普通段落，所有可见内容都得到保留。
export function unwrapBlockContainer(editor, target = captureBlockContainerTarget(editor), blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再移除外框。" }
  if (!readBlockContainerSettings(editor, target)) return { ok: false, error: unavailable }
  const { doc, selection } = editor.state
  const node = doc.nodeAt(target.pos)
  const title = node.type.name === "details" ? editor.schema.nodes.paragraph.create(null, editor.schema.text(node.attrs.summary)) : null
  const content = title ? Fragment.from(title).append(node.content) : node.content
  const point = doc.resolve(target.pos)
  const index = point.index()
  if (!point.parent.canReplace(index, index + 1, content)) return { ok: false, error: "当前位置不能移除内容块外框。" }
  const tr = editor.state.tr.replaceWith(target.pos, target.pos + node.nodeSize, content)
  if (selection instanceof TextSelection && selection.from > target.pos && selection.to < target.pos + node.nodeSize) {
    const offset = -1 + (title?.nodeSize || 0)
    tr.setSelection(TextSelection.create(tr.doc, selection.anchor + offset, selection.head + offset))
  } else tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(target.pos + 1, tr.doc.content.size))))
  dispatchChange(editor, tr.scrollIntoView())
  return { ok: true, changed: true }
}

// 退出进入容器后相邻普通段落，只有不存在时才新增；已有正文跳转不产生待保存或撤销步骤。
export function exitBlockContainer(editor, target = captureBlockContainerTarget(editor), blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再退出内容块。" }
  if (!readBlockContainerSettings(editor, target)) return { ok: false, error: unavailable }
  const { doc, schema } = editor.state
  const after = target.pos + doc.nodeAt(target.pos).nodeSize
  const tr = editor.state.tr
  if (doc.nodeAt(after)?.type !== schema.nodes.paragraph) {
    const point = doc.resolve(after)
    const index = point.index()
    if (!point.parent.canReplaceWith(index, index, schema.nodes.paragraph)) return { ok: false, error: "当前位置无法退出内容块。" }
    tr.insert(after, schema.nodes.paragraph.create())
  }
  tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView()
  const changed = tr.docChanged
  dispatchChange(editor, tr)
  return { ok: true, changed }
}
