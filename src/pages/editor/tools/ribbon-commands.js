/**
 * 封装完整工具栏的编辑权限、字号步进与段落缩进操作。
 * 操作复用真实文字外观和段落书签，恢复焦点前的选区/待输入 marks，并在正文变化时隔开历史。
 */
import { closeHistory } from "@tiptap/pm/history"
import { AllSelection, TextSelection } from "@tiptap/pm/state"
import { FONT_SIZES, FIRST_LINE_INDENTS, LEFT_INDENTS } from "../constants/editor-constants.js"
import { getSelectionTextStyle } from "./text-appearance.js"
import { captureParagraphTarget, readParagraphSettings } from "./paragraph-settings.js"

// 所有工具栏正文入口共享生命周期、可编辑、输入法和上层阻塞条件，界面禁用与命令校验保持一致。
export const canEditRibbon = (editor, blocked = false) => Boolean(editor && !editor.isDestroyed && editor.isEditable && !editor.view.composing && !blocked)

// 只在既有字号白名单内步进；混合或无法识别的值以正文默认 12pt 为基准。
export function getSteppedFontSize(value, direction) {
  if (![1, -1].includes(direction)) return null
  const points = /^\d+(?:\.\d+)?pt$/.test(value || "") ? Number.parseFloat(value) : 12
  const sizes = direction === 1 ? FONT_SIZES : [...FONT_SIZES].reverse()
  return sizes.find(size => direction === 1 ? Number.parseFloat(size) > points : Number.parseFloat(size) < points) || null
}

// 读取当前选区实际字号，向白名单中的邻近值移动；到达边界或权限不满足时返回失败。
export function stepFontSize(editor, direction, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return false
  const next = getSteppedFontSize(getSelectionTextStyle(editor).fontSize, direction)
  if (!next) return false
  const applied = editor.chain().command(({ tr }) => { closeHistory(tr); return true }).setFontSize(next).run()
  if (applied) editor.view.dispatch(closeHistory(editor.state.tr))
  return applied
}

// 仅捕获文字或全选范围，保存原段落清单及待输入格式，不让节点/表格选择隐式变成普通段落操作。
export function captureRibbonIndentTarget(editor) {
  if (!canEditRibbon(editor)) return null
  const selection = editor.state.selection
  if (!(selection instanceof TextSelection || selection instanceof AllSelection)) return null
  const target = captureParagraphTarget(editor)
  if (target) target.ribbonStoredMarks = editor.state.storedMarks
  return target
}

// 缩进弹层保留打开时的段落清单，正文光标改变或目标被替换后不能误改新段落。
export function applyRibbonParagraphIndent(editor, target, attrs, blocked = false) {
  if (!canEditRibbon(editor, blocked) || !readParagraphSettings(editor, target) || !attrs || typeof attrs !== "object" || Array.isArray(attrs)) return false
  // 缩进只接受两个已知属性及枚举值，禁止把弹层对象中的其他状态直接写入正文 attrs。
  const keys = Object.keys(attrs)
  if (!keys.length || keys.some(key => !["firstLineIndent", "leftIndent"].includes(key))) return false
  if (keys.includes("firstLineIndent") && !FIRST_LINE_INDENTS.includes(attrs.firstLineIndent)) return false
  if (keys.includes("leftIndent") && !LEFT_INDENTS.includes(attrs.leftIndent)) return false
  const selection = target.bookmark.resolve(editor.state.doc)
  if (!(selection instanceof TextSelection || selection instanceof AllSelection)) return false
  const tr = editor.state.tr
  for (const pos of target.positions) {
    const node = tr.doc.nodeAt(pos)
    if (keys.some(key => node.attrs[key] !== attrs[key])) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
  }
  tr.setSelection(selection.map(tr.doc, tr.mapping))
  if (selection.empty) tr.setStoredMarks(target.ribbonStoredMarks || null)
  // 重复选择当前缩进仍恢复书签与待输入格式；纯选区恢复不制造待保存正文变更。
  if (!tr.docChanged) {
    if (!selection.eq(editor.state.selection) || tr.storedMarks !== editor.state.storedMarks) editor.view.dispatch(tr)
    return true
  }
  closeHistory(tr)
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.dispatch(closeHistory(editor.state.tr))
  return true
}
