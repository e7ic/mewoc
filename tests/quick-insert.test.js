/**
 * 验证快捷符号、表情和本机日期时间作为纯文字写入原选区，并保留待输入格式。
 * 原文字块或范围失去身份后旧弹层永久失效，支持状态与实时编辑权限分开判定。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { AllSelection, NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state"
import { CellSelection, TableMap } from "@tiptap/pm/tables"
import { captureQuickInsertTarget, getQuickDateOptions, getQuickInsertSelection, insertQuickText, mapQuickInsertTarget, supportsQuickInsertSelection } from "../src/pages/editor/tools/quick-insert.js"

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
  const target = captureQuickInsertTarget(editor)
  const listener = ({ transaction, appendedTransactions = [] }) => {
    for (const current of [transaction, ...appendedTransactions]) mapQuickInsertTarget(target, current)
  }
  editor.on("transaction", listener)
  return { target, stop: () => editor.off("transaction", listener) }
}

// 选用能暴露 UTC 跨日问题的本机时间，检查多种显示格式都由同一当地日历/时间生成。
test("日期时间采用本机日历和补零，凌晨日期不被 UTC 截取移到前一天", () => {
  const originalTimezone = process.env.TZ
  process.env.TZ = "Asia/Shanghai"
  try {
    const values = Object.fromEntries(getQuickDateOptions(new Date("2026-10-01T16:05:07.000Z")).map(option => [option.id, option.value]))
    assert.deepEqual(values, {
      chinese: "2026年10月02日", iso: "2026-10-02", slash: "2026/10/02", weekday: "2026年10月02日 星期五",
      time: "00:05", seconds: "00:05:07", datetime: "2026-10-02 00:05"
    })
    assert.deepEqual(getQuickDateOptions(new Date(NaN)), [])
    assert.deepEqual(getQuickDateOptions("2026-10-02"), [])
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimezone
  }
})

test("字符替换打开时的文字范围，移动当前光标不改目标且前后输入分别撤销", () => {
  const editor = createEditor()
  try {
    editor.commands.insertContentAt(1, "X")
    select(editor, 2, 5)
    const { target, stop } = track(editor)
    const before = editor.getJSON()
    select(editor, editor.state.doc.firstChild.nodeSize + 1)
    let updates = 0
    editor.on("update", () => { updates += 1 })
    assert.deepEqual(insertQuickText(editor, target, "×"), { ok: true, changed: true })
    assert.deepEqual(editor.getJSON().content.map(node => node.content[0].text), ["X×ha", "beta"])
    assert.equal(updates, 1)
    const inserted = editor.getJSON()
    editor.commands.insertContent("Y")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), inserted)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.undo()
    assert.equal(editor.state.doc.firstChild.textContent, "alpha")
    stop()
  } finally { editor.destroy() }
})

// 同时插入多码点表情和标签外形，验证直接 insertText 语义与 storedMarks 恢复，不依赖 HTML 内容解析。
test("表情保留原光标待输入样式，HTML 外形文本不被解析成节点", () => {
  const editor = createEditor()
  try {
    select(editor, 2)
    editor.commands.toggleBold()
    const { target, stop } = track(editor)
    select(editor, editor.state.doc.firstChild.nodeSize + 1)
    assert.equal(insertQuickText(editor, target, "👩‍💻❤️").ok, true)
    const inserted = editor.getJSON().content[0].content.find(node => node.text === "👩‍💻❤️")
    assert.deepEqual(inserted.marks, [{ type: "bold" }])
    stop()
    const raw = "<svg onload=x>❤️</svg>"
    const next = captureQuickInsertTarget(editor)
    assert.equal(insertQuickText(editor, next, raw).ok, true)
    assert.match(editor.getHTML(), /&lt;svg onload=x&gt;❤️&lt;\/svg&gt;/)
    const types = new Set()
    editor.state.doc.descendants(node => { types.add(node.type.name) })
    assert.deepEqual([...types].sort(), ["paragraph", "text"])
  } finally { editor.destroy() }
})

test("插件追加插入与合法段落转标题事务映射原目标，避免写入前置段落", () => {
  const editor = createEditor()
  try {
    editor.registerPlugin(new Plugin({
      appendTransaction: (transactions, oldState, state) => transactions.some(tr => tr.getMeta("quickInsertAppend"))
        ? state.tr.insert(0, state.schema.nodes.paragraph.create(null, state.schema.text("prefix"))) : null
    }))
    select(editor, 2)
    const { target, stop } = track(editor)
    editor.view.dispatch(editor.state.tr.setMeta("quickInsertAppend", true))
    const originalPosition = editor.state.doc.firstChild.nodeSize
    editor.view.dispatch(editor.state.tr.setNodeMarkup(originalPosition, editor.state.schema.nodes.heading, { level: 6 }))
    assert.equal(target.valid, true)
    assert.equal(target.doc, editor.state.doc)
    assert.equal(getQuickInsertSelection(editor, target).from, originalPosition + 2)
    select(editor, editor.state.doc.content.size - 1)
    assert.equal(insertQuickText(editor, target, "±").ok, true)
    assert.deepEqual(editor.getJSON().content.map(node => [node.type, node.content[0].text]), [["paragraph", "prefix"], ["heading", "a±lpha"], ["paragraph", "beta"]])
    stop()
  } finally { editor.destroy() }
})

// 先删除/替换再 undo，看起来回到原文仍必须拒绝旧目标，防止失效草稿重新绑定到恢复后的节点。
test("同位置整段替换和删除原文字范围永久使书签失效，撤销不能复活旧草稿", () => {
  for (const action of ["replace", "delete"]) {
    const editor = createEditor()
    try {
      select(editor, 2, 4)
      const { target, stop } = track(editor)
      const first = editor.state.doc.firstChild
      editor.view.dispatch(action === "replace" ? editor.state.tr.replaceWith(0, first.nodeSize, first) : editor.state.tr.delete(2, 4))
      assert.equal(target.valid, false)
      const before = editor.getJSON()
      const selection = editor.state.selection.toJSON()
      assert.equal(insertQuickText(editor, target, "∞").ok, false)
      assert.deepEqual(editor.getJSON(), before)
      assert.deepEqual(editor.state.selection.toJSON(), selection)
      editor.commands.undo()
      assert.equal(getQuickInsertSelection(editor, target), null)
      assert.equal(insertQuickText(editor, target, "∞").ok, false)
      stop()
    } finally { editor.destroy() }
  }
})

test("分段或合段不能让原光标重定向到另一个文字块，未跟踪事务也安全拒绝", () => {
  for (const action of ["split", "join", "untracked"]) {
    const editor = createEditor()
    try {
      select(editor, action === "join" ? editor.state.doc.firstChild.nodeSize + 2 : 3)
      const { target, stop } = track(editor)
      if (action === "split") editor.view.dispatch(editor.state.tr.split(3))
      else if (action === "join") editor.view.dispatch(editor.state.tr.join(editor.state.doc.firstChild.nodeSize))
      else { stop(); editor.view.dispatch(editor.state.tr.insertText("X", 1)) }
      const before = editor.getJSON()
      assert.equal(getQuickInsertSelection(editor, target), null)
      assert.equal(insertQuickText(editor, target, "→").ok, false)
      assert.deepEqual(editor.getJSON(), before)
      stop()
    } finally { editor.destroy() }
  }
})

test("代码块和单元格内文字仍插入普通文本，整表、多格和全选不隐式替换结构", () => {
  const editor = createEditor("<pre><code>code</code></pre><table><tr><td><p>a</p></td><td><p>b</p></td></tr></table>")
  try {
    select(editor, 2)
    assert.equal(insertQuickText(editor, captureQuickInsertTarget(editor), "℃").ok, true)
    assert.equal(editor.state.doc.firstChild.textContent, "c℃ode")
    const tablePosition = editor.state.doc.firstChild.nodeSize
    const table = editor.state.doc.nodeAt(tablePosition)
    const cells = TableMap.get(table).map.map(pos => tablePosition + 1 + pos)
    select(editor, cells[0] + 2)
    assert.equal(insertQuickText(editor, captureQuickInsertTarget(editor), "😀").ok, true)
    assert.equal(editor.state.doc.nodeAt(tablePosition).firstChild.firstChild.textContent, "😀a")
    const updatedCells = TableMap.get(editor.state.doc.nodeAt(tablePosition)).map.map(pos => tablePosition + 1 + pos)
    for (const selection of [NodeSelection.create(editor.state.doc, tablePosition), CellSelection.create(editor.state.doc, updatedCells[0], updatedCells[1]), new AllSelection(editor.state.doc)]) {
      editor.view.dispatch(editor.state.tr.setSelection(selection))
      assert.equal(supportsQuickInsertSelection(editor), false)
      assert.equal(captureQuickInsertTarget(editor), null)
    }
  } finally { editor.destroy() }
})

// setEditable 可以不派发正文事务，缓存 selector 应只描述结构，真正写入每次检查最新权限。
test("支持状态只依赖文字选区，可编辑恢复无需新事务；实时编辑和 IME 守卫阻止写入", () => {
  const editor = createEditor()
  select(editor, 2)
  const { target, stop } = track(editor)
  const before = editor.getJSON()
  const selection = editor.state.selection.toJSON()
  try {
    assert.equal(insertQuickText(editor, target, "★", true).ok, false)
    editor.setEditable(false)
    assert.equal(supportsQuickInsertSelection(editor), true)
    assert.equal(captureQuickInsertTarget(editor), null)
    assert.equal(insertQuickText(editor, target, "★").ok, false)
    editor.setEditable(true)
    assert.equal(supportsQuickInsertSelection(editor), true)
    assert.ok(captureQuickInsertTarget(editor))
    editor.view.input.composing = true
    assert.equal(supportsQuickInsertSelection(editor), true)
    assert.equal(captureQuickInsertTarget(editor), null)
    assert.equal(insertQuickText(editor, target, "★").ok, false)
    editor.view.input.composing = false
    assert.deepEqual(editor.getJSON(), before)
    assert.deepEqual(editor.state.selection.toJSON(), selection)
  } finally { stop(); editor.destroy() }
  assert.equal(supportsQuickInsertSelection(editor), false)
  assert.equal(captureQuickInsertTarget(editor), null)
  assert.equal(insertQuickText(editor, target, "★").ok, false)
})

test("非法内容和控制字符不能写入正文，也不改变原选区", () => {
  const editor = createEditor()
  try {
    select(editor, 2, 4)
    const target = captureQuickInsertTarget(editor)
    const before = editor.getJSON()
    const selection = editor.state.selection.toJSON()
    for (const value of [null, undefined, [], {}, 2, "", "a\nb", "a\tb", "\u0000", "\u007f", "a".repeat(129)]) {
      assert.equal(insertQuickText(editor, target, value).ok, false)
      assert.deepEqual(editor.getJSON(), before)
      assert.deepEqual(editor.state.selection.toJSON(), selection)
    }
  } finally { editor.destroy() }
})
