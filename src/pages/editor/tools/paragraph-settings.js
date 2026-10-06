/**
 * 为段落详细设置捕获原选区、跟踪段落身份、读取混合值并提交部分属性。
 * 弹窗的操作范围固定为打开时的段落清单；位置跟随事务映射，删除或替换原段落会使草稿失效。
 */
import { closeHistory } from "@tiptap/pm/history"
import { ReplaceAroundStep } from "@tiptap/pm/transform"
import { PARAGRAPH_LAYOUT_ATTRIBUTES, isValidParagraphLayout, normalizeParagraphLayout } from "../extensions/paragraph-layout.js"

const PARAGRAPH_TYPES = ["paragraph", "heading"]
const INVALID_TARGET = "原段落已被删除或替换，请关闭后重新选择。"
export const PARAGRAPH_MIXED = "mixed"

// 沿光标祖先寻找最近段落或标题，支持列表/表格中的正文；不把代码块当作可设置段落。
function paragraphAtPoint(doc, point) {
  const resolved = doc.resolve(point)
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    if (PARAGRAPH_TYPES.includes(resolved.node(depth).type.name)) return resolved.before(depth)
  }
  return null
}

// 按每个真实范围收集段落位置并去重排序，空光标用所属段落，非连续选区逐段分别检查。
function selectedParagraphs(doc, selection) {
  const positions = new Set()
  selection.ranges.forEach(({ $from, $to }) => {
    if ($from.pos === $to.pos) {
      const pos = paragraphAtPoint(doc, $from.pos)
      if (pos !== null) positions.add(pos)
      return
    }
    // CellSelection 是多个互不连续的单元格范围，不能用 selection.from/to 包围盒误选中间未选单元格。
    doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (!PARAGRAPH_TYPES.includes(node.type.name)) return
      // 文本选择停在下一段内容起点时，下一段并未选中文本，不应被一起套用段落格式。
      // 选择从空段/段末开始时仍选中了该段的段落边界，起始段也属于本次格式范围。
      if ($to.pos > pos + 1 && $from.pos <= pos + node.nodeSize - 1) positions.add(pos)
      return false
    })
  })
  return [...positions].sort((a, b) => a - b)
}

// 保存当前文档身份、选区书签和段落位置；后续格式操作通过这个目标，不依赖界面焦点后的光标。
export function captureParagraphTarget(editor) {
  if (!editor || editor.isDestroyed || !editor.state) return null
  const { doc, selection } = editor.state
  const positions = selectedParagraphs(doc, selection)
  return positions.length ? { doc, bookmark: selection.getBookmark(), positions, valid: true } : null
}

// 识别仅替换段落外壳的 setNodeMarkup 步骤，它保留原内容，应与真正删除/替换段落区别处理。
function isParagraphMarkup(step, pos, node) {
  return step instanceof ReplaceAroundStep && step.from === pos && step.to === pos + node.nodeSize &&
    step.gapFrom === pos + 1 && step.gapTo === pos + node.nodeSize - 1 && step.insert === 1 && step.structure
}

// 内容起点处的输入/删字会移动或删除光标锚点，却没有删除段落节点。逐步同时核对开头 token，
// 对保留原内容的 setNodeMarkup 放行；整段同位置替换、join 删除原段落 token 则永久使目标失效。
export function mapParagraphTarget(target, transaction) {
  if (!target?.valid) return false
  if (target.doc !== transaction.before) {
    target.valid = false
    return false
  }
  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index]
    const before = transaction.docs[index]
    const after = transaction.docs[index + 1] || transaction.doc
    const mapping = step.getMap()
    const positions = []
    for (const pos of target.positions) {
      const node = before.nodeAt(pos)
      if (!node || !PARAGRAPH_TYPES.includes(node.type.name)) {
        target.valid = false
        return false
      }
      const opening = mapping.mapResult(pos, 1)
      if (opening.deleted && !isParagraphMarkup(step, pos, node)) {
        target.valid = false
        return false
      }
      const contentStart = mapping.map(pos + 1, -1)
      const next = paragraphAtPoint(after, contentStart)
      if (next === null || next !== opening.pos) {
        target.valid = false
        return false
      }
      positions.push(next)
    }
    target.positions = positions
  }
  target.bookmark = target.bookmark.map(transaction.mapping)
  target.doc = transaction.doc
  return true
}

// 每次读写重新验证目标仍属于当前正文，解析书签失败视为失效，避免抛出位置异常到弹窗。
function getParagraphs(editor, target) {
  if (!editor || editor.isDestroyed || !target?.valid || target.doc !== editor.state.doc) return null
  try {
    const paragraphs = target.positions.map(pos => ({ pos, node: editor.state.doc.nodeAt(pos) }))
    if (!paragraphs.length || paragraphs.some(({ node }) => !node || !PARAGRAPH_TYPES.includes(node.type.name))) return null
    // 验证书签能在当前文档解析，但作用范围始终来自原段落清单，不随当前光标改变。
    return { paragraphs, selection: target.bookmark.resolve(editor.state.doc) }
  } catch { return null }
}

// 每个属性独立比较多段落值，相同回显共同值，不同回显 mixed，保留用户只改部分字段的能力。
export function readParagraphSettings(editor, target) {
  const context = getParagraphs(editor, target)
  if (!context) return null
  const values = context.paragraphs.map(({ node }) => normalizeParagraphLayout(node.attrs))
  return {
    values: Object.fromEntries(PARAGRAPH_LAYOUT_ATTRIBUTES.map(key => [key, values.every(value => value[key] === values[0][key]) ? values[0][key] : PARAGRAPH_MIXED])),
    count: values.length
  }
}

// patch 只包含用户真正修改的字段，null/0/false 都保留其区别；不统一混合选区里未编辑的值。
export function applyParagraphSettings(editor, target, patch, blocked = false) {
  if (!editor || editor.isDestroyed || !editor.isEditable || editor.view?.composing || blocked) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再应用。" }
  const context = getParagraphs(editor, target)
  if (!context) return { ok: false, error: INVALID_TARGET }
  if (!isValidParagraphLayout(patch) || Object.keys(patch).some(key => !PARAGRAPH_LAYOUT_ATTRIBUTES.includes(key))) {
    return { ok: false, error: "段前和段后间距为 0–120 磅，步进 0.5 磅；分页选项请选择默认、开启或关闭。" }
  }
  // 同一事务合并所有目标段落的属性变化；未改字段保留原值，没变化时直接返回而不追加历史。
  const tr = closeHistory(editor.state.tr)
  context.paragraphs.forEach(({ pos, node }) => {
    if (Object.keys(patch).some(key => node.attrs[key] !== patch[key])) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch })
  })
  if (!tr.docChanged) return { ok: true, changed: false }
  tr.setSelection(context.selection.map(tr.doc, tr.mapping)).scrollIntoView()
  editor.view.dispatch(tr)
  editor.view.dispatch(closeHistory(editor.state.tr))
  return { ok: true, changed: true }
}
