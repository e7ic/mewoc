/**
 * 验证表格设置的选格范围、整表边框、合并格逻辑列宽、行高和原目标身份。
 * 设置分组在同一事务提交，未修改外观保持；坐标与均分使用未缩放尺寸，嵌套表格有独立作用范围。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import TextAlign from "@tiptap/extension-text-align"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { TextSelection } from "@tiptap/pm/state"
import { TableAppearance, normalizeTableCellAppearance, normalizeTableRowAppearance, isValidTableCellAppearance, isValidTableRowAppearance } from "../src/pages/editor/extensions/table-appearance.js"
import { applyTableSettings, captureTableTarget, mapTableTarget, readTableSettings, TABLE_MIXED } from "../src/pages/editor/tools/table-settings.js"

// 安装编辑器需要的浏览器对象和帧调度，让 Node 测试执行真实 schema/事务逻辑；JSDOM 不承担原生版式验收。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// 每个场景创建独立编辑器并在 finally 销毁，隔离正文、插件和撤销历史；扩展组合只提供该组验证所需能力。
const createEditor = (content, withTextAlign = true) => new Editor({
  element: document.createElement("div"), extensions: [StarterKit.configure({ trailingNode: false }), TableKit, TableAppearance,
    ...(withTextAlign ? [TextAlign.configure({ types: ["paragraph", "heading"] })] : [])], content
})
// 固定两行两列且含表头/普通格的基线，单格、多格、整表边框和跨行尺寸均可直接观察。
const simpleTable = "<table><tbody><tr><th><p>a</p></th><th><p>b</p></th></tr><tr><td><p>c</p></td><td><p>d</p></td></tr></tbody></table>"
// 每次重算 TableMap 与正文绝对位置，编辑增删行列后仍定位实际逻辑格，而非旧顺序偏移。
const tables = editor => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "table") result.push({ node, pos, start: pos + 1, map: TableMap.get(node) }) })
  return result
}
// 通过 TableMap 的逻辑网格转换位置，合并单元格会重复映射同一节点，不能直接累加固定 nodeSize。
const position = (table, row = 0, column = 0) => table.start + table.map.map[row * table.map.width + column]
const cellAt = (editor, tableIndex, row, column) => {
  const table = tables(editor)[tableIndex]
  return editor.state.doc.nodeAt(position(table, row, column))
}
// 单格场景使用格内文字光标，多格场景使用真实 CellSelection，覆盖两种实际入口的范围语义。
const selectCell = (editor, tableIndex = 0, row = 0, column = 0) => {
  const pos = position(tables(editor)[tableIndex], row, column)
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 2)))
}
const selectCells = (editor, row1, column1, row2, column2, tableIndex = 0) => {
  const table = tables(editor)[tableIndex]
  editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, position(table, row1, column1), position(table, row2, column2))))
}
// 模拟弹层打开期间的目标跟踪，主事务与插件追加事务都依次映射；stop 用于场景结束时解除监听。
const track = editor => {
  const target = captureTableTarget(editor)
  const listener = ({ transaction, appendedTransactions = [] }) => [transaction, ...appendedTransactions].forEach(current => mapTableTarget(target, current))
  editor.on("transaction", listener)
  return { target, stop: () => editor.off("transaction", listener) }
}

test("表格外观默认值、HTML 样式与安全解析使用统一白名单", () => {
  const editor = createEditor(simpleTable)
  try {
    selectCell(editor)
    const target = captureTableTarget(editor)
    assert.equal(applyTableSettings(editor, target, {
      cell: { backgroundColor: "#fff3cd", verticalAlign: "middle", paddingX: 0, paddingY: 40 },
      border: { borderColor: "#123456", borderWidth: 6, borderStyle: "dashed" }, dimensions: { rowMinHeight: 1000 }
    }).ok, true)
    const html = editor.getHTML()
    assert.match(html, /background-color: rgb\(255, 243, 205\)/)
    assert.match(html, /vertical-align: middle/)
    assert.match(html, /height: 1000px/)
    assert.equal(editor.state.schema.nodes.table.spec.attrs?.backgroundColor, undefined)
    const roundtrip = createEditor(html)
    try {
      assert.deepEqual(normalizeTableCellAppearance(cellAt(roundtrip, 0, 0, 0).attrs), {
        backgroundColor: "#fff3cd", verticalAlign: "middle", paddingX: 0, paddingY: 40,
        borderColor: "#123456", borderWidth: 6, borderStyle: "dashed"
      })
      assert.equal(tables(roundtrip)[0].node.firstChild.attrs.minHeight, 1000)
    } finally { roundtrip.destroy() }
    editor.commands.setContent("<table><tr style='height:9999px'><td style='background: url(https://invalid.test/a);vertical-align: super;padding:99px;border:99px double red'><p>x</p></td></tr></table>")
    assert.deepEqual(normalizeTableCellAppearance(cellAt(editor, 0, 0, 0).attrs), normalizeTableCellAppearance())
    assert.equal(tables(editor)[0].node.firstChild.attrs.minHeight, null)
    assert.equal(isValidTableCellAppearance({ paddingX: 1.5, borderColor: "red" }), false)
    assert.equal(isValidTableRowAppearance({ minHeight: 0 }), false)
    assert.deepEqual(normalizeTableRowAppearance({ minHeight: "20" }), { minHeight: null })
  } finally { editor.destroy() }
})

test("多单元格混合值只更新 dirty 字段，边框以整张表的范围读取和应用", () => {
  const editor = createEditor(simpleTable)
  try {
    const table = tables(editor)[0]
    const first = position(table, 0, 0)
    const last = position(table, 1, 1)
    editor.view.dispatch(editor.state.tr
      .setNodeMarkup(first, undefined, { ...editor.state.doc.nodeAt(first).attrs, backgroundColor: "#ff0000", borderStyle: "dotted" })
      .setNodeMarkup(last, undefined, { ...editor.state.doc.nodeAt(last).attrs, backgroundColor: "#0000ff", paddingY: 12 }))
    selectCells(editor, 0, 0, 1, 1)
    const target = captureTableTarget(editor)
    const values = readTableSettings(editor, target)
    assert.equal(values.cell.backgroundColor, TABLE_MIXED)
    assert.equal(values.cell.paddingY, TABLE_MIXED)
    assert.equal(values.border.borderStyle, TABLE_MIXED)
    assert.deepEqual(values.scope, { cells: 4, columns: 2, rows: 2, tableColumns: 2 })
    assert.equal(applyTableSettings(editor, target, { cell: { paddingX: 15 }, border: { borderColor: "#abcdef" } }).ok, true)
    assert.equal(cellAt(editor, 0, 0, 0).attrs.backgroundColor, "#ff0000")
    assert.equal(cellAt(editor, 0, 1, 1).attrs.backgroundColor, "#0000ff")
    assert.equal(cellAt(editor, 0, 1, 1).attrs.paddingY, 12)
    assert.equal(cellAt(editor, 0, 0, 0).attrs.borderStyle, "dotted")
    assert.equal(cellAt(editor, 0, 1, 1).attrs.borderStyle, "solid")
    for (const pos of new Set(tables(editor)[0].map.map)) {
      const attrs = tables(editor)[0].node.nodeAt(pos).attrs
      assert.equal(attrs.paddingX, 15)
      assert.equal(attrs.borderColor, "#abcdef")
    }
    assert.ok(editor.state.selection instanceof CellSelection)
  } finally { editor.destroy() }
})

// 宽度属于逻辑列而非某一个 cell，检查合并格数组与其他行同列同时更新，防止 TableMap 修复后尺寸冲突。
test("合并单元格覆盖的逻辑列同步全表 colwidth，跨行对应实际行高", () => {
  const editor = createEditor("<table><tr><td colspan='2' rowspan='2' colwidth='90,110'><p>a</p></td><td colwidth='130'><p>b</p></td></tr><tr><td colwidth='130'><p>c</p></td></tr><tr><td colwidth='90'><p>d</p></td><td colwidth='110'><p>e</p></td><td colwidth='130'><p>f</p></td></tr></table>")
  try {
    selectCell(editor)
    const target = captureTableTarget(editor)
    const values = readTableSettings(editor, target)
    assert.equal(values.dimensions.columnWidth, TABLE_MIXED)
    assert.equal(values.scope.columns, 2)
    assert.equal(values.scope.rows, 2)
    assert.equal(applyTableSettings(editor, target, { dimensions: { columnWidth: 175, rowMinHeight: 60 } }).ok, true)
    assert.deepEqual(cellAt(editor, 0, 0, 0).attrs.colwidth, [175, 175])
    assert.deepEqual(cellAt(editor, 0, 2, 0).attrs.colwidth, [175])
    assert.deepEqual(cellAt(editor, 0, 2, 1).attrs.colwidth, [175])
    assert.deepEqual(cellAt(editor, 0, 2, 2).attrs.colwidth, [130])
    const rows = [...tables(editor)[0].node.content.content]
    assert.deepEqual(rows.map(row => row.attrs.minHeight), [60, 60, null])
    assert.equal(TableMap.get(tables(editor)[0].node).problems, null)
    editor.commands.undo()
    assert.deepEqual(cellAt(editor, 0, 0, 0).attrs.colwidth, [90, 110])
    assert.deepEqual([...tables(editor)[0].node.content.content].map(row => row.attrs.minHeight), [null, null, null])
  } finally { editor.destroy() }
})

test("嵌套表格设置仅触及最近的内层表格", () => {
  const editor = createEditor(`<table><tr><td><p>outer</p>${simpleTable}</td><td><p>outside</p></td></tr></table>`)
  try {
    assert.equal(tables(editor).length, 2)
    selectCells(editor, 0, 0, 1, 1, 1)
    const target = captureTableTarget(editor)
    assert.equal(readTableSettings(editor, target).scope.cells, 4)
    assert.equal(applyTableSettings(editor, target, { cell: { paddingY: 22 }, border: { borderWidth: 3 } }).ok, true)
    assert.equal(cellAt(editor, 0, 0, 0).attrs.borderWidth, 1)
    assert.equal(cellAt(editor, 0, 0, 1).attrs.paddingY, 8)
    assert.equal(cellAt(editor, 1, 1, 1).attrs.borderWidth, 3)
    assert.equal(cellAt(editor, 1, 1, 1).attrs.paddingY, 22)
  } finally { editor.destroy() }
})

test("书签跟随前方输入和外观事务，切换到别的表格仍修改打开时的目标", () => {
  const editor = createEditor(`<p>before</p>${simpleTable}<p>between</p>${simpleTable}`)
  try {
    selectCell(editor)
    const { target, stop } = track(editor)
    editor.view.dispatch(editor.state.tr.insertText("long", 1))
    const firstCell = position(tables(editor)[0])
    editor.view.dispatch(editor.state.tr.setNodeMarkup(firstCell, undefined, { ...editor.state.doc.nodeAt(firstCell).attrs, paddingY: 19 }))
    assert.equal(target.valid, true)
    selectCell(editor, 1)
    assert.equal(applyTableSettings(editor, target, { cell: { backgroundColor: "#abcdef" } }).ok, true)
    assert.equal(cellAt(editor, 0, 0, 0).attrs.backgroundColor, "#abcdef")
    assert.equal(cellAt(editor, 0, 0, 0).attrs.paddingY, 19)
    assert.equal(cellAt(editor, 1, 0, 0).attrs.backgroundColor, null)
    stop()
  } finally { editor.destroy() }
})

test("同位置替换整表或删除选中列使旧目标失效，保留正文不误写替代节点", () => {
  for (const action of ["replace", "column"]) {
    const editor = createEditor(simpleTable)
    try {
      selectCell(editor)
      const { target, stop } = track(editor)
      if (action === "replace") {
        const table = tables(editor)[0]
        editor.view.dispatch(editor.state.tr.replaceWith(table.pos, table.pos + table.node.nodeSize, table.node))
      } else editor.commands.deleteColumn()
      const before = editor.getJSON()
      assert.equal(target.valid, false)
      assert.equal(applyTableSettings(editor, target, { border: { borderWidth: 5 } }).ok, false)
      assert.deepEqual(editor.getJSON(), before)
      stop()
    } finally { editor.destroy() }
  }
})

test("Tiptap 追加的列宽修复事务也映射书签，外观更新不会使目标失效", () => {
  const editor = createEditor("<table><tr><td colwidth='100'><p>a</p></td><td colwidth='120'><p>b</p></td></tr><tr><td colwidth='100'><p>c</p></td><td colwidth='120'><p>d</p></td></tr></table>")
  try {
    selectCell(editor)
    const { target, stop } = track(editor)
    let appended = 0
    editor.on("transaction", event => { appended += event.appendedTransactions?.length || 0 })
    const pos = position(tables(editor)[0])
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...editor.state.doc.nodeAt(pos).attrs, colwidth: [160] }))
    assert.ok(appended > 0)
    assert.equal(target.doc, editor.state.doc)
    assert.equal(target.valid, true)
    assert.equal(applyTableSettings(editor, target, { cell: { verticalAlign: "bottom" } }).ok, true)
    assert.equal(cellAt(editor, 0, 0, 0).attrs.verticalAlign, "bottom")
    stop()
  } finally { editor.destroy() }
})

// 同时提供不同布局宽度与屏幕宽度，期望只取 offsetWidth，检出 transform 缩放被重复应用。
test("均分读取 DOM 布局宽度，不把缩放后的屏幕宽度写入列宽", () => {
  const editor = createEditor(simpleTable)
  try {
    selectCell(editor)
    const table = tables(editor)[0]
    const dom = editor.view.nodeDOM(table.pos)
    const element = dom.tagName === "TABLE" ? dom : dom.querySelector("table")
    Object.defineProperty(element, "offsetWidth", { configurable: true, value: 600 })
    element.getBoundingClientRect = () => ({ width: 300 })
    assert.equal(applyTableSettings(editor, captureTableTarget(editor), { dimensions: { distributeColumns: true } }).ok, true)
    assert.deepEqual(cellAt(editor, 0, 0, 0).attrs.colwidth, [300])
    assert.deepEqual(cellAt(editor, 0, 1, 1).attrs.colwidth, [300])
  } finally { editor.destroy() }
})

test("保存在一个正文事务中完成，撤销与前后文字输入隔离，无改动不产生更新", () => {
  const editor = createEditor(simpleTable)
  try {
    selectCell(editor)
    editor.commands.insertContent("x")
    const { target, stop } = track(editor)
    let updates = 0
    editor.on("update", () => { updates += 1 })
    assert.deepEqual(applyTableSettings(editor, target, {}), { ok: true, changed: false })
    assert.equal(updates, 0)
    assert.deepEqual(applyTableSettings(editor, target, { cell: { paddingX: 13 }, border: { borderColor: "#abcdef" }, dimensions: { columnWidth: 120, rowMinHeight: 50 } }), { ok: true, changed: true })
    assert.equal(updates, 1)
    editor.commands.insertContent("y")
    editor.commands.undo()
    assert.equal(cellAt(editor, 0, 0, 0).textContent, "xa")
    assert.equal(cellAt(editor, 0, 0, 0).attrs.paddingX, 13)
    editor.commands.undo()
    assert.equal(cellAt(editor, 0, 0, 0).attrs.paddingX, 10)
    assert.equal(cellAt(editor, 0, 0, 0).textContent, "xa")
    editor.commands.undo()
    assert.equal(cellAt(editor, 0, 0, 0).textContent, "a")
    stop()
  } finally { editor.destroy() }
})

test("均分列宽按未缩放数据宽度安全计算，未知宽度拒绝，输入白名单和编辑守卫不修改正文", () => {
  const editor = createEditor("<table><tr><td colwidth='100'><p>a</p></td><td colwidth='200'><p>b</p></td></tr></table>")
  try {
    selectCell(editor)
    const { target, stop } = track(editor)
    assert.equal(applyTableSettings(editor, target, { dimensions: { distributeColumns: true } }).ok, true)
    assert.deepEqual(cellAt(editor, 0, 0, 0).attrs.colwidth, [150])
    assert.deepEqual(cellAt(editor, 0, 0, 1).attrs.colwidth, [150])
    const before = editor.getJSON()
    for (const patch of [{ cell: { paddingX: 41 } }, { cell: { backgroundColor: "url(evil)" } }, { border: { borderColor: "red" } }, { border: { borderWidth: 1.5 } }, { dimensions: { columnWidth: 34 } }, { dimensions: { rowMinHeight: 0 } }, { dimensions: { distributeColumns: true, columnWidth: 100 } }, { cell: { unsupported: 1 } }]) {
      assert.equal(applyTableSettings(editor, target, patch).ok, false)
    }
    editor.setEditable(false)
    assert.equal(applyTableSettings(editor, target, { cell: { paddingX: 20 } }).ok, false)
    editor.setEditable(true)
    assert.equal(applyTableSettings(editor, target, { cell: { paddingX: 20 } }, true).ok, false)
    editor.view.input.composing = true
    assert.equal(applyTableSettings(editor, target, { cell: { paddingX: 20 } }).ok, false)
    editor.view.input.composing = false
    assert.deepEqual(editor.getJSON(), before)
    stop()
    editor.commands.setContent(simpleTable)
    selectCell(editor)
    assert.equal(applyTableSettings(editor, captureTableTarget(editor), { dimensions: { distributeColumns: true } }).ok, false)
    editor.destroy()
    assert.equal(applyTableSettings(editor, target, { border: { borderWidth: 2 } }).ok, false)
  } finally { if (!editor.isDestroyed) editor.destroy() }
})

// 垂直/水平组合枚举验证同一事务、原 CellSelection 与未改样式，不仅检验单一对齐按钮。
test("12 种快捷对齐沿原多单元格书签应用，垂直和水平一次撤销且保留其余样式", () => {
  for (const verticalAlign of ["top", "middle", "bottom"]) for (const textAlign of ["left", "center", "right", "justify"]) {
    const editor = createEditor(`<p>before</p>${simpleTable}<p>between</p>${simpleTable}`)
    try {
      const first = position(tables(editor)[0])
      const third = position(tables(editor)[0], 1, 0)
      editor.view.dispatch(editor.state.tr
        .setNodeMarkup(first, undefined, { ...editor.state.doc.nodeAt(first).attrs, backgroundColor: "#fff3cd", paddingX: 3 })
        .setNodeMarkup(third, undefined, { ...editor.state.doc.nodeAt(third).attrs, paddingX: 17, verticalAlign: "bottom" })
        .setNodeMarkup(third + 1, undefined, { ...editor.state.doc.nodeAt(third + 1).attrs, textAlign: "right" }))
      selectCells(editor, 0, 0, 1, 0)
      const { target, stop } = track(editor)
      assert.equal(readTableSettings(editor, target).paragraph.textAlign, TABLE_MIXED)
      editor.view.dispatch(editor.state.tr.insertText("mapped", 1))
      selectCell(editor, 1, 1, 1)
      const before = editor.getJSON()
      const content = editor.state.doc.textContent
      let updates = 0
      editor.on("update", () => { updates += 1 })
      assert.deepEqual(applyTableSettings(editor, target, { cell: { verticalAlign }, paragraph: { textAlign } }), { ok: true, changed: true })
      assert.equal(updates, 1)
      assert.ok(editor.state.selection instanceof CellSelection)
      assert.equal(editor.state.doc.textContent, content)
      for (const row of [0, 1]) {
        assert.equal(cellAt(editor, 0, row, 0).attrs.verticalAlign, verticalAlign)
        assert.equal(cellAt(editor, 0, row, 0).firstChild.attrs.textAlign, textAlign)
        assert.equal(cellAt(editor, 0, row, 1).firstChild.attrs.textAlign, null)
      }
      assert.equal(cellAt(editor, 0, 0, 0).attrs.backgroundColor, "#fff3cd")
      assert.equal(cellAt(editor, 0, 0, 0).attrs.paddingX, 3)
      assert.equal(cellAt(editor, 0, 1, 0).attrs.paddingX, 17)
      assert.equal(cellAt(editor, 1, 1, 1).firstChild.attrs.textAlign, null)
      assert.equal(readTableSettings(editor, target).paragraph.textAlign, textAlign)
      editor.commands.undo()
      assert.deepEqual(editor.getJSON(), before)
      stop()
    } finally { editor.destroy() }
  }
})

test("选中外层单元格对齐其列表、引用和标题段落，排除内嵌表格与代码块", () => {
  const editor = createEditor(`<table><tr><td><p><strong>outer</strong></p><h6>title</h6><blockquote><p>quote</p></blockquote><ul><li><p>list</p></li></ul><pre><code>code</code></pre>${simpleTable}</td><td><p>outside</p></td></tr></table>`)
  try {
    selectCell(editor)
    const before = editor.state.doc.textContent
    const marks = cellAt(editor, 0, 0, 0).firstChild.firstChild.marks.map(mark => mark.type.name)
    assert.equal(applyTableSettings(editor, captureTableTarget(editor), { cell: { verticalAlign: "middle" }, paragraph: { textAlign: "center" } }).ok, true)
    const outer = cellAt(editor, 0, 0, 0)
    const aligns = []
    outer.descendants(node => {
      if (node.type.name === "table") return false
      if (["paragraph", "heading"].includes(node.type.name)) aligns.push(node.attrs.textAlign)
      if (node.type.name === "codeBlock") assert.equal(node.attrs.textAlign, undefined)
    })
    assert.deepEqual(aligns, ["center", "center", "center", "center"])
    assert.equal(cellAt(editor, 0, 0, 1).firstChild.attrs.textAlign, null)
    assert.equal(cellAt(editor, 1, 0, 0).firstChild.attrs.textAlign, null)
    assert.equal(cellAt(editor, 1, 0, 0).attrs.verticalAlign, "top")
    assert.deepEqual(outer.firstChild.firstChild.marks.map(mark => mark.type.name), marks)
    assert.equal(editor.state.doc.textContent, before)
  } finally { editor.destroy() }
})

// 组合 patch 任一能力不支持必须全拒绝，避免已经写垂直对齐后才发现水平字段非法造成部分提交。
test("水平对齐字段严格验证，缺少扩展或代码单元格拒绝整次组合应用", () => {
  for (const [content, withTextAlign] of [[simpleTable, false], ["<table><tr><td><pre><code>code</code></pre></td></tr></table>", true]]) {
    const editor = createEditor(content, withTextAlign)
    try {
      selectCell(editor)
      const target = captureTableTarget(editor)
      const before = editor.getJSON()
      assert.equal(applyTableSettings(editor, target, { cell: { verticalAlign: "bottom" }, paragraph: { textAlign: "center" } }).ok, false)
      assert.deepEqual(editor.getJSON(), before)
      assert.equal(applyTableSettings(editor, target, { cell: { backgroundColor: "#abcdef" } }).ok, true)
    } finally { editor.destroy() }
  }
  const editor = createEditor(simpleTable)
  try {
    selectCell(editor)
    const target = captureTableTarget(editor)
    const before = editor.getJSON()
    for (const paragraph of [{ textAlign: "start" }, { textAlign: "url(evil)" }, { textAlign: null }, { unsupported: "center" }]) {
      assert.equal(applyTableSettings(editor, target, { cell: { verticalAlign: "bottom" }, paragraph }).ok, false)
      assert.deepEqual(editor.getJSON(), before)
    }
  } finally { editor.destroy() }
})

test("快捷底色保留光标输入格式；点击已有设置回原单元格而不写正文历史", () => {
  const editor = createEditor(simpleTable)
  try {
    selectCell(editor)
    editor.commands.setMark("bold")
    const { target, stop } = track(editor)
    selectCell(editor, 0, 1, 1)
    assert.equal(applyTableSettings(editor, target, { cell: { backgroundColor: "#123456" } }).ok, true)
    assert.equal(editor.state.selection.from, position(tables(editor)[0]) + 2)
    assert.deepEqual(editor.state.storedMarks.map(mark => mark.type.name), ["bold"])
    assert.equal(cellAt(editor, 0, 1, 1).attrs.backgroundColor, null)
    selectCell(editor, 0, 1, 1)
    let updates = 0
    editor.on("update", () => { updates += 1 })
    assert.deepEqual(applyTableSettings(editor, target, { cell: { backgroundColor: "#123456" } }), { ok: true, changed: false })
    assert.equal(updates, 0)
    assert.equal(editor.state.selection.from, position(tables(editor)[0]) + 2)
    assert.deepEqual(editor.state.storedMarks.map(mark => mark.type.name), ["bold"])
    editor.commands.insertContent("z")
    assert.equal(cellAt(editor, 0, 0, 0).firstChild.firstChild.text, "z")
    assert.equal(cellAt(editor, 0, 0, 0).firstChild.firstChild.marks[0].type.name, "bold")
    editor.commands.undo()
    assert.equal(cellAt(editor, 0, 0, 0).textContent, "a")
    assert.equal(cellAt(editor, 0, 0, 0).attrs.backgroundColor, "#123456")
    editor.commands.undo()
    assert.equal(cellAt(editor, 0, 0, 0).attrs.backgroundColor, null)
    stop()
  } finally { editor.destroy() }
})

// 属性更新/前置结构变动允许映射，真实 cell 替换永久失效；比较两类行为能检出边界 token 误判。
test("首行首段属性变化和前方插行插列保留原 cell，整个 cell 同位替换永久失效", () => {
  const editor = createEditor(simpleTable)
  try {
    selectCell(editor)
    const { target, stop } = track(editor)
    assert.equal(applyTableSettings(editor, target, { cell: { paddingX: 15 }, paragraph: { textAlign: "right" }, dimensions: { rowMinHeight: 60 } }).ok, true)
    assert.equal(target.valid, true)
    assert.equal(readTableSettings(editor, target).dimensions.rowMinHeight, 60)
    assert.equal(readTableSettings(editor, target).paragraph.textAlign, "right")
    const originalCell = target.cells[0]
    editor.view.dispatch(editor.state.tr.insert(originalCell + 1, editor.state.schema.nodes.paragraph.create(null, editor.state.schema.text("new"))))
    assert.equal(target.valid, true)
    assert.equal(editor.commands.addRowBefore(), true)
    assert.equal(editor.commands.addColumnBefore(), true)
    assert.equal(target.valid, true)
    assert.equal(editor.state.doc.nodeAt(target.cells[0]).textContent, "newa")
    assert.equal(applyTableSettings(editor, target, { cell: { backgroundColor: "#abcdef" } }).ok, true)
    assert.equal(cellAt(editor, 0, 1, 1).attrs.backgroundColor, "#abcdef")
    assert.equal(cellAt(editor, 0, 0, 0).attrs.backgroundColor, null)
    // 表头切换只改节点标记，不能把原单元格误判成新节点。
    editor.commands.toggleHeaderCell()
    assert.equal(target.valid, true)
    const pos = target.cells[0]
    const cell = editor.state.doc.nodeAt(pos)
    editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + cell.nodeSize, cell))
    assert.equal(target.valid, false)
    const before = editor.getJSON()
    assert.equal(applyTableSettings(editor, target, { cell: { verticalAlign: "bottom" } }).ok, false)
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.undo()
    assert.equal(target.valid, false)
    stop()
  } finally { editor.destroy() }
})
