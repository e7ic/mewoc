/**
 * 验证表格规格预算、插入目标书签、表内/表外语义和单次撤销。
 * 表内文字目标插到最外层表之后，旧范围删除/替换和非法选择必须保留原正文与选区。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { AllSelection, NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { captureTableInsertTarget, getTableInsertSelection, insertTableAtTarget, mapTableInsertTarget, supportsTableInsertSelection, TABLE_INSERT_LIMITS, validateTableSize } from "../src/pages/editor/tools/table-insert.js"

// 安装编辑器需要的浏览器对象和帧调度，让 Node 测试执行真实 schema/事务逻辑；JSDOM 不承担原生版式验收。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// 每个场景创建独立编辑器并在 finally 销毁，隔离正文、插件和撤销历史；扩展组合只提供该组验证所需能力。
const createEditor = (content = "<p>alpha</p><p>beta</p>") => new Editor({
  element: document.createElement("div"), extensions: [StarterKit.configure({ trailingNode: false }), TableKit], content
})
const select = (editor, from, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
// 模拟弹层打开期间的目标跟踪，主事务与插件追加事务都依次映射；stop 用于场景结束时解除监听。
const track = editor => {
  const target = captureTableInsertTarget(editor)
  const listener = ({ transaction, appendedTransactions = [] }) => {
    for (const current of [transaction, ...appendedTransactions]) mapTableInsertTarget(target, current)
  }
  editor.on("transaction", listener)
  return { target, stop: () => editor.off("transaction", listener) }
}
// 从当前文档收集所有真实表格节点和位置，插入可能拆分段落，断言不能沿用旧光标坐标。
const tables = editor => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "table") result.push({ node, pos }) })
  return result
}
// 在既有表格两边保留文字，用于同时检查后插位置、原表内容和结构没有变成嵌套。
const tableDocument = "<p>before</p><table><tr><td><p>one</p></td><td><p>two</p></td></tr></table><p>after</p>"

test("表格尺寸校验限制整数和总单元格数，缺省使用表头行", () => {
  assert.deepEqual(TABLE_INSERT_LIMITS, { rows: 100, cols: 20, cells: 1000 })
  for (const [rows, cols] of [[1, 1], [2, 5], [100, 10], [50, 20]]) {
    assert.deepEqual(validateTableSize({ rows, cols }), { ok: true, rows, cols, withHeaderRow: true })
    assert.deepEqual(validateTableSize({ rows, cols, withHeaderRow: false }), { ok: true, rows, cols, withHeaderRow: false })
  }
  for (const value of [null, undefined, [], {}, { rows: 0, cols: 1 }, { rows: 101, cols: 1 }, { rows: 1, cols: 0 }, { rows: 1, cols: 21 },
    { rows: 1.5, cols: 2 }, { rows: 2, cols: 1.5 }, { rows: "3", cols: 2 }, { rows: 3, cols: "2" },
    { rows: NaN, cols: 2 }, { rows: 2, cols: Infinity }, { rows: 100, cols: 20 }, { rows: 2, cols: 3, withHeaderRow: "true" }]) {
    assert.equal(validateTableSize(value).ok, false)
    assert.equal(typeof validateTableSize(value).error, "string")
  }
})

test("自定义行列数和表头按实际 schema 插入，光标落入第一格", () => {
  for (const withHeaderRow of [false, true]) {
    const editor = createEditor("<p></p>")
    try {
      assert.equal(insertTableAtTarget(editor, captureTableInsertTarget(editor), { rows: 4, cols: 7, withHeaderRow }).ok, true)
      const [{ node, pos }] = tables(editor)
      assert.equal(node.childCount, 4)
      assert.equal(TableMap.get(node).width, 7)
      node.forEach((row, _offset, index) => row.forEach(cell => assert.equal(cell.type.name, withHeaderRow && index === 0 ? "tableHeader" : "tableCell")))
      assert.equal(editor.state.selection.from, pos + 4)
      assert.equal(editor.state.doc.childCount, 1)
    } finally { editor.destroy() }
  }
})

test("原文字范围被表格替换，后来移动当前光标不会重定向插入", () => {
  const editor = createEditor()
  try {
    select(editor, 2, 4)
    const { target, stop } = track(editor)
    select(editor, editor.state.doc.firstChild.nodeSize + 2)
    assert.equal(insertTableAtTarget(editor, target, { rows: 2, cols: 4 }).ok, true)
    const content = editor.getJSON().content
    assert.deepEqual(content.map(node => node.type), ["paragraph", "table", "paragraph", "paragraph"])
    assert.deepEqual([content[0].content[0].text, content[2].content[0].text, content[3].content[0].text], ["a", "ha", "beta"])
    assert.equal(TableMap.get(tables(editor)[0].node).width, 4)
    stop()
  } finally { editor.destroy() }
})

test("正文前方插入和插件追加事务映射目标，段落改标题仍允许插入", () => {
  const editor = createEditor()
  try {
    editor.registerPlugin(new Plugin({
      appendTransaction: (transactions, oldState, state) => transactions.some(tr => tr.getMeta("tableInsertAppend"))
        ? state.tr.insert(0, state.schema.nodes.paragraph.create(null, state.schema.text("prefix"))) : null
    }))
    select(editor, 3)
    const { target, stop } = track(editor)
    editor.view.dispatch(editor.state.tr.insertText("X", 1).setMeta("tableInsertAppend", true))
    const original = editor.state.doc.firstChild.nodeSize
    editor.view.dispatch(editor.state.tr.setNodeMarkup(original, editor.state.schema.nodes.heading, { level: 3 }))
    assert.equal(target.valid, true)
    assert.equal(getTableInsertSelection(editor, target).from, original + 4)
    assert.equal(insertTableAtTarget(editor, target, { rows: 1, cols: 1 }).ok, true)
    assert.deepEqual(editor.getJSON().content.map(node => [node.type, node.content?.[0]?.text || ""]), [
      ["paragraph", "prefix"], ["heading", "Xal"], ["table", ""], ["heading", "pha"], ["paragraph", "beta"]
    ])
    stop()
  } finally { editor.destroy() }
})

// 替换可保留相同文字外形，目标仍必须按原节点 token 身份失效；undo 只还原正文，不重启旧草稿。
test("删除目标和同位置整段替换会使草稿失效，撤销不能复活旧插入目标", () => {
  for (const action of ["delete", "replace", "untracked"]) {
    const editor = createEditor()
    try {
      select(editor, 2, 4)
      const { target, stop } = track(editor)
      if (action === "untracked") stop()
      const first = editor.state.doc.firstChild
      editor.view.dispatch(action === "replace" ? editor.state.tr.replaceWith(0, first.nodeSize, first) : editor.state.tr.delete(2, 4))
      const before = editor.getJSON()
      const selection = editor.state.selection.toJSON()
      assert.equal(insertTableAtTarget(editor, target, { rows: 2, cols: 2 }).ok, false)
      assert.deepEqual(editor.getJSON(), before)
      assert.deepEqual(editor.state.selection.toJSON(), selection)
      if (action !== "untracked") {
        editor.commands.undo()
        assert.equal(getTableInsertSelection(editor, target), null)
      }
      stop()
    } finally { editor.destroy() }
  }
})

test("表格内文字目标在原表之后插入，保留原表内容并防止嵌套", () => {
  const editor = createEditor(tableDocument)
  try {
    const [{ node: originalTable, pos }] = tables(editor)
    select(editor, pos + 4, pos + 6)
    const { target, stop } = track(editor)
    assert.equal(target.kind, "after-table")
    editor.view.dispatch(editor.state.tr.insertText("X", 1))
    select(editor, editor.state.doc.content.size - 2)
    assert.equal(insertTableAtTarget(editor, target, { rows: 3, cols: 5, withHeaderRow: false }).ok, true)
    const insertedTables = tables(editor)
    assert.equal(insertedTables.length, 2)
    assert.deepEqual(insertedTables[0].node.toJSON(), originalTable.toJSON())
    assert.equal(insertedTables[1].pos, insertedTables[0].pos + originalTable.nodeSize)
    assert.equal(TableMap.get(insertedTables[1].node).width, 5)
    assert.deepEqual(editor.getJSON().content.map(node => node.type), ["paragraph", "table", "table", "paragraph"])
    stop()
  } finally { editor.destroy() }
})

test("表格属性修改不丢失目标，整表删除或同位置替换拒绝后插", () => {
  for (const action of ["markup", "delete", "replace"]) {
    const editor = createEditor(tableDocument)
    try {
      const [{ node, pos }] = tables(editor)
      select(editor, pos + 4)
      const { target, stop } = track(editor)
      const tr = editor.state.tr
      if (action === "markup") tr.setNodeMarkup(pos, undefined, { ...node.attrs })
      else if (action === "delete") tr.delete(pos, pos + node.nodeSize)
      else tr.replaceWith(pos, pos + node.nodeSize, node)
      editor.view.dispatch(tr)
      const before = editor.getJSON()
      assert.equal(insertTableAtTarget(editor, target, { rows: 1, cols: 2 }).ok, action === "markup")
      if (action !== "markup") assert.deepEqual(editor.getJSON(), before)
      stop()
    } finally { editor.destroy() }
  }
})

// 缺少后续段落和多层表格是插入位置的两个边界，检查最终顶层结构避免默认落入内层 cell。
test("文末表格和导入的嵌套表格都在最外层表格之后插入", () => {
  for (const nested of [false, true]) {
    const content = nested ? "<p>outer</p><table><tr><td><p>inner</p></td></tr></table>" : "<p>cell</p>"
    const editor = createEditor(`<table><tr><td>${content}</td></tr></table>`)
    try {
      const original = editor.state.doc.firstChild
      const originalTables = tables(editor)
      select(editor, originalTables.at(-1).pos + 4)
      const target = captureTableInsertTarget(editor)
      assert.equal(target.tablePos, 0)
      assert.equal(insertTableAtTarget(editor, target, { rows: 1, cols: 1 }).ok, true)
      assert.equal(editor.state.doc.childCount, 2)
      assert.deepEqual(editor.state.doc.firstChild.toJSON(), original.toJSON())
      assert.equal(editor.state.doc.lastChild.type.name, "table")
      assert.equal(editor.state.selection.from, original.nodeSize + 4)
    } finally { editor.destroy() }
  }
})

test("多格、整表、全选及跨表格边界文字范围禁用插入", () => {
  const editor = createEditor(tableDocument)
  try {
    const [{ node, pos }] = tables(editor)
    const cells = TableMap.get(node).map.map(cell => pos + 1 + cell)
    for (const selection of [NodeSelection.create(editor.state.doc, pos), CellSelection.create(editor.state.doc, cells[0], cells[1]), new AllSelection(editor.state.doc)]) {
      editor.view.dispatch(editor.state.tr.setSelection(selection))
      assert.equal(supportsTableInsertSelection(editor), false)
      assert.equal(captureTableInsertTarget(editor), null)
    }
    // 表格插件会自动归一跨边界选区；直接检查候选状态，覆盖插件处理前的边界防御。
    for (const selection of [TextSelection.create(editor.state.doc, 2, pos + 4), TextSelection.create(editor.state.doc, 2, editor.state.doc.content.size - 2)]) {
      const candidate = { isDestroyed: false, isEditable: true, view: editor.view, state: { doc: editor.state.doc, selection, storedMarks: null } }
      assert.equal(supportsTableInsertSelection(candidate), false)
      assert.equal(captureTableInsertTarget(candidate), null)
    }
  } finally { editor.destroy() }
})

// 分步 undo/redo 不仅检查表格存在，还检查两侧输入各自保留，证明历史分组边界正确。
test("插入前后输入分别撤销，表格插入和重做各为一个独立步骤", () => {
  const editor = createEditor()
  try {
    editor.commands.insertContentAt(1, "X")
    select(editor, 3)
    const before = editor.getJSON()
    assert.equal(insertTableAtTarget(editor, captureTableInsertTarget(editor), { rows: 2, cols: 3 }).ok, true)
    const inserted = editor.getJSON()
    editor.commands.insertContent("Y")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), inserted)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.redo()
    assert.deepEqual(editor.getJSON(), inserted)
    editor.commands.undo()
    editor.commands.undo()
    assert.equal(editor.state.doc.firstChild.textContent, "alpha")
  } finally { editor.destroy() }
})

test("非法尺寸、只读、切换中和 IME 都不改正文或选区，恢复编辑后可直接使用", () => {
  const editor = createEditor()
  select(editor, 2)
  const target = captureTableInsertTarget(editor)
  const before = editor.getJSON()
  const selection = editor.state.selection.toJSON()
  const size = { rows: 2, cols: 3 }
  try {
    assert.equal(insertTableAtTarget(editor, target, { rows: 1.5, cols: 2 }).ok, false)
    assert.equal(insertTableAtTarget(editor, target, size, true).ok, false)
    editor.setEditable(false)
    assert.equal(supportsTableInsertSelection(editor), true)
    assert.equal(captureTableInsertTarget(editor), null)
    assert.equal(insertTableAtTarget(editor, target, size).ok, false)
    editor.setEditable(true)
    assert.equal(supportsTableInsertSelection(editor), true)
    assert.ok(captureTableInsertTarget(editor))
    editor.view.input.composing = true
    assert.equal(captureTableInsertTarget(editor), null)
    assert.equal(insertTableAtTarget(editor, target, size).ok, false)
    editor.view.input.composing = false
    assert.deepEqual(editor.getJSON(), before)
    assert.deepEqual(editor.state.selection.toJSON(), selection)
    assert.equal(insertTableAtTarget(editor, target, size).ok, true)
  } finally { editor.destroy() }
  assert.equal(supportsTableInsertSelection(editor), false)
  assert.equal(captureTableInsertTarget(editor), null)
  assert.equal(insertTableAtTarget(editor, target, size).ok, false)
})
