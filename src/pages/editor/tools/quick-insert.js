/**
 * 提供符号、表情和本机日期时间的纯文字候选，并维护弹层打开时的安全插入位置。
 * 书签之外还跟踪原文字块身份和边界；原范围被删除/替换时拒绝插入，避免草稿重定向到新内容。
 */
import { TextSelection } from "@tiptap/pm/state"
import { ReplaceAroundStep } from "@tiptap/pm/transform"
import { closeHistory } from "@tiptap/pm/history"
import { canEditRibbon } from "./ribbon-commands.js"

// 候选同时存放文字与可访问名称，插入值直接写正文，标签仅用于按钮/读屏说明。
export const QUICK_CHARACTER_GROUPS = [
  { label: "标点", items: [["·", "间隔号"], ["…", "省略号"], ["—", "破折号"], ["“", "左双引号"], ["”", "右双引号"], ["‘", "左单引号"], ["’", "右单引号"], ["※", "参考标记"]] },
  { label: "数学", items: [["±", "正负号"], ["×", "乘号"], ["÷", "除号"], ["≠", "不等号"], ["≤", "小于等于"], ["≥", "大于等于"], ["≈", "约等于"], ["∞", "无穷大"]] },
  { label: "单位", items: [["°", "度"], ["℃", "摄氏度"], ["℉", "华氏度"], ["㎡", "平方米"], ["㎥", "立方米"], ["‰", "千分号"], ["µ", "微符号"], ["Ω", "欧姆符号"]] },
  { label: "箭头", items: [["←", "左箭头"], ["→", "右箭头"], ["↑", "上箭头"], ["↓", "下箭头"], ["↔", "双向箭头"], ["⇒", "推导箭头"], ["⇐", "左双箭头"], ["↵", "回车箭头"]] }
]
export const QUICK_EMOJI_GROUPS = [
  { label: "表情", items: [["😀", "微笑"], ["😊", "开心"], ["😂", "开怀大笑"], ["🤔", "思考"], ["😎", "自信"], ["😢", "难过"], ["😮", "惊讶"], ["😍", "喜爱"]] },
  { label: "手势", items: [["👍", "赞"], ["👎", "不赞同"], ["👏", "鼓掌"], ["🙌", "欢呼"], ["👌", "好"], ["✌️", "胜利"], ["🙏", "感谢"], ["🤝", "握手"]] },
  { label: "工作与日常", items: [["✅", "完成"], ["⭐", "星星"], ["❤️", "爱心"], ["🎉", "庆祝"], ["💡", "想法"], ["📌", "图钉"], ["📝", "记录"], ["🚀", "火箭"]] }
]

// 使用本机日历日期，不能用 toISOString 截日期：UTC 转换会在本机凌晨跨到前一天。
export function getQuickDateOptions(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return []
  const pad = value => String(value).padStart(2, "0")
  const year = String(date.getFullYear()).padStart(4, "0")
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const iso = `${year}-${month}-${day}`
  const chinese = `${year}年${month}月${day}日`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return [
    { id: "chinese", label: "中文日期", value: chinese },
    { id: "iso", label: "ISO 日期", value: iso },
    { id: "slash", label: "斜杠日期", value: `${year}/${month}/${day}` },
    { id: "weekday", label: "中文日期与星期", value: `${chinese} 星期${"日一二三四五六"[date.getDay()]}` },
    { id: "time", label: "时间（小时和分钟）", value: time },
    { id: "seconds", label: "时间（含秒）", value: `${time}:${pad(date.getSeconds())}` },
    { id: "datetime", label: "日期时间", value: `${iso} ${time}` }
  ]
}

// 返回端点最近文字块的外部位置，作为跟踪结构身份的锚点，而非把光标数值当成节点身份。
function textblockPosition(point) {
  for (let depth = point.depth; depth > 0; depth -= 1) if (point.node(depth).isTextblock) return point.before(depth)
  return null
}

