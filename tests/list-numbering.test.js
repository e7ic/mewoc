/** 验证编号设置的单列表范围、原目标身份、草稿校验，以及与文字输入分开的撤销语义。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TaskList, TaskItem } from "@tiptap/extension-list"
import { AllSelection, NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state"
import { applyListNumbering, captureListNumberingTarget, getListNumberingState, LIST_NUMBERING_MAX_START, LIST_NUMBERING_TYPES, mapListNumberingTarget, readListNumberingSettings, supportsListNumberingSelection } from "../src/pages/editor/tools/list-numbering.js"

// Node 只运行真实编辑器事务，不承担浏览器编号绘制与原生输入法验收。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const fixture = "<p>before</p><ol><li><p>one</p></li><li><p>two</p></li></ol><p>between</p><ol start=\"3\" type=\"A\"><li><p>three</p></li></ol><p>after</p>"
const createEditor = (content = fixture) => new Editor({
  element: document.createElement("div"), extensions: [StarterKit.configure({ trailingNode: false }), TaskList, TaskItem.configure({ nested: true })], content
})
const findNodes = (editor, type) => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === type) result.push({ node, pos }) })
  return result
}
const paragraph = (editor, text) => findNodes(editor, "paragraph").find(entry => entry.node.textContent === text)
const select = (editor, from, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
const selectText = (editor, text, offset = 1) => select(editor, paragraph(editor, text).pos + offset)
const listSettings = editor => findNodes(editor, "orderedList").map(({ node }) => ({ type: node.attrs.type || "1", start: node.attrs.start }))
// 与 UI 一样完整消费追加事务，否则修复插件可能让保留目标落后于当前 doc。
const track = editor => {
  const target = captureListNumberingTarget(editor)
  const listener = ({ transaction, appendedTransactions = [] }) => {
    for (const current of [transaction, ...appendedTransactions]) mapListNumberingTarget(target, current)
  }
  editor.on("transaction", listener)
  return { target, stop: () => editor.off("transaction", listener) }
}

test("编号设置规范缺省值，并支持五种编号与起始号边界", () => {
  const editor = createEditor()
  try {
    assert.deepEqual(LIST_NUMBERING_TYPES, ["1", "a", "A", "i", "I"])
    assert.equal(LIST_NUMBERING_MAX_START, 999999999)
    selectText(editor, "one")
    assert.deepEqual(getListNumberingState(editor), { type: "1", start: 1 })
    const { target, stop } = track(editor)
    for (const type of LIST_NUMBERING_TYPES) {
      for (const start of [1, 26, LIST_NUMBERING_MAX_START]) {
        assert.equal(applyListNumbering(editor, target, { type, start }).ok, true)
        assert.deepEqual(readListNumberingSettings(editor, target), { type, start })
      }
    }
    assert.deepEqual(listSettings(editor)[1], { type: "A", start: 3 })
    stop()
  } finally { editor.destroy() }
})

test("只有同一有序列表的文字范围可设置，列表外、跨列表和整节点选择不可用", () => {
  const editor = createEditor()
  try {
    for (const text of ["before", "between", "after"]) {
      selectText(editor, text)
      assert.equal(supportsListNumberingSelection(editor), false)
      assert.equal(getListNumberingState(editor), null)
      assert.equal(captureListNumberingTarget(editor), null)
    }
    const one = paragraph(editor, "one").pos + 1
    const two = paragraph(editor, "two").pos + 3
    select(editor, one, two)
    assert.equal(supportsListNumberingSelection(editor), true)
    select(editor, two, one)
    assert.equal(supportsListNumberingSelection(editor), true)
    select(editor, one, paragraph(editor, "three").pos + 2)
    assert.equal(captureListNumberingTarget(editor), null)
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    assert.equal(supportsListNumberingSelection(editor), false)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, findNodes(editor, "orderedList")[0].pos)))
    assert.equal(supportsListNumberingSelection(editor), false)
  } finally { editor.destroy() }
})

test("嵌套列表只改最近层，跨层或横跨另一嵌套列表的选区不隐式修改外层", () => {
  const editor = createEditor("<ol><li><p>outer</p><ol><li><p>inner</p></li></ol></li><li><p>last</p></li></ol>")
  try {
    selectText(editor, "inner")
    const { target, stop } = track(editor)
    assert.equal(applyListNumbering(editor, target, { type: "i", start: 4 }).ok, true)
    assert.deepEqual(listSettings(editor), [{ type: "1", start: 1 }, { type: "i", start: 4 }])
    stop()
    select(editor, paragraph(editor, "outer").pos + 1, paragraph(editor, "inner").pos + 2)
    assert.equal(supportsListNumberingSelection(editor), false)
    select(editor, paragraph(editor, "outer").pos + 1, paragraph(editor, "last").pos + 2)
    assert.equal(supportsListNumberingSelection(editor), false)
  } finally { editor.destroy() }
})

test("有序列表内的无序和待办子列表阻断祖先编号设置", () => {
  const editor = createEditor('<ol><li><p>outer</p><ul><li><p>bullet</p></li></ul><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>task</p></li></ul></li></ol>')
  try {
    for (const text of ["bullet", "task"]) {
      selectText(editor, text)
      assert.equal(supportsListNumberingSelection(editor), false, text)
      assert.equal(getListNumberingState(editor), null, text)
      assert.equal(captureListNumberingTarget(editor), null, text)
    }
    selectText(editor, "outer")
    assert.equal(supportsListNumberingSelection(editor), true)
  } finally { editor.destroy() }
})

test("前方插入和合法属性更新映射原列表，焦点切换不会改写后来选择的列表", () => {
  const editor = createEditor()
  try {
    selectText(editor, "one", 2)
    const { target, stop } = track(editor)
    const prefix = editor.schema.nodes.paragraph.create(null, editor.schema.text("prefix"))
    const tr = editor.state.tr.insert(0, prefix)
    tr.setNodeMarkup(target.pos + prefix.nodeSize, undefined, { type: "a", start: 5 })
    editor.view.dispatch(tr)
    assert.equal(target.valid, true)
    assert.deepEqual(readListNumberingSettings(editor, target), { type: "a", start: 5 })
    selectText(editor, "three")
    assert.equal(applyListNumbering(editor, target, { type: "I", start: 8 }).ok, true)
    assert.deepEqual(listSettings(editor), [{ type: "I", start: 8 }, { type: "A", start: 3 }])
    assert.equal(editor.state.selection.$from.parent.textContent, "one")
    assert.equal(editor.state.selection.$from.parentOffset, 1)
    stop()
  } finally { editor.destroy() }
})

test("原列表中编辑文字时书签移动，并保留原光标的待输入格式", () => {
  const editor = createEditor()
  try {
    selectText(editor, "one", 3)
    editor.commands.setMark("bold")
    const { target, stop } = track(editor)
    const pos = paragraph(editor, "one").pos + 1
    editor.view.dispatch(editor.state.tr.insertText("xx", pos))
    selectText(editor, "three")
    assert.equal(applyListNumbering(editor, target, { type: "a", start: 2 }).ok, true)
    assert.equal(editor.state.selection.$from.parent.textContent, "xxone")
    assert.equal(editor.state.selection.$from.parentOffset, 4)
    assert.equal(editor.state.storedMarks.some(mark => mark.type.name === "bold"), true)
    stop()
  } finally { editor.destroy() }
})

test("原列表删除、同位置同内容替换或转换为无序列表都永久终止旧草稿", () => {
  for (const action of ["delete", "replace", "bullet"]) {
    const editor = createEditor()
    try {
      selectText(editor, "one")
      const { target, stop } = track(editor)
      const { node, pos } = findNodes(editor, "orderedList")[0]
      if (action === "delete") editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
      if (action === "replace") editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, node))
      if (action === "bullet") editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, editor.schema.nodes.bulletList))
      assert.equal(target.valid, false, action)
      const before = editor.getJSON()
      assert.equal(applyListNumbering(editor, target, { type: "i", start: 10 }).ok, false)
      assert.deepEqual(editor.getJSON(), before)
      editor.commands.undo()
      assert.equal(target.valid, false)
      stop()
    } finally { editor.destroy() }
  }
})

test("未映射的旧文档、其他编辑会话以及 setContent 切换均不能接收旧草稿", () => {
  const editor = createEditor()
  const other = createEditor()
  try {
    selectText(editor, "one")
    const stale = captureListNumberingTarget(editor)
    editor.view.dispatch(editor.state.tr.insertText("x", 1))
    assert.equal(applyListNumbering(editor, stale, { type: "i", start: 2 }).ok, false)
    assert.equal(mapListNumberingTarget(stale, other.state.tr), false)
    selectText(editor, "one")
    const { target, stop } = track(editor)
    selectText(other, "one")
    assert.equal(readListNumberingSettings(other, target), null)
    assert.equal(applyListNumbering(other, target, { type: "i", start: 2 }).ok, false)
    editor.commands.setContent(fixture)
    assert.equal(target.valid, false)
    assert.equal(applyListNumbering(editor, target, { type: "i", start: 2 }).ok, false)
    stop()
  } finally { editor.destroy(); other.destroy() }
})

test("插件追加事务也跟踪完整原目标，不会因列表整体后移而漏掉设置", () => {
  const editor = createEditor()
  try {
    selectText(editor, "one")
    const { target, stop } = track(editor)
    editor.registerPlugin(new Plugin({
      appendTransaction: (transactions, _oldState, state) => transactions.some(tr => tr.getMeta("prepend-list-numbering"))
        ? state.tr.insert(0, state.schema.nodes.paragraph.create(null, state.schema.text("appended"))) : null
    }))
    editor.view.dispatch(editor.state.tr.insertText("x", 1).setMeta("prepend-list-numbering", true))
    assert.equal(target.valid, true)
    assert.equal(applyListNumbering(editor, target, { type: "A", start: 6 }).ok, true)
    assert.deepEqual(listSettings(editor)[0], { type: "A", start: 6 })
    stop()
  } finally { editor.destroy() }
})

test("非法草稿、只读、切换阻塞、输入法和销毁均不修改正文或当前选区", () => {
  const editor = createEditor()
  try {
    selectText(editor, "one")
    const { target, stop } = track(editor)
    const before = editor.getJSON()
    const selection = editor.state.selection.toJSON()
    for (const value of [null, [], {}, { type: "1", start: "2" }, { type: "bad", start: 1 }, { type: "a", start: 0 },
      { type: "a", start: -1 }, { type: "a", start: 1.5 }, { type: "a", start: NaN }, { type: "a", start: Infinity },
      { type: "a", start: 1000000000 }, { type: "a", start: 1, extra: true }]) {
      assert.equal(applyListNumbering(editor, target, value).ok, false)
    }
    editor.setEditable(false)
    assert.equal(captureListNumberingTarget(editor), null)
    assert.equal(supportsListNumberingSelection(editor), true)
    assert.equal(applyListNumbering(editor, target, { type: "a", start: 2 }).ok, false)
    editor.setEditable(true)
    assert.equal(applyListNumbering(editor, target, { type: "a", start: 2 }, true).ok, false)
    editor.view.input.composing = true
    assert.equal(captureListNumberingTarget(editor), null)
    assert.equal(applyListNumbering(editor, target, { type: "a", start: 2 }).ok, false)
    editor.view.input.composing = false
    assert.deepEqual(editor.getJSON(), before)
    assert.deepEqual(editor.state.selection.toJSON(), selection)
    stop()
    editor.destroy()
    assert.equal(getListNumberingState(editor), null)
    assert.equal(applyListNumbering(editor, target, { type: "a", start: 2 }).ok, false)
  } finally { if (!editor.isDestroyed) editor.destroy() }
})

test("同值不写 doc，一次修改两个字段与前后文字输入分开撤销并可重做", () => {
  const editor = createEditor()
  try {
    selectText(editor, "one")
    editor.commands.insertContent("x")
    const { target, stop } = track(editor)
    let updates = 0
    editor.on("update", () => { updates += 1 })
    const original = editor.state.doc
    assert.deepEqual(applyListNumbering(editor, target, { type: "1", start: 1 }), { ok: true, changed: false })
    assert.equal(editor.state.doc, original)
    assert.equal(updates, 0)
    assert.deepEqual(applyListNumbering(editor, target, { type: "I", start: 9 }), { ok: true, changed: true })
    assert.equal(updates, 1)
    assert.deepEqual(applyListNumbering(editor, target, { type: "I", start: 9 }), { ok: true, changed: false })
    assert.equal(updates, 1)
    editor.commands.insertContent("y")
    editor.commands.undo()
    assert.equal(Boolean(paragraph(editor, "xone")), true)
    assert.deepEqual(listSettings(editor)[0], { type: "I", start: 9 })
    editor.commands.undo()
    assert.equal(Boolean(paragraph(editor, "xone")), true)
    assert.deepEqual(listSettings(editor)[0], { type: "1", start: 1 })
    editor.commands.undo()
    assert.equal(Boolean(paragraph(editor, "one")), true)
    editor.commands.redo()
    editor.commands.redo()
    assert.deepEqual(listSettings(editor)[0], { type: "I", start: 9 })
    stop()
  } finally { editor.destroy() }
})
