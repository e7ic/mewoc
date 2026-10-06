/** 上下标与待办清单的真实 schema/事务/DOM 回归：重点验证状态、结构和保存/撤销边界。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor, generateHTML, generateJSON } from "@tiptap/core"
import { DOMParser as ProseMirrorDOMParser, DOMSerializer, Slice } from "@tiptap/pm/model"
import { AllSelection, TextSelection } from "@tiptap/pm/state"
import { undoDepth } from "@tiptap/pm/history"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { clearTextFormatting, stripCommentAnchors } from "../src/pages/editor/tools/comment-clipboard.js"
import { getCurrentListType, supportsDocumentListSelection } from "../src/pages/editor/extensions/document-task-list.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { supportsTextScriptSelection } from "../src/pages/editor/extensions/text-scripts.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
// ProseMirror 在模块载入时决定 Mod；保留宿主平台，避免 JSDOM 空 platform 与它采用不同修饰键。
Object.defineProperty(DOM.window.navigator, "platform", { value: globalThis.navigator?.platform || "" })
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const paragraph = text => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) })
const task = (text, checked = false, extra = []) => ({ type: "taskItem", attrs: { checked }, content: [paragraph(text), ...extra] })
const list = (...items) => ({ type: "taskList", content: items })
const createEditor = (...content) => new Editor({
  element: document.body.appendChild(document.createElement("div")), extensions: createExtensions(), content: { type: "doc", content }
})
const all = editor => editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
const positions = (editor, name) => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === name) result.push({ node, pos }) })
  return result
}
const press = (editor, key, extra = {}) => editor.view.dom.dispatchEvent(new DOM.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }))

test("上下标互斥、保留其它文字格式，can 探测不修改文档，HTML 往返保留语义", () => {
  const editor = createEditor(paragraph("H2O"))
  try {
    editor.commands.setTextSelection({ from: 2, to: 3 })
    editor.commands.setBold()
    const before = editor.getJSON()
    assert.equal(editor.can().toggleSubscript(), true)
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(editor.commands.toggleSubscript(), true)
    assert.deepEqual(editor.getJSON().content[0].content[1].marks.map(mark => mark.type).sort(), ["bold", "subscript"])
    const subscript = editor.getJSON()
    assert.equal(editor.can().toggleSuperscript(), true)
    assert.deepEqual(editor.getJSON(), subscript)
    assert.equal(editor.commands.toggleSuperscript(), true)
    assert.deepEqual(editor.getJSON().content[0].content[1].marks.map(mark => mark.type).sort(), ["bold", "superscript"])
    const html = generateHTML(editor.getJSON(), createExtensions())
    assert.match(html, /<sup>/)
    assert.deepEqual(generateJSON(html, createExtensions()), editor.getJSON())
    assert.doesNotThrow(() => validateDocument({ ...createDocument(), content: editor.getJSON() }))
  } finally { editor.destroy() }
})

test("最近列表层级回显和快捷键转换区分普通子列表与任务祖先", () => {
  const child = { type: "bulletList", content: [{ type: "listItem", content: [paragraph("普通子项")] }] }
  const editor = createEditor(list(task("任务祖先", true, [child])))
  try {
    editor.commands.setTextSelection(3)
    assert.equal(getCurrentListType(editor), "taskList")
    editor.commands.setTextSelection(positions(editor, "paragraph")[1].pos + 1)
    assert.equal(getCurrentListType(editor), "bulletList")
    const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform)
    press(editor, "9", { metaKey: mac, ctrlKey: !mac, shiftKey: true })
    assert.equal(getCurrentListType(editor), "taskList")
    assert.deepEqual(positions(editor, "taskItem").map(item => item.node.attrs.checked), [true, false])
    press(editor, "7", { metaKey: mac, ctrlKey: !mac, shiftKey: true })
    assert.equal(getCurrentListType(editor), "orderedList")
    assert.equal(positions(editor, "taskItem")[0].node.attrs.checked, true)
    assert.equal(positions(editor, "listItem")[0].node.textContent, "普通子项")
  } finally { editor.destroy() }
})

test("上下标跳过代码段、行内代码和非文字节点，混合选区只修改允许的文字", () => {
  const editor = createEditor({ type: "paragraph", content: [
    { type: "text", text: "文字" }, { type: "text", text: "code", marks: [{ type: "code" }] }
  ] }, { type: "codeBlock", content: [{ type: "text", text: "const value = 2" }] })
  try {
    all(editor)
    editor.commands.toggleSuperscript()
    assert.equal(editor.getJSON().content[0].content[0].marks[0].type, "superscript")
    assert.deepEqual(editor.getJSON().content[0].content[1].marks, [{ type: "code" }])
    assert.equal(editor.getJSON().content[1].content[0].marks, undefined)
    editor.commands.setTextSelection({ from: 3, to: 7 })
    assert.equal(editor.can().toggleSubscript(), false)
    const before = editor.getJSON()
    assert.equal(editor.commands.toggleSubscript(), false)
    assert.deepEqual(editor.getJSON(), before)
  } finally { editor.destroy() }
})

test("文字格式修改独立撤销，空光标上下标作用于后续输入并可清除", () => {
  const editor = createEditor(paragraph("abc"))
  try {
    editor.commands.insertContentAt(4, "前")
    const before = editor.getJSON()
    editor.commands.setTextSelection({ from: 1, to: 2 })
    editor.commands.toggleSuperscript()
    const formatted = editor.getJSON()
    editor.commands.insertContentAt(5, "后")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), formatted)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.setTextSelection(2)
    editor.commands.toggleSubscript()
    editor.commands.insertContent("2")
    assert.equal(editor.getJSON().content[0].content[1].marks.some(mark => mark.type === "subscript"), true)
    clearTextFormatting(editor)
    editor.commands.insertContent("x")
    assert.equal(editor.getJSON().content[0].content.find(node => node.text.includes("x")).marks, undefined)
  } finally { editor.destroy() }
})

test("格式刷复制和清除上下标，不改变待办勾选状态", () => {
  const editor = createEditor(paragraph("来源"), list(task("目标", true)))
  try {
    editor.commands.setTextSelection({ from: 1, to: 3 })
    editor.commands.setSubscript()
    editor.commands.copyFormat()
    const target = positions(editor, "paragraph")[1].pos + 1
    editor.commands.setTextSelection({ from: target, to: target + 2 })
    editor.commands.applyFormat()
    assert.equal(positions(editor, "taskItem")[0].node.attrs.checked, true)
    assert.equal(positions(editor, "paragraph")[1].node.firstChild.marks.some(mark => mark.type.name === "subscript"), true)
    editor.commands.setTextSelection({ from: 1, to: 3 })
    clearTextFormatting(editor)
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: target, to: target + 2 })
    editor.commands.applyFormat()
    assert.equal(positions(editor, "paragraph")[1].node.firstChild.marks.some(mark => mark.type.name === "subscript"), false)
  } finally { editor.destroy() }
})

test("已完成任务 Enter 拆分后的新事项未完成，空任务 Enter 退出列表", () => {
  const editor = createEditor(list(task("已完成", true)))
  try {
    editor.commands.setTextSelection(6)
    press(editor, "Enter")
    assert.deepEqual(positions(editor, "taskItem").map(item => item.node.attrs.checked), [true, false])
    press(editor, "Enter")
    assert.deepEqual(editor.getJSON().content.map(node => node.type), ["taskList", "paragraph", "paragraph"])
    assert.equal(editor.getJSON().content[0].content[0].attrs.checked, true)
  } finally { editor.destroy() }
})

test("任务 Tab/Shift-Tab 保留勾选及文字，嵌套任务可独立退出", () => {
  const editor = createEditor(list(task("一级", true), task("二级", true)))
  try {
    const second = positions(editor, "paragraph")[1].pos + 1
    editor.commands.setTextSelection(second)
    press(editor, "Tab")
    const nested = editor.getJSON().content[0].content[0].content[1]
    assert.equal(nested.type, "taskList")
    assert.equal(nested.content[0].attrs.checked, true)
    press(editor, "Tab", { shiftKey: true })
    assert.deepEqual(editor.getJSON().content[0].content.map(item => item.attrs.checked), [true, true])
  } finally { editor.destroy() }
})

test("三种列表转换保留多段和嵌套结构，普通列表转回任务重置直属勾选", () => {
  const nested = list(task("子任务", true))
  const editor = createEditor(list(task("父任务", true, [paragraph("备注"), nested]), task("下一项")))
  try {
    editor.commands.setTextSelection(3)
    const original = editor.getJSON()
    const beforeSelection = editor.state.selection.toJSON()
    assert.equal(editor.can().toggleDocumentList("orderedList"), true)
    assert.deepEqual(editor.getJSON(), original)
    assert.equal(editor.commands.toggleDocumentList("orderedList"), true)
    const ordered = editor.getJSON().content[0]
    assert.equal(ordered.type, "orderedList")
    assert.equal(ordered.content[0].type, "listItem")
    assert.equal(ordered.content[0].attrs, undefined)
    assert.deepEqual(ordered.content[0].content, original.content[0].content[0].content)
    assert.deepEqual(editor.state.selection.toJSON(), beforeSelection)
    editor.commands.toggleDocumentList("bulletList")
    editor.commands.toggleTaskList()
    assert.deepEqual(editor.getJSON().content[0].content.map(item => item.attrs.checked), [false, false])
    assert.equal(positions(editor, "taskItem")[1].node.attrs.checked, true)
    editor.commands.undo()
    assert.equal(editor.getJSON().content[0].type, "bulletList")
    editor.commands.undo()
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), original)
  } finally { editor.destroy() }
})

test("多段正文创建清单与全选单个列表切换保留段落，跨容器选区不展平", () => {
  const editor = createEditor(paragraph("一"), paragraph("二"))
  try {
    all(editor)
    assert.equal(editor.commands.toggleTaskList(), true)
    assert.equal(positions(editor, "taskItem").length, 2)
    all(editor)
    assert.equal(editor.commands.toggleDocumentList("bulletList"), true)
    assert.equal(editor.getJSON().content[0].content.length, 2)
    all(editor)
    assert.equal(editor.commands.toggleDocumentList("bulletList"), true)
    assert.deepEqual(editor.getJSON().content.map(node => node.type), ["paragraph", "paragraph", "paragraph"])
    editor.commands.setContent({ type: "doc", content: [list(task("任务", true)), paragraph("外部")] })
    all(editor)
    const before = editor.getJSON()
    assert.equal(editor.commands.toggleDocumentList("orderedList"), false)
    assert.deepEqual(editor.getJSON(), before)
  } finally { editor.destroy() }
})

test("列表支持查询与命令共用混合选区规则，结构结果不受只读切换影响", () => {
  const editor = createEditor(list(task("事项")), paragraph("外部文字"))
  try {
    all(editor)
    assert.equal(supportsDocumentListSelection(editor), false)
    for (const type of ["bulletList", "orderedList", "taskList"]) assert.equal(editor.can().toggleDocumentList(type), false)
    editor.commands.setTextSelection(3)
    assert.equal(supportsDocumentListSelection(editor), true)
    editor.setEditable(false, false)
    assert.equal(supportsDocumentListSelection(editor), true)
    assert.equal(editor.can().toggleDocumentList("bulletList"), false)
    editor.setEditable(true, false)
    assert.equal(supportsDocumentListSelection(editor), true)
    assert.equal(editor.can().toggleDocumentList("bulletList"), true)
  } finally { editor.destroy() }
})

test("完整编辑器创建末尾待办及自动尾段共用一次撤销，勾选另占一次历史", () => {
  for (const replaceContent of [false, true]) {
    const fixture = [paragraph("任务甲"), paragraph("任务乙"), paragraph("任务丙")]
    const editor = createEditor(...(replaceContent ? [paragraph("原文")] : fixture))
    try {
      if (replaceContent) editor.commands.setContent({ type: "doc", content: fixture })
      const before = editor.getJSON()
      const depth = undoDepth(editor.state)
      editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 })
      editor.chain().focus().toggleDocumentList("taskList").run()
      const created = editor.getJSON()
      assert.deepEqual(created.content.map(node => node.type), ["taskList", "paragraph"])
      assert.equal(undoDepth(editor.state), depth + 1)
      editor.view.dom.querySelectorAll('input[type="checkbox"]')[1].click()
      assert.equal(undoDepth(editor.state), depth + 2)
      assert.equal(positions(editor, "taskItem")[1].node.attrs.checked, true)
      editor.commands.undo()
      assert.deepEqual(editor.getJSON(), created)
      editor.commands.undo()
      assert.deepEqual(editor.getJSON(), before)
      assert.equal(undoDepth(editor.state), depth)
      editor.commands.redo()
      editor.commands.redo()
      assert.equal(positions(editor, "taskItem")[1].node.attrs.checked, true)
    } finally { editor.destroy() }
  }
})

test("上下标支持查询只计算文字结构，切换只读与相反标记不会缓存禁用结果", () => {
  const editor = createEditor(paragraph("文字"), { type: "codeBlock", content: [{ type: "text", text: "code" }] })
  try {
    editor.commands.setTextSelection({ from: 1, to: 3 })
    editor.commands.setSubscript()
    assert.equal(supportsTextScriptSelection(editor, "superscript"), true)
    editor.setEditable(false, false)
    assert.equal(supportsTextScriptSelection(editor, "superscript"), true)
    assert.equal(editor.can().toggleSuperscript(), false)
    editor.setEditable(true, false)
    assert.equal(supportsTextScriptSelection(editor, "superscript"), true)
    assert.equal(editor.can().toggleSuperscript(), true)
    editor.commands.setTextSelection(positions(editor, "codeBlock")[0].pos + 1)
    assert.equal(supportsTextScriptSelection(editor, "superscript"), false)
    assert.equal(supportsTextScriptSelection(editor, "subscript"), false)
  } finally { editor.destroy() }
})

test("任务复选框真实 DOM 勾选可独立撤销，只读与组合输入不改数据也不残留视觉勾选", () => {
  const editor = createEditor(list(task("任务")), paragraph("后续"))
  try {
    const input = editor.view.dom.querySelector('input[type="checkbox"]')
    editor.commands.insertContentAt(4, "前")
    const before = editor.getJSON()
    input.click()
    assert.equal(positions(editor, "taskItem")[0].node.attrs.checked, true)
    const checked = editor.getJSON()
    editor.commands.insertContentAt(4, "后")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), checked)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(input.checked, false)
    editor.setEditable(false, false)
    assert.equal(input.disabled, true)
    input.click()
    assert.deepEqual(editor.getJSON(), before)
    editor.setEditable(true, false)
    assert.equal(input.disabled, false)
    Object.defineProperty(editor.view, "composing", { configurable: true, value: true })
    input.click()
    assert.equal(input.checked, false)
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(editor.commands.toggleTaskList(), false)
    assert.equal(editor.commands.toggleSubscript(), false)
    delete editor.view.composing
  } finally { editor.destroy() }
})

test("只读拒绝任务及上下标命令，非法 checked 和互斥标记不能进入文件", () => {
  const editor = createEditor(list(task("事项")))
  try {
    editor.setEditable(false, false)
    for (const command of ["toggleSuperscript", "toggleSubscript", "toggleTaskList"]) assert.equal(editor.commands[command](), false)
    assert.equal(editor.commands.setTaskCheckedAt(1, true), false)
    for (const checked of [null, "true", 1]) {
      assert.throws(() => validateDocument({ ...createDocument(), content: { type: "doc", content: [list(task("无效", checked))] } }), /checked/)
    }
    assert.throws(() => validateDocument({ ...createDocument(), content: { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "2", marks: [{ type: "superscript" }, { type: "subscript" }] }
    ] }] } }), /上标和下标/)
  } finally { editor.destroy() }
})

test("完整及嵌套待办通过 HTML/剪贴板保留勾选，静态复选框禁用而内部粘贴可继续编辑", () => {
  const editor = createEditor(list(task("完成", true, [list(task("未完成"))]), task("继续")))
  try {
    editor.commands.setTextSelection({ from: 3, to: 5 })
    editor.commands.setSuperscript()
    const content = editor.getJSON()
    const html = generateHTML(content, createExtensions())
    const fragment = document.createElement("div")
    fragment.innerHTML = html
    assert.equal(fragment.querySelectorAll("input[disabled]").length, 3)
    assert.equal(fragment.querySelectorAll("input[checked]").length, 1)
    assert.deepEqual(generateJSON(html, createExtensions()), content)
    const slice = stripCommentAnchors(new Slice(editor.state.doc.content, 0, 0))
    const copied = document.createElement("div")
    copied.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(slice.content))
    copied.innerHTML = cleanPastedHtml(copied.innerHTML)
    const pasted = ProseMirrorDOMParser.fromSchema(editor.schema).parse(copied)
    assert.deepEqual(pasted.toJSON(), content)
    editor.commands.setTextSelection(TextSelection.atEnd(editor.state.doc).from)
    assert.doesNotThrow(() => validateDocument({ ...createDocument(), content }))
  } finally { editor.destroy() }
})

test("剪贴板只恢复合法任务语义和上下标，不接受事件、交互表单或异常 checked", () => {
  const html = cleanPastedHtml('<ul data-type="taskList" onclick="alert(1)"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" onclick="alert(1)"><span>不应入正文的辅助标签</span></label><div><p>有效<span style="vertical-align: super; position: fixed">2</span></p></div></li><li data-type="taskItem" data-checked="yes"><div><p>无效完成状态</p></div></li></ul>')
  assert.doesNotMatch(html, /onclick|position|<input|辅助标签/)
  const editor = new Editor({ element: document.createElement("div"), extensions: createExtensions(), content: html })
  try {
    assert.deepEqual(positions(editor, "taskItem").map(item => item.node.attrs.checked), [true, false])
    assert.equal(editor.getJSON().content[0].content[0].content[0].content[1].marks.some(mark => mark.type === "superscript"), true)
    assert.equal(editor.view.dom.querySelector('input[type="checkbox"]').disabled, false)
    assert.doesNotThrow(() => validateDocument({ ...createDocument(), content: editor.getJSON() }))
  } finally { editor.destroy() }
})

test("实际剪贴板清理保留合法编号起始号与样式，拒绝越界和任意类型", () => {
  for (const type of ["1", "a", "A", "i", "I"]) {
    const source = createEditor({ type: "orderedList", attrs: { start: 27, type }, content: [{ type: "listItem", content: [paragraph("编号事项")] }] })
    try {
      const pasted = generateJSON(cleanPastedHtml(source.getHTML()), createExtensions())
      assert.equal(pasted.content[0].attrs.start, 27)
      // 官方 HTML 序列化省略默认 type="1"；null 与 "1" 均表示十进制。
      assert.equal(pasted.content[0].attrs.type || "1", type)
      assert.deepEqual(pasted.content[0].content, source.getJSON().content[0].content)
    } finally { source.destroy() }
  }
  const invalid = cleanPastedHtml('<ol start="1000000000" type="decimal"><li>越界</li></ol><ol start="0" type="url(javascript:alert(1))"><li>无效</li></ol>')
  assert.doesNotMatch(invalid, /start=|type=/)
  assert.match(cleanPastedHtml('<ol start="999999999" type="I"><li>边界</li></ol>'), /start="999999999"/)
})
