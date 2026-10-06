/**
 * 验证流式容器的真实 schema、原选区映射、外壳设置和只影响视图的折叠。
 * JSDOM 只验证事务与 DOM 契约，原生布局和鼠标交互由浏览器验收覆盖。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { AllSelection, NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { applyBlockContainerSettings, captureBlockContainerInsertTarget, captureBlockContainerTarget, DETAILS_DEFAULTS, exitBlockContainer,
  getBlockContainerInsertSelection, getBlockContainerTarget, insertBlockContainerAtTarget, mapBlockContainerInsertTarget,
  mapBlockContainerTarget, readBlockContainerSettings, supportsBlockContainerInsertSelection, TEXT_BOX_DEFAULTS,
  unwrapBlockContainer, validateBlockContainerAttrs } from "../src/pages/editor/tools/block-containers.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const createEditor = (content = "<p>alpha</p><p>beta</p>") => new Editor({ element: document.createElement("div"), extensions: createExtensions(), content })
const paragraph = text => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) })
const box = (type = "textBox", content = [paragraph("inside")], attrs = {}) => ({ type, attrs, content })
const select = (editor, from, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
const track = (editor, insert = false) => {
  const target = insert ? captureBlockContainerInsertTarget(editor) : captureBlockContainerTarget(editor)
  const listener = ({ transaction, appendedTransactions = [] }) => {
    for (const current of [transaction, ...appendedTransactions]) (insert ? mapBlockContainerInsertTarget : mapBlockContainerTarget)(target, current)
  }
  editor.on("transaction", listener)
  return { target, stop: () => editor.off("transaction", listener) }
}
const record = content => ({ ...createDocument(), content })

test("容器属性严格限定纯色、整数和单行摘要，文件显式 null 不能绕过契约", () => {
  assert.equal(validateBlockContainerAttrs("textBox", TEXT_BOX_DEFAULTS), "")
  assert.equal(validateBlockContainerAttrs("details", DETAILS_DEFAULTS), "")
  for (const attrs of [{ backgroundColor: "red" }, { borderColor: "#abc" }, { borderWidth: "1" }, { borderWidth: 7 }, { borderWidth: 0.5 },
    { padding: -1 }, { padding: 41 }, { padding: null }, { position: "fixed" }]) assert.ok(validateBlockContainerAttrs("textBox", attrs))
  for (const summary of ["", "  ", null, "a\nb", "a\tb", "a\u007fb", "x".repeat(121)]) assert.ok(validateBlockContainerAttrs("details", { summary }))
  assert.equal(validateBlockContainerAttrs("details", { summary: "说明 <script> 内容" }), "")
  for (const attrs of [{ padding: null }, { borderWidth: null }]) assert.throws(() => validateDocument(record({ type: "doc", content: [box("textBox", undefined, attrs)] })))
  assert.throws(() => validateDocument(record({ type: "doc", content: [box("details", undefined, { summary: null })] })))
})

test("容器支持普通富文本、表格及合法已有嵌套，默认空正文仍使用 paragraph", () => {
  const editor = createEditor({ type: "doc", content: [box("textBox", [box("details", [paragraph("nested")])])] })
  try {
    validateDocument(record(editor.getJSON()))
    editor.state.doc.check()
    const empty = createEditor("<p></p>")
    try { assert.equal(empty.state.doc.firstChild.type.name, "paragraph") } finally { empty.destroy() }
    select(editor, 3)
    assert.equal(supportsBlockContainerInsertSelection(editor), false)
  } finally { editor.destroy() }
})

test("光标插入空容器保留段落两侧文字与格式，并进入容器正文", () => {
  for (const type of ["textBox", "details"]) {
    const editor = createEditor("<p><strong>alpha</strong></p><p>beta</p>")
    try {
      select(editor, 3)
      assert.equal(insertBlockContainerAtTarget(editor, captureBlockContainerInsertTarget(editor), type).ok, true)
      assert.deepEqual(editor.getJSON().content.map(node => node.type), ["paragraph", type, "paragraph", "paragraph"])
      assert.equal(editor.state.doc.child(0).textContent, "al")
      assert.equal(editor.state.doc.child(2).textContent, "pha")
      assert.equal(editor.state.doc.child(0).firstChild.marks[0].type.name, "bold")
      assert.equal(editor.state.doc.child(2).firstChild.marks[0].type.name, "bold")
      assert.equal(getBlockContainerTarget(editor).type, type)
      assert.equal(editor.state.selection.$from.parent.type.name, "paragraph")
      editor.state.doc.check()
    } finally { editor.destroy() }
  }
})

test("完整正反向多段选区包裹原节点，不接受部分段落、结构跨选和已有容器", () => {
  for (const backward of [false, true]) {
    const editor = createEditor("<h2><em>alpha</em></h2><p>beta</p><p>after</p>")
    try {
      const first = editor.state.doc.child(0).toJSON()
      const second = editor.state.doc.child(1).toJSON()
      const end = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize - 1
      select(editor, backward ? end : 1, backward ? 1 : end)
      assert.equal(supportsBlockContainerInsertSelection(editor), true)
      assert.equal(insertBlockContainerAtTarget(editor, captureBlockContainerInsertTarget(editor), "textBox").ok, true)
      assert.deepEqual(editor.getJSON().content[0].content, [first, second])
      assert.equal(editor.state.doc.child(1).textContent, "after")
    } finally { editor.destroy() }
  }
  for (const html of ["<p>alpha</p><p>beta</p>", "<ul><li><p>alpha</p></li></ul>", "<table><tr><td><p>alpha</p></td></tr></table>", '<div data-type="text-box"><p>alpha</p></div>']) {
    const editor = createEditor(html)
    try {
      if (html === "<p>alpha</p><p>beta</p>") select(editor, 2, 4)
      assert.equal(supportsBlockContainerInsertSelection(editor), false)
      assert.equal(captureBlockContainerInsertTarget(editor), null)
    } finally { editor.destroy() }
  }
  const editor = createEditor()
  try {
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    assert.equal(supportsBlockContainerInsertSelection(editor), false)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    assert.equal(supportsBlockContainerInsertSelection(editor), false)
  } finally { editor.destroy() }
})

test("插入书签映射主事务和追加事务，移动当前光标不能重定向原目标", () => {
  const editor = createEditor()
  try {
    editor.registerPlugin(new Plugin({ appendTransaction: (transactions, oldState, state) => transactions.some(tr => tr.getMeta("containerAppend"))
      ? state.tr.insert(0, state.schema.nodes.paragraph.create(null, state.schema.text("prefix"))) : null }))
    select(editor, 3)
    const { target, stop } = track(editor, true)
    editor.view.dispatch(editor.state.tr.insertText("X", 1).setMeta("containerAppend", true))
    select(editor, editor.state.doc.content.size - 2)
    assert.ok(getBlockContainerInsertSelection(editor, target))
    assert.equal(insertBlockContainerAtTarget(editor, target, "details").ok, true)
    assert.deepEqual(editor.getJSON().content.map(node => [node.type, node.type === "details" ? "" : node.content?.[0]?.text]), [
      ["paragraph", "prefix"], ["paragraph", "Xal"], ["details", ""], ["paragraph", "pha"], ["paragraph", "beta"]
    ])
    stop()
  } finally { editor.destroy() }
})

test("同位置替换与删除使原插入目标永久失效，undo 不复活旧书签", () => {
  for (const replacement of [false, true]) {
    const editor = createEditor()
    try {
      select(editor, 3)
      const { target, stop } = track(editor, true)
      const node = editor.state.doc.firstChild
      editor.view.dispatch(replacement ? editor.state.tr.replaceWith(0, node.nodeSize, node) : editor.state.tr.delete(0, node.nodeSize))
      const before = editor.getJSON()
      assert.equal(insertBlockContainerAtTarget(editor, target, "textBox").ok, false)
      assert.deepEqual(editor.getJSON(), before)
      editor.commands.undo()
      assert.equal(getBlockContainerInsertSelection(editor, target), null)
      stop()
    } finally { editor.destroy() }
  }
})

test("整段包裹跟踪全部原段落，中段属性或文字可修改，整段替换后永久失效", () => {
  for (const action of ["markup", "text", "replace"]) {
    const editor = createEditor("<p>one</p><p>two</p><p>end</p><p>after</p>")
    try {
      select(editor, 1, 14)
      const { target, stop } = track(editor, true)
      const tr = editor.state.tr
      if (action === "markup") tr.setNodeMarkup(5, editor.schema.nodes.heading, { level: 2 })
      else if (action === "text") tr.insertText("X", 6)
      else tr.replaceWith(5, 10, editor.schema.nodes.paragraph.create(null, editor.schema.text("NEW")))
      editor.view.dispatch(tr)
      const before = editor.getJSON()
      assert.equal(insertBlockContainerAtTarget(editor, target, "textBox").ok, action !== "replace")
      if (action === "replace") {
        assert.deepEqual(editor.getJSON(), before)
        editor.commands.undo()
        assert.equal(getBlockContainerInsertSelection(editor, target), null)
      } else {
        const middle = editor.state.doc.firstChild.child(1)
        assert.equal(middle.type.name, action === "markup" ? "heading" : "paragraph")
        assert.equal(middle.textContent, action === "text" ? "Xtwo" : "two")
      }
      stop()
    } finally { editor.destroy() }
  }
})

test("设置目标跟随前方插入和属性修改，只合并草稿中实际变更字段", () => {
  const editor = createEditor({ type: "doc", content: [box(), paragraph("after")] })
  try {
    select(editor, 3)
    const { target, stop } = track(editor)
    editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.paragraph.create(null, editor.schema.text("prefix"))))
    const node = editor.state.doc.nodeAt(target.pos)
    editor.view.dispatch(editor.state.tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, padding: 24 }))
    select(editor, editor.state.doc.content.size - 2)
    assert.equal(applyBlockContainerSettings(editor, target, { borderWidth: 3 }).ok, true)
    assert.equal(readBlockContainerSettings(editor, target).attrs.padding, 24)
    assert.equal(readBlockContainerSettings(editor, target).attrs.borderWidth, 3)
    assert.equal(applyBlockContainerSettings(editor, target, { borderWidth: 3 }).changed, false)
    assert.equal(applyBlockContainerSettings(editor, target, { padding: TEXT_BOX_DEFAULTS.padding }).ok, true)
    assert.equal(readBlockContainerSettings(editor, target).attrs.padding, TEXT_BOX_DEFAULTS.padding)
    assert.equal(applyBlockContainerSettings(editor, target, {}).changed, false)
    stop()
  } finally { editor.destroy() }
})

test("设置外壳同位置替换永久失效，原正文及新光标均不改变", () => {
  const editor = createEditor({ type: "doc", content: [box(), paragraph("after")] })
  try {
    select(editor, 3)
    const { target, stop } = track(editor)
    const node = editor.state.doc.firstChild
    editor.view.dispatch(editor.state.tr.replaceWith(0, node.nodeSize, node))
    const before = editor.getJSON()
    const selection = editor.state.selection.toJSON()
    assert.equal(applyBlockContainerSettings(editor, target, { padding: 30 }).ok, false)
    assert.equal(unwrapBlockContainer(editor, target).ok, false)
    assert.equal(exitBlockContainer(editor, target).ok, false)
    assert.deepEqual(editor.getJSON(), before)
    assert.deepEqual(editor.state.selection.toJSON(), selection)
    editor.commands.undo()
    assert.equal(readBlockContainerSettings(editor, target), null)
    stop()
  } finally { editor.destroy() }
})

test("移除外壳完整保留富文本子节点和详情标题，body 光标仍指向原文字", () => {
  const rich = [paragraph("inside"), { type: "bulletList", content: [{ type: "listItem", content: [paragraph("item")] }] }]
  for (const type of ["textBox", "details"]) {
    const editor = createEditor({ type: "doc", content: [box(type, rich, type === "details" ? { summary: "注意事项" } : {}), paragraph("after")] })
    try {
      const original = editor.getJSON().content[0]
      select(editor, 4)
      const offset = editor.state.selection.$from.parentOffset
      assert.equal(unwrapBlockContainer(editor).ok, true)
      const result = editor.getJSON().content
      assert.deepEqual(type === "details" ? result.slice(1, 3) : result.slice(0, 2), original.content)
      if (type === "details") assert.equal(editor.state.doc.firstChild.textContent, "注意事项")
      assert.equal(editor.state.selection.$from.parent.textContent, "inside")
      assert.equal(editor.state.selection.$from.parentOffset, offset)
      editor.commands.undo()
      assert.deepEqual(editor.getJSON().content[0], original)
    } finally { editor.destroy() }
  }
})

test("退出复用外部段落，新段落创建为一步撤销，快捷键优先退出整个代码容器", () => {
  const editor = createEditor({ type: "doc", content: [box("textBox", [{ type: "codeBlock", content: [{ type: "text", text: "x" }] }]), paragraph("after")] })
  try {
    select(editor, 3)
    const original = editor.getJSON()
    // keymap 在模块加载时读取平台；分别尝试两个原生 Mod 修饰键，不使用只回放 steps 的便利命令。
    const handled = ["ctrlKey", "metaKey"].some(modifier => editor.view.someProp("handleKeyDown", handler => handler(editor.view,
      new KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true, cancelable: true }))))
    assert.equal(handled, true)
    assert.equal(editor.state.selection.$from.parent.textContent, "after")
    assert.deepEqual(editor.getJSON(), original)
    // 非末尾容器后是标题时需要新段落，防止误改已有标题的块类型。
    editor.commands.setContent({ type: "doc", content: [box(), { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "heading" }] }] })
    select(editor, 3)
    const before = editor.getJSON()
    assert.equal(exitBlockContainer(editor).changed, true)
    assert.equal(editor.state.doc.child(1).type.name, "paragraph")
    assert.equal(editor.state.selection.$from.parent.type.name, "paragraph")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
  } finally { editor.destroy() }
})

test("插入、设置、移除各隔开前后输入，操作的撤销与重做独立", () => {
  const editor = createEditor()
  try {
    select(editor, 3)
    editor.commands.insertContent("X")
    const before = editor.getJSON()
    assert.equal(insertBlockContainerAtTarget(editor, captureBlockContainerInsertTarget(editor), "textBox").ok, true)
    const inserted = editor.getJSON()
    editor.commands.insertContent("Y")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), inserted)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.redo()
    assert.deepEqual(editor.getJSON(), inserted)
    const settings = captureBlockContainerTarget(editor)
    assert.equal(applyBlockContainerSettings(editor, settings, { padding: 30 }).ok, true)
    const styled = editor.getJSON()
    editor.commands.insertContent("Z")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), styled)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), inserted)
    assert.equal(unwrapBlockContainer(editor).ok, true)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), inserted)
  } finally { editor.destroy() }
})

test("只读、切换、组合输入及销毁拒绝所有正文写入，结构 selector 可编辑恢复无需事务", () => {
  const editor = createEditor()
  try {
    select(editor, 3)
    const insertion = captureBlockContainerInsertTarget(editor)
    editor.setEditable(false, false)
    assert.equal(supportsBlockContainerInsertSelection(editor), true)
    assert.equal(captureBlockContainerInsertTarget(editor), null)
    assert.equal(insertBlockContainerAtTarget(editor, insertion, "textBox").ok, false)
    editor.setEditable(true)
    assert.equal(insertBlockContainerAtTarget(editor, insertion, "textBox", {}, true).ok, false)
    editor.view.input.composing = true
    assert.equal(insertBlockContainerAtTarget(editor, insertion, "textBox").ok, false)
    editor.view.input.composing = false
    assert.equal(insertBlockContainerAtTarget(editor, insertion, "textBox").ok, true)
    const target = captureBlockContainerTarget(editor)
    const original = editor.getJSON()
    for (const mode of ["readonly", "composing", "switching"]) {
      editor.setEditable(mode !== "readonly")
      editor.view.input.composing = mode === "composing"
      const blocked = mode === "switching"
      assert.equal(applyBlockContainerSettings(editor, target, { padding: 30 }, blocked).ok, false)
      assert.equal(unwrapBlockContainer(editor, target, blocked).ok, false)
      assert.equal(exitBlockContainer(editor, target, blocked).ok, false)
      assert.deepEqual(editor.getJSON(), original)
    }
    editor.view.input.composing = false
    editor.destroy()
    assert.equal(applyBlockContainerSettings(editor, target, { padding: 30 }).ok, false)
    assert.equal(unwrapBlockContainer(editor, target).ok, false)
    assert.equal(exitBlockContainer(editor, target).ok, false)
  } finally { if (!editor.isDestroyed) editor.destroy() }
})

test("详情折叠不改变 JSON、HTML、更新次数或历史，只读可操作且搜索选区自动展开", () => {
  const editor = createEditor({ type: "doc", content: [box("details", [paragraph("inside")], { summary: "说明 <script>" }), paragraph("after")] })
  let updates = 0
  editor.on("update", () => { updates += 1 })
  try {
    select(editor, 3)
    const original = editor.getJSON()
    const html = editor.getHTML()
    const toggle = editor.view.dom.querySelector("[data-details-toggle]")
    const body = editor.view.dom.querySelector("[data-details-content]")
    assert.equal(toggle.getAttribute("aria-expanded"), "true")
    assert.equal(toggle.textContent.includes("说明 <script>"), true)
    toggle.click()
    assert.equal(body.hidden, true)
    assert.ok(editor.state.selection instanceof NodeSelection)
    assert.equal(toggle.getAttribute("aria-expanded"), "false")
    assert.equal(editor.getHTML(), html)
    assert.deepEqual(editor.getJSON(), original)
    assert.equal(updates, 0)
    assert.equal(editor.commands.undo(), false)
    editor.setEditable(false, false)
    toggle.click()
    assert.equal(body.hidden, false)
    select(editor, editor.state.doc.content.size - 2)
    toggle.click()
    assert.equal(body.hidden, true)
    assert.equal(editor.state.selection.$from.parent.textContent, "after")
    select(editor, 4)
    assert.equal(body.hidden, false)
    assert.equal(toggle.getAttribute("aria-expanded"), "true")
    assert.equal(updates, 0)
    assert.match(html, /<details[^>]+open="open"/)
    assert.match(html, /说明 &lt;script&gt;/)
  } finally { editor.destroy() }
})

test("合法 HTML 保留容器属性和完整正文，非法标记只展平外壳而不删除正文", () => {
  const editor = createEditor({ type: "doc", content: [box("textBox", [paragraph("body")], { backgroundColor: "#123456", borderColor: "#654321", borderWidth: 0, padding: 0 }), box("details", [paragraph("detail body")], { summary: "摘要" }), paragraph()] })
  try {
    const original = editor.getJSON()
    const html = editor.getHTML()
    editor.commands.setContent(html)
    assert.deepEqual(editor.getJSON(), original)
    editor.commands.setContent('<div data-type="text-box" data-padding="999"><p>retain bad box body</p></div><details data-type="details"><summary>bad\nsummary</summary><p>retain bad details body</p></details>')
    assert.equal(editor.getText().includes("retain bad box body"), true)
    assert.equal(editor.getText().includes("retain bad details body"), true)
    assert.equal(editor.getJSON().content.some(node => ["textBox", "details"].includes(node.type)), false)
    editor.commands.setContent("<details><summary>native summary</summary><p>native body</p></details>")
    assert.equal(editor.state.doc.firstChild.type.name, "details")
    assert.equal(editor.state.doc.firstChild.attrs.summary, "native summary")
    assert.equal(editor.state.doc.firstChild.textContent, "native body")
    editor.commands.setContent('<details data-type="details"><summary>摘要</summary><div data-details-content><p>first body</p></div><div data-details-content><p>second body</p></div>outside tail</details>')
    assert.equal(editor.getText().includes("first body"), true)
    assert.equal(editor.getText().includes("second body"), true)
    assert.equal(editor.getText().includes("outside tail"), true)
    assert.equal(editor.getText().includes("摘要"), true)
  } finally { editor.destroy() }
})

test("组合输入不收起详情，嵌套折叠祖先随真实内部选区自动展开", () => {
  const editor = createEditor({ type: "doc", content: [box("details", [box("details", [paragraph("nested body")], { summary: "内层" })], { summary: "外层" }), paragraph("after")] })
  try {
    select(editor, editor.state.doc.content.size - 2)
    const toggles = Array.from(editor.view.dom.querySelectorAll("[data-details-toggle]"))
    editor.view.input.composing = true
    toggles[0].click()
    assert.equal(toggles[0].getAttribute("aria-expanded"), "true")
    editor.view.input.composing = false
    toggles[1].click()
    toggles[0].click()
    assert.equal(toggles[0].getAttribute("aria-expanded"), "false")
    assert.equal(toggles[1].getAttribute("aria-expanded"), "false")
    select(editor, 4)
    assert.equal(toggles[0].getAttribute("aria-expanded"), "true")
    assert.equal(toggles[1].getAttribute("aria-expanded"), "true")
    assert.equal(toggles[0].querySelector("svg").classList.contains("tabler-icon-chevron-right"), true)
  } finally { editor.destroy() }
})

test("详情正文 DOM 编辑仍进入 ProseMirror，NodeView 只忽略自己的展示变更", async () => {
  const editor = createEditor({ type: "doc", content: [box("details", [paragraph("inside")]), paragraph("after")] })
  try {
    const text = editor.view.dom.querySelector("[data-details-content] p").firstChild
    text.nodeValue = "changed body"
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(editor.state.doc.firstChild.textContent, "changed body")
    assert.equal(editor.state.doc.firstChild.type.name, "details")
    assert.equal(editor.view.dom.querySelector("[data-details-toggle]").getAttribute("aria-expanded"), "true")
    editor.commands.undo()
    assert.equal(editor.state.doc.firstChild.textContent, "inside")
  } finally { editor.destroy() }
})

test("详情原生纯文本复制完整节点含标题，局部正文只含所选字符，嵌套标题不重复", () => {
  const editor = createEditor({ type: "doc", content: [box("details", [paragraph("inside body"), box("details", [paragraph("inner body")], { summary: "内层摘要" }),
    { type: "paragraph", content: [{ type: "inlineMath", attrs: { latex: "x^2" } }] }], { summary: "外层摘要" }), paragraph("after")] })
  try {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    const copied = editor.view.serializeForClipboard(editor.state.selection.content())
    assert.match(copied.text, /^外层摘要\n\ninside body/)
    assert.equal(copied.text.includes("inner body"), true)
    assert.equal(copied.text.includes("$x^2$"), true)
    assert.equal(copied.text.split("外层摘要").length - 1, 1)
    assert.equal(copied.text.split("内层摘要").length - 1, 1)
    assert.equal(copied.text.includes("after"), false)
    select(editor, 3, 6)
    assert.equal(editor.view.serializeForClipboard(editor.state.selection.content()).text, "nsi")
    let innerPos = null
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "details" && node.attrs.summary === "内层摘要") innerPos = pos })
    select(editor, innerPos + 3, innerPos + 6)
    assert.equal(editor.view.serializeForClipboard(editor.state.selection.content()).text, "nne")
    assert.equal(editor.getText().split("外层摘要").length - 1, 1)
    assert.equal(editor.getText().split("内层摘要").length - 1, 1)
  } finally { editor.destroy() }
})