// 这里只描述选区结构。setEditable 恢复编辑不会必然产生事务，不能把可编辑状态缓存进 selector。
export function supportsQuickInsertSelection(editor) {
  if (!editor || editor.isDestroyed || !(editor.state.selection instanceof TextSelection)) return false
  const { selection } = editor.state
  return textblockPosition(selection.$anchor) !== null && textblockPosition(selection.$head) !== null
}

// 图片/整表/多单元格选区没有明确的文字插入点，不让快捷文字隐式替换这些结构。
export function captureQuickInsertTarget(editor) {
  if (!canEditRibbon(editor) || !supportsQuickInsertSelection(editor)) return null
  const { selection, doc, storedMarks } = editor.state
  const anchors = [textblockPosition(selection.$anchor), textblockPosition(selection.$head)]
  if (anchors.some(pos => pos === null)) return null
  return { doc, bookmark: selection.getBookmark(), from: selection.from, to: selection.to, anchors, storedMarks, valid: true }
}

// 识别保留文字内容的节点属性变化，允许修改段落样式时继续使用插入书签。
function isNodeMarkup(step, pos, node) {
  return step instanceof ReplaceAroundStep && step.structure && step.from === pos && step.to === pos + node.nodeSize &&
    step.gapFrom === pos + 1 && step.gapTo === pos + node.nodeSize - 1 && step.insert === 1
}

// 与弹窗书签一样跟随正文变化，同时核对原文字块身份；同位置替换或丢失原范围后不能重定向。
export function mapQuickInsertTarget(target, transaction) {
  if (!target?.valid) return false
  if (target.doc !== transaction.before) { target.valid = false; return false }
  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index]
    const before = transaction.docs[index]
    const after = transaction.docs[index + 1] || transaction.doc
    const mapping = step.getMap()
    const anchors = []
    for (const pos of target.anchors) {
      const node = before.nodeAt(pos)
      const mapped = mapping.mapResult(pos, 1)
      if (!node?.isTextblock || mapped.deleted && !isNodeMarkup(step, pos, node) || !after.nodeAt(mapped.pos)?.isTextblock) {
        target.valid = false
        return false
      }
      anchors.push(mapped.pos)
    }
    const from = mapping.mapResult(target.from, 1)
    const to = mapping.mapResult(target.to, target.from === target.to ? 1 : -1)
    if (from.deleted || to.deleted) { target.valid = false; return false }
    target.from = from.pos
    target.to = to.pos
    target.anchors = anchors
  }
  target.bookmark = target.bookmark.map(transaction.mapping)
  target.doc = transaction.doc
  return target.valid
}

// 解析书签后再次核对端点所属原文字块，即使位置可解析，也不能跨到替代节点或另一份正文。
export function getQuickInsertSelection(editor, target) {
  if (!editor || editor.isDestroyed || !target?.valid || target.doc !== editor.state.doc) return null
  try {
    const selection = target.bookmark.resolve(editor.state.doc)
    if (!(selection instanceof TextSelection) || textblockPosition(selection.$anchor) !== target.anchors[0] || textblockPosition(selection.$head) !== target.anchors[1]) return null
    return selection
  } catch { return null }
}

// 校验短文本和目标后恢复原范围，空光标恢复待输入格式，文字替换作为一次独立撤销提交。
export function insertQuickText(editor, target, value, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再插入。" }
  const selection = getQuickInsertSelection(editor, target)
  if (!selection) return { ok: false, error: "原文字选区已被删除或替换，请关闭后重新选择。" }
  if (typeof value !== "string" || !value.length || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: "请选择有效的文字内容。" }
  const tr = closeHistory(editor.state.tr.setSelection(selection))
  if (selection.empty) tr.setStoredMarks(target.storedMarks || null)
  // insertText 直接创建文字，不把 <>、表情或符号交给 HTML 解析，也不引入额外文档节点。
  tr.insertText(value).scrollIntoView()
  if (!tr.docChanged) return { ok: true, changed: false }
  editor.view.dispatch(tr)
  editor.view.dispatch(closeHistory(editor.state.tr))
  return { ok: true, changed: true }
}
