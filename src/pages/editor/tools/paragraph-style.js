/**
 * 在原段落范围内切换正文或标题级别，并支持样式卡片的键盘导航。
 * 类型切换保留正文、marks 与段落属性；恢复原选区和待输入格式，让工具栏操作后继续原处写作。
 */
import { closeHistory } from "@tiptap/pm/history"
import { NodeSelection } from "@tiptap/pm/state"
import { captureParagraphTarget, readParagraphSettings } from "./paragraph-settings.js"

export const PARAGRAPH_STYLE_LEVELS = [0, 1, 2, 3, 4, 5, 6]

// 捕获目标前检查可编辑状态，随后复用段落身份跟踪机制，避免样式面板误作用于后来点击的段落。
export function captureParagraphStyleTarget(editor) {
  if (!editor || editor.isDestroyed || !editor.isEditable || editor.view.composing) return null
  const target = captureParagraphTarget(editor)
  // 工具栏夺走焦点前保留待输入格式，改变段落类型不会清掉用户刚选择的文字格式。
  if (target) target.styleStoredMarks = editor.state.storedMarks
  return target
}

// 将普通段落映射为级别 0，标题映射为 level；多段不同级别返回 mixed，失效目标返回 null。
export function readParagraphStyle(editor, target = captureParagraphTarget(editor)) {
  if (!readParagraphSettings(editor, target)) return null
  const levels = target.positions.map(pos => {
    const node = editor.state.doc.nodeAt(pos)
    return node.type.name === "heading" ? node.attrs.level : 0
  })
  return levels.every(level => level === levels[0]) ? levels[0] : "mixed"
}

// 先验证目标级别与全部父结构能接受目标类型，再构造事务，保证不会只转换选区中的一部分段落。
export function applyParagraphStyle(editor, target, level, blocked = false) {
  if (!editor || editor.isDestroyed || !editor.isEditable || editor.view.composing || blocked) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再应用。" }
  const heading = editor.extensionManager.extensions.find(extension => extension.name === "heading")
  if (!PARAGRAPH_STYLE_LEVELS.includes(level) || (level && !heading?.options.levels.includes(level))) return { ok: false, error: "请选择有效的段落样式。" }
  if (!readParagraphSettings(editor, target)) return { ok: false, error: "原段落已被删除或替换，请重新选择。" }
  const type = editor.schema.nodes[level ? "heading" : "paragraph"]
  if (!type) return { ok: false, error: "当前文档不支持此段落样式。" }
  for (const pos of target.positions) {
    const point = editor.state.doc.resolve(pos)
    if (!point.parent.canReplaceWith(point.index(), point.index() + 1, type)) return { ok: false, error: "当前所选结构不支持此段落样式。" }
  }
  const selection = target.bookmark.resolve(editor.state.doc)
  const tr = editor.state.tr
  // 仅改变原段落的类型/标题级别，文字 marks、列表/表格结构及已保存的段落属性均保留。
  for (const pos of target.positions) {
    const node = tr.doc.nodeAt(pos)
    if (node.type === type && (!level || node.attrs.level === level)) continue
    const { level: _level, ...attrs } = node.attrs
    tr.setNodeMarkup(pos, type, level ? { ...attrs, level } : attrs)
  }
  // setNodeMarkup 会替换段落外壳，普通 NodeSelection.map 会误退为文本选区，显式恢复原节点选择。
  const restored = selection instanceof NodeSelection && target.positions.includes(selection.from)
    ? NodeSelection.create(tr.doc, selection.from) : selection.map(tr.doc, tr.mapping)
  tr.setSelection(restored)
  if (selection.empty) tr.setStoredMarks(target.styleStoredMarks || null)
  // 点击已生效样式时仍可恢复原选区/待输入格式，但无需触发正文更新、保存或新的撤销组。
  if (!tr.docChanged) {
    if (!selection.eq(editor.state.selection) || tr.storedMarks !== editor.state.storedMarks) editor.view.dispatch(tr)
    return { ok: true, changed: false }
  }
  closeHistory(tr)
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.dispatch(closeHistory(editor.state.tr))
  return { ok: true, changed: true }
}

// 卡片按两行排列；键盘走到隐藏的 H4–H6 时展开，所有样式都可只用键盘到达。
export function getNextParagraphStyleLevel(level, key, expanded) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return null
  let next = level
  if (key === "ArrowLeft") next = (level + 6) % 7
  if (key === "ArrowRight") next = (level + 1) % 7
  if (key === "ArrowDown" && level < 4) next = 4 + Math.min(level, 2)
  if (key === "ArrowUp" && level >= 4) next = level - 4
  if (key === "Home") next = 0
  if (key === "End") next = 6
  return { level: next, expanded: expanded || next >= 4 }
}
