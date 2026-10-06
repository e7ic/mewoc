/**
 * 校验表格规格并在弹层打开时捕获的安全目标处插入表格。
 * 普通文字可替换，在既有表格内部则插入到最外层表格之后；位置跟踪同时保留文字和表格身份。
 */
import { createTable } from "@tiptap/extension-table"
import { closeHistory } from "@tiptap/pm/history"
import { TextSelection } from "@tiptap/pm/state"
import { ReplaceAroundStep } from "@tiptap/pm/transform"
import { canEditRibbon } from "./ribbon-commands.js"
import { captureQuickInsertTarget, getQuickInsertSelection, mapQuickInsertTarget, supportsQuickInsertSelection } from "./quick-insert.js"

// 行列各自限制之外还限制总单元格数，防止合法的大行数与大列数组合产生过重表格。
export const TABLE_INSERT_LIMITS = { rows: 100, cols: 20, cells: 1000 }
const unavailable = "原插入位置已被删除或替换，请关闭后重新选择。"

// 返回规范化规格或可展示错误，表头默认开启但必须是布尔值，避免把表单字符串直接用于创建节点。
export function validateTableSize(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "请输入有效的表格行数和列数。" }
  const { rows, cols, withHeaderRow = true } = value
  if (!Number.isInteger(rows) || rows < 1 || rows > TABLE_INSERT_LIMITS.rows) return { ok: false, error: `行数须为 1–${TABLE_INSERT_LIMITS.rows} 的整数。` }
  if (!Number.isInteger(cols) || cols < 1 || cols > TABLE_INSERT_LIMITS.cols) return { ok: false, error: `列数须为 1–${TABLE_INSERT_LIMITS.cols} 的整数。` }
  if (rows * cols > TABLE_INSERT_LIMITS.cells) return { ok: false, error: `表格最多包含 ${TABLE_INSERT_LIMITS.cells} 个单元格，请减少行数或列数。` }
  if (typeof withHeaderRow !== "boolean") return { ok: false, error: "请选择是否使用表头行。" }
  return { ok: true, rows, cols, withHeaderRow }
}

function outerTablePosition(point) {
  // 即使导入文件带有嵌套表格，也始终在最外层表格之后插入，避免继续叠加嵌套。
  for (let depth = 1; depth <= point.depth; depth += 1) if (point.node(depth).type.spec.tableRole === "table") return point.before(depth)
  return null
}

// 两端必须处于同一表格上下文；整表跨选或一端在表内一端在表外没有明确插入含义，直接拒绝。
function selectionContext(editor, selection = editor.state.selection) {
  const anchor = outerTablePosition(selection.$anchor)
  const head = outerTablePosition(selection.$head)
  if (anchor !== head) return null
  if (anchor !== null) return { kind: "after-table", tablePos: anchor }
  // 段落间的文字范围可以替换；跨越整张表格的范围要求用户先明确处理该表格。
  let containsTable = false
  editor.state.doc.nodesBetween(selection.from, selection.to, node => {
    if (node.type.spec.tableRole === "table") { containsTable = true; return false }
  })
  return containsTable ? null : { kind: "text", tablePos: null }
}

// 组合文字选区能力和表格上下文约束，供工具栏决定插入入口是否可用。
export function supportsTableInsertSelection(editor) {
  return supportsQuickInsertSelection(editor) && Boolean(selectionContext(editor))
}

// 复用快捷文字书签与待输入信息，同时记录插入模式和原表格位置，供异步弹层后验证。
export function captureTableInsertTarget(editor) {
  if (!supportsTableInsertSelection(editor)) return null
  const target = captureQuickInsertTarget(editor)
  return target ? { ...target, ...selectionContext(editor) } : null
}

// 只放行保留表格内容的外壳属性更新；同位置替换新表格不能继续接收旧插入目标。
function isTableMarkup(step, pos, node) {
  return step instanceof ReplaceAroundStep && step.structure && step.from === pos && step.to === pos + node.nodeSize &&
    step.gapFrom === pos + 1 && step.gapTo === pos + node.nodeSize - 1 && step.insert === 1
}

// 先逐步映射外层表格身份，再映射文字范围；任何一个原目标被删除或替换都会永久失效。
export function mapTableInsertTarget(target, transaction) {
  if (!target?.valid) return false
  if (target.doc !== transaction.before) { target.valid = false; return false }
  if (target.kind === "after-table") {
    for (let index = 0; index < transaction.steps.length; index += 1) {
      const step = transaction.steps[index]
      const node = transaction.docs[index].nodeAt(target.tablePos)
      const mapped = step.getMap().mapResult(target.tablePos, 1)
      const after = transaction.docs[index + 1] || transaction.doc
      if (node?.type.spec.tableRole !== "table" || mapped.deleted && !isTableMarkup(step, target.tablePos, node) || after.nodeAt(mapped.pos)?.type.spec.tableRole !== "table") {
        target.valid = false
        return false
      }
      target.tablePos = mapped.pos
    }
  }
  return mapQuickInsertTarget(target, transaction)
}

// 恢复书签后重算上下文，确认插入模式及原表格都未变，避免正文变动把“表后插入”变成替换文字。
export function getTableInsertSelection(editor, target) {
  const selection = getQuickInsertSelection(editor, target)
  if (!selection) return null
  const context = selectionContext(editor, selection)
  return context?.kind === target.kind && context.tablePos === target.tablePos ? selection : null
}

// 校验权限、规格和目标后只构造一笔事务，找到新表格真实位置并把光标放进首个可编辑位置。
export function insertTableAtTarget(editor, target, value, blocked = false) {
  if (!canEditRibbon(editor, blocked)) return { ok: false, error: "当前文档不可编辑，请恢复编辑后再插入。" }
  const size = validateTableSize(value)
  if (!size.ok) return size
  const selection = getTableInsertSelection(editor, target)
  if (!selection) return { ok: false, error: unavailable }
  const tr = closeHistory(editor.state.tr.setSelection(selection))
  try {
    const table = createTable(editor.schema, size.rows, size.cols, size.withHeaderRow)
    if (target.kind === "after-table") {
      const current = tr.doc.nodeAt(target.tablePos)
      tr.insert(target.tablePos + current.nodeSize, table)
    } else tr.replaceSelectionWith(table)
    // replaceSelectionWith 可能拆开原段落；通过本次创建的节点寻找真实位置，不能沿用旧光标偏移。
    let tablePos = null
    tr.doc.descendants((node, pos) => {
      if (node === table) tablePos = pos
      return tablePos === null
    })
    if (tablePos === null) return { ok: false, error: "当前位置无法插入表格，请选择正文段落后重试。" }
    tr.setSelection(TextSelection.near(tr.doc.resolve(tablePos + 1))).scrollIntoView()
  } catch { return { ok: false, error: "当前位置无法插入表格，请选择正文段落后重试。" } }
  editor.view.dispatch(tr)
  // 前后都隔开历史分组：插入前后的输入不会被这一次撤销一并删除。
  editor.view.dispatch(closeHistory(editor.state.tr))
  return { ok: true, changed: true }
}
