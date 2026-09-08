import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { NodeSelection, AllSelection } from "@tiptap/pm/state"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { FORMAT_PAINTER_KEY } from "../src/pages/editor/extensions/format-painter.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const createEditor = () => new Editor({
  element: document.body.appendChild(document.createElement("div")), extensions: createExtensions(),
  content: { type: "doc", content: [
    { type: "paragraph", attrs: { textAlign: "center", lineHeight: 2 }, content: [{ type: "text", text: "来源", marks: [
      { type: "bold" }, { type: "textStyle", attrs: { color: "#6657d9", backgroundColor: "#ffffff", fontSize: "14pt", fontFamily: "Consolas, Menlo, monospace" } }
    ] }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "目标", marks: [
      { type: "italic" }, { type: "underline" }, { type: "strike" },
      { type: "link", attrs: { href: "https://example.com", target: "_blank", rel: "noopener noreferrer" } }
    ] }] },
    { type: "paragraph", content: [{ type: "text", text: "第三段" }] },
    { type: "codeBlock", content: [{ type: "text", text: "const a = 1" }] },
    { type: "paragraph" }
  ] }
})

test("格式刷只复制文字与段落样式，保留链接、标题级别和内容，JSON 可保存", () => {
  const editor = createEditor()
  try {
    const text = editor.getText()
    editor.commands.setTextSelection({ from: 1, to: 3 })
    assert.equal(editor.commands.copyFormat(), true)
    editor.commands.setTextSelection({ from: 5, to: 7 })
    const before = editor.getJSON()
    assert.equal(editor.can().applyFormat(), true)
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(editor.commands.applyFormat(), true)
    const result = editor.getJSON()
    assert.equal(editor.getText(), text)
    assert.equal(result.content[1].attrs.level, 2)
    assert.equal(result.content[1].attrs.lineHeight, 2)
    assert.equal(result.content[1].attrs.textAlign, "center")
    const marks = result.content[1].content[0].marks
    assert.deepEqual(marks.map(mark => mark.type).sort(), ["bold", "link", "textStyle"])
    assert.equal(marks.find(mark => mark.type === "link").attrs.href, "https://example.com")
    assert.deepEqual(marks.find(mark => mark.type === "textStyle"), result.content[0].content[0].marks.find(mark => mark.type === "textStyle"))
    assert.equal(FORMAT_PAINTER_KEY.getState(editor.state), null)
    assert.doesNotThrow(() => validateDocument({ ...createDocument(), content: result }))
  } finally {
    editor.destroy()
  }
})

test("格式应用独立于前后输入历史，一次撤销恢复全部样式", () => {
  const editor = createEditor()
  try {
    editor.commands.insertContentAt(12, "前")
    const before = editor.getJSON()
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 5, to: 7 })
    editor.commands.applyFormat()
    const formatted = editor.getJSON()
    editor.commands.insertContentAt(13, "后")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), formatted)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.undo()
    assert.equal(editor.getText().includes("前"), false)
    editor.commands.redo()
    editor.commands.redo()
    assert.deepEqual(editor.getJSON(), formatted)
    assert.equal(FORMAT_PAINTER_KEY.getState(editor.state), null)
  } finally {
    editor.destroy()
  }
})

test("重复应用相同格式不制造空撤销步骤，也不触发重复保存", () => {
  const editor = createEditor()
  let updates = 0
  editor.on("update", () => { updates += 1 })
  try {
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat(true)
    editor.commands.setTextSelection({ from: 5, to: 7 })
    const before = editor.getJSON()
    editor.commands.applyFormat()
    assert.equal(editor.can().undo(), true)
    assert.equal(updates, 1)
    editor.commands.applyFormat()
    assert.equal(updates, 1)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(editor.can().undo(), false)
  } finally {
    editor.destroy()
  }
})

test("连续模式跨目标保留，空光标、节点和代码选区不消耗，普通输入终止", () => {
  const editor = createEditor()
  try {
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat(true)
    editor.commands.setTextSelection(5)
    assert.equal(editor.commands.applyFormat(), false)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 4)))
    assert.equal(editor.commands.applyFormat(), false)
    editor.commands.setTextSelection({ from: 14, to: 18 })
    assert.equal(editor.commands.applyFormat(), false)
    assert.equal(FORMAT_PAINTER_KEY.getState(editor.state).locked, true)
    editor.commands.setTextSelection({ from: 5, to: 7 })
    editor.commands.applyFormat()
    editor.commands.setTextSelection({ from: 9, to: 12 })
    editor.commands.applyFormat()
    assert.equal(FORMAT_PAINTER_KEY.getState(editor.state).locked, true)
    assert.equal(editor.getJSON().content[2].attrs.lineHeight, 2)
    editor.commands.insertContent("输入")
    assert.equal(FORMAT_PAINTER_KEY.getState(editor.state), null)
  } finally {
    editor.destroy()
  }
})

