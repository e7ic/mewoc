/**
 * 验证完整工具栏字号步进、段落缩进、原选区书签和编辑状态守卫。
 * 字号遵循实际外观及白名单，缩进只提交 dirty 属性，主事务和追加事务都保留原段落身份。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { AllSelection, NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { FONT_SIZES } from "../src/pages/editor/constants/editor-constants.js"
import { mapParagraphTarget } from "../src/pages/editor/tools/paragraph-settings.js"
import { getSelectionTextStyle } from "../src/pages/editor/tools/text-appearance.js"
import { applyRibbonParagraphIndent, canEditRibbon, captureRibbonIndentTarget, getSteppedFontSize, stepFontSize } from "../src/pages/editor/tools/ribbon-commands.js"

// 安装编辑器需要的浏览器对象和帧调度，让 Node 测试执行真实 schema/事务逻辑；JSDOM 不承担原生版式验收。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// 每个场景创建独立编辑器并在 finally 销毁，隔离正文、插件和撤销历史；扩展组合只提供该组验证所需能力。
const createEditor = (content = "<p>one</p><p>two</p>") => new Editor({
  element: document.createElement("div"),
  extensions: createExtensions().map(extension => extension.name === "starterKit" ? extension.configure({ trailingNode: false }) : extension), content
})
const select = (editor, from, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
// 模拟弹层打开期间的目标跟踪，主事务与插件追加事务都依次映射；stop 用于场景结束时解除监听。
const track = editor => {
  const target = captureRibbonIndentTarget(editor)
  const listener = ({ transaction, appendedTransactions = [] }) => {
    for (const current of [transaction, ...appendedTransactions]) mapParagraphTarget(target, current)
  }
  editor.on("transaction", listener)
  return { target, stop: () => editor.off("transaction", listener) }
}

test("字号按既有白名单上下步进，混合默认12pt，最小最大不能越界", () => {
  FONT_SIZES.forEach((size, index) => {
    assert.equal(getSteppedFontSize(size, 1), FONT_SIZES[index + 1] || null)
    assert.equal(getSteppedFontSize(size, -1), FONT_SIZES[index - 1] || null)
  })
  for (const mixed of ["mixed", null, undefined, "unknown"]) {
    assert.equal(getSteppedFontSize(mixed, 1), "12.75pt")
    assert.equal(getSteppedFontSize(mixed, -1), "11.25pt")
  }
  assert.equal(getSteppedFontSize("13pt", 1), "14pt")
  assert.equal(getSteppedFontSize("13pt", -1), "12.75pt")
  assert.equal(getSteppedFontSize("12pt", 0), null)
})

test("真实混合选区步进统一显式字号，单次undo保留前次输入，再次步进独立撤销", () => {
  const editor = createEditor('<p><span style="font-size:10pt">one</span><span style="font-size:18pt">two</span></p>')
  try {
    editor.commands.insertContentAt(2, "前次输入")
    select(editor, 1, editor.state.doc.content.size - 1)
    const before = editor.getJSON()
    assert.equal(getSelectionTextStyle(editor).fontSize, "mixed")
    assert.equal(stepFontSize(editor, 1), true)
    assert.equal(getSelectionTextStyle(editor).fontSize, "12.75pt")
    const firstStep = editor.getJSON()
    assert.equal(stepFontSize(editor, 1), true)
    assert.equal(getSelectionTextStyle(editor).fontSize, "14pt")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), firstStep)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    assert.match(editor.getText(), /前次输入/)
    editor.commands.redo()
    assert.equal(getSelectionTextStyle(editor).fontSize, "12.75pt")
  } finally { editor.destroy() }
})

// 空光标设置属于下一次输入格式，不能清掉粗体等其他 marks；无下一档字号时也不能创建历史。
test("空选区字号步进保留其他待输入mark，边界字号操作不写文档", () => {
  const editor = createEditor()
  try {
    select(editor, 2)
    editor.commands.setFontSize("12pt")
    editor.commands.setColor("#112233")
    editor.commands.toggleItalic()
    assert.equal(stepFontSize(editor, -1), true)
    editor.commands.insertContent("新")
    const text = editor.getJSON().content[0].content.find(node => node.text.includes("新"))
    assert.equal(text.marks.find(mark => mark.type === "textStyle").attrs.fontSize, "11.25pt")
    assert.equal(text.marks.find(mark => mark.type === "textStyle").attrs.color, "#112233")
    assert.ok(text.marks.some(mark => mark.type === "italic"))
    editor.commands.setFontSize("32pt")
    const before = editor.getJSON()
    assert.equal(stepFontSize(editor, 1), false)
    assert.deepEqual(editor.getJSON(), before)
  } finally { editor.destroy() }
})

test("只读、切换、输入法组合中和销毁后，字号及弹层缩进均拒绝修改", () => {
  const editor = createEditor()
  const { target, stop } = track(editor)
  const before = editor.getJSON()
  try {
    assert.equal(stepFontSize(editor, 1, true), false)
    assert.equal(applyRibbonParagraphIndent(editor, target, { leftIndent: 2 }, true), false)
    editor.setEditable(false)
    assert.equal(canEditRibbon(editor), false)
    assert.equal(captureRibbonIndentTarget(editor), null)
    assert.equal(stepFontSize(editor, 1), false)
    assert.equal(applyRibbonParagraphIndent(editor, target, { leftIndent: 2 }), false)
    editor.setEditable(true)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionstart", { bubbles: true }))
    assert.equal(stepFontSize(editor, 1), false)
    assert.equal(applyRibbonParagraphIndent(editor, target, { leftIndent: 2 }), false)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionend", { bubbles: true }))
    assert.deepEqual(editor.getJSON(), before)
  } finally { stop(); editor.destroy() }
  assert.equal(canEditRibbon(editor), false)
  assert.equal(stepFontSize(editor, 1), false)
  assert.equal(applyRibbonParagraphIndent(editor, target, { leftIndent: 2 }), false)
})

// 打开弹层后移动光标并修改前方正文，最终检查原段落、未改字段和 undo，防止目标漂移或旧 attrs 覆盖。
test("缩进弹层遵循原选区映射，只改变dirty字段并独立undo，不随新光标改目标", () => {
  const editor = createEditor('<p style="text-indent:2em;margin-left:3em;margin-top:5pt">one</p><p>two</p>')
  try {
    editor.commands.insertContentAt(2, "前次输入")
    select(editor, 1)
    const { target, stop } = track(editor)
    const before = editor.getJSON()
    select(editor, editor.state.doc.firstChild.nodeSize + 1)
    assert.equal(applyRibbonParagraphIndent(editor, target, { leftIndent: 4 }), true)
    assert.equal(editor.getJSON().content[0].attrs.leftIndent, 4)
    assert.equal(editor.getJSON().content[0].attrs.firstLineIndent, 2)
    assert.equal(editor.getJSON().content[0].attrs.spaceBefore, 5)
    assert.equal(editor.getJSON().content[1].attrs.leftIndent, 0)
    assert.equal(editor.state.selection.from, 1)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    assert.match(editor.getText(), /前次输入/)
    select(editor, editor.state.doc.firstChild.nodeSize + 1)
    assert.equal(applyRibbonParagraphIndent(editor, target, { leftIndent: 3 }), true)
    assert.equal(editor.state.selection.from, 1)
    assert.deepEqual(editor.getJSON(), before)
    stop()
  } finally { editor.destroy() }
})

// 主事务自身未移动目标，插件 continuation 才插入节点，检出只监听 transaction 而漏掉 appendedTransactions。
test("缩进弹层跟踪插件追加事务，插入前置段落后仍改原段而不触碰新段", () => {
  const editor = createEditor()
  try {
    editor.registerPlugin(new Plugin({
      appendTransaction: (transactions, oldState, state) => transactions.some(tr => tr.getMeta("ribbonTestAppend"))
        ? state.tr.insert(0, state.schema.nodes.paragraph.create(null, state.schema.text("added"))) : null
    }))
    select(editor, 2)
    editor.commands.setFontSize("18pt")
    const { target, stop } = track(editor)
    editor.view.dispatch(editor.state.tr.setMeta("ribbonTestAppend", true))
    select(editor, editor.state.doc.content.size - 1)
    assert.equal(applyRibbonParagraphIndent(editor, target, { firstLineIndent: 2 }), true)
    assert.deepEqual(editor.getJSON().content.map(node => node.attrs.firstLineIndent), [0, 2, 0])
    assert.equal(editor.getAttributes("textStyle").fontSize, "18pt")
    editor.commands.insertContent("新")
    const text = editor.getJSON().content[1].content.find(node => node.text.includes("新"))
    assert.equal(text.marks.find(mark => mark.type === "textStyle").attrs.fontSize, "18pt")
    stop()
  } finally { editor.destroy() }
})

test("原段落同位置整体替换后弹层失效，非法缩进不能写入", () => {
  const editor = createEditor()
  try {
    select(editor, 2)
    const { target, stop } = track(editor)
    const before = editor.getJSON()
    for (const attrs of [null, [], {}, 2, { leftIndent: "2" }, { leftIndent: 9 }, { leftIndent: -1 },
      { firstLineIndent: 0.5 }, { firstLineIndent: 5 }, { firstLineIndent: NaN }, { width: 2 }]) {
      assert.equal(applyRibbonParagraphIndent(editor, target, attrs), false)
      assert.deepEqual(editor.getJSON(), before)
    }
    const first = editor.state.doc.firstChild
    editor.view.dispatch(editor.state.tr.replaceWith(0, first.nodeSize, first))
    assert.equal(target.valid, false)
    const replaced = editor.getJSON()
    assert.equal(applyRibbonParagraphIndent(editor, target, { leftIndent: 2 }), false)
    assert.deepEqual(editor.getJSON(), replaced)
    stop()
  } finally { editor.destroy() }
})

test("全选缩进不触碰代码块和表格结构，原节点选区不支持缩进弹层", () => {
  const editor = createEditor("<table><tr><td><p>cell</p></td></tr></table><pre><code>code</code></pre><p>end</p>")
  try {
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    const { target, stop } = track(editor)
    assert.equal(applyRibbonParagraphIndent(editor, target, { firstLineIndent: 2, leftIndent: 1 }), true)
    assert.equal(editor.getJSON().content[0].content[0].content[0].content[0].attrs.firstLineIndent, 2)
    assert.equal(editor.getJSON().content[1].attrs.firstLineIndent, undefined)
    assert.equal(editor.getJSON().content[2].attrs.leftIndent, 1)
    assert.ok(editor.state.selection instanceof AllSelection)
    assert.equal(editor.state.doc.firstChild.childCount, 1)
    stop()
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    assert.equal(captureRibbonIndentTarget(editor), null)
  } finally { editor.destroy() }
})