test("普通来源清除目标样式，全选跳过代码，快照不进入新会话", () => {
  const editor = createEditor()
  const next = createEditor()
  try {
    editor.commands.setTextSelection(9)
    editor.commands.copyFormat(true)
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    assert.equal(editor.commands.applyFormat(), true)
    const result = editor.getJSON()
    assert.equal(result.content[0].content[0].marks, undefined)
    assert.equal(result.content[0].attrs.lineHeight, 1.75)
    assert.equal(result.content[0].attrs.textAlign, null)
    assert.equal(result.content[3].content[0].text, "const a = 1")
    assert.equal(FORMAT_PAINTER_KEY.getState(next.state), null)
    editor.commands.clearFormat()
    assert.equal(FORMAT_PAINTER_KEY.getState(editor.state), null)
  } finally {
    editor.destroy()
    next.destroy()
  }
})

test("Esc 和组合输入开始取消模式，只读拒绝复制和应用", () => {
  const editor = createEditor()
  try {
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat()
    editor.view.dom.dispatchEvent(new DOM.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    assert.equal(FORMAT_PAINTER_KEY.getState(editor.state), null)
    editor.commands.copyFormat()
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionstart", { bubbles: true }))
    assert.equal(FORMAT_PAINTER_KEY.getState(editor.state), null)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionend", { bubbles: true }))
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 5, to: 7 })
    editor.setEditable(false)
    const before = editor.getJSON()
    assert.equal(editor.commands.applyFormat(), false)
    assert.equal(editor.commands.copyFormat(), false)
    assert.deepEqual(editor.getJSON(), before)
  } finally {
    editor.destroy()
  }
})

test("选择结束在下一帧应用，失焦、文档编辑与卸载取消待执行动作", async () => {
  const editor = createEditor()
  try {
    editor.view.dom.focus()
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat(true)
    editor.commands.setTextSelection({ from: 5, to: 7 })
    const release = () => editor.view.dom.dispatchEvent(new DOM.window.MouseEvent("mouseup", { button: 0, bubbles: true }))
    release()
    assert.equal(editor.getJSON().content[1].attrs.lineHeight, null)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(editor.getJSON().content[1].attrs.lineHeight, 2)
    editor.commands.setTextSelection({ from: 9, to: 12 })
    release()
    editor.view.dom.blur()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(editor.getJSON().content[2].attrs.lineHeight, null)
    editor.view.dom.focus()
    release()
    editor.commands.insertContent("修改")
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(editor.getJSON().content[2].attrs.lineHeight, null)
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 9, to: 10 })
    release()
    const before = editor.getJSON()
    editor.destroy()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(editor.getJSON(), before)
  } finally {
    editor.destroy()
  }
})

test("Shift 扩选等到松键再应用，启用和取消不触发正文保存", async () => {
  const editor = createEditor()
  let updates = 0
  editor.on("update", () => { updates += 1 })
  try {
    editor.view.dom.focus()
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat()
    editor.commands.clearFormat()
    editor.commands.copyFormat()
    assert.equal(updates, 0)
    editor.commands.setTextSelection({ from: 5, to: 6 })
    editor.view.dom.dispatchEvent(new DOM.window.KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true, bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.notEqual(FORMAT_PAINTER_KEY.getState(editor.state), null)
    assert.equal(updates, 0)
    editor.commands.setTextSelection({ from: 5, to: 7 })
    editor.view.dom.dispatchEvent(new DOM.window.KeyboardEvent("keyup", { key: "Shift", bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(FORMAT_PAINTER_KEY.getState(editor.state), null)
    assert.equal(updates, 1)
    assert.equal(editor.getJSON().content[1].content[0].text, "目标")
  } finally {
    editor.destroy()
  }
})

test("跨列表和表格刷文字，保留图片与表格尺寸并跳过行内代码", () => {
  const editor = createEditor()
  try {
    editor.commands.insertContentAt(13, [
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [
        { type: "text", text: "列表" }, { type: "text", text: "code", marks: [{ type: "code" }] }
      ] }] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colwidth: [120] }, content: [
        { type: "paragraph", content: [{ type: "text", text: "单元格" }] }
      ] }] }] },
      { type: "image", attrs: { assetId: "image-test", width: 120, height: 80, alt: "插图" } }
    ])
    const before = editor.getJSON()
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat()
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    editor.commands.applyFormat()
    const result = editor.getJSON()
    const list = result.content.find(node => node.type === "bulletList")
    assert.equal(list.content[0].content[0].attrs.lineHeight, 2)
    assert.equal(list.content[0].content[0].content[0].marks.some(mark => mark.type === "bold"), true)
    assert.deepEqual(list.content[0].content[0].content[1], { type: "text", text: "code", marks: [{ type: "code" }] })
    const cell = result.content.find(node => node.type === "table").content[0].content[0]
    assert.deepEqual(cell.attrs.colwidth, [120])
    assert.equal(cell.content[0].attrs.lineHeight, 2)
    assert.equal(cell.content[0].content[0].marks.some(mark => mark.type === "bold"), true)
    assert.deepEqual(result.content.find(node => node.type === "image"), before.content.find(node => node.type === "image"))
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
  } finally {
    editor.destroy()
  }
})
