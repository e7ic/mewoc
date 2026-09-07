import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { AllSelection, NodeSelection } from "@tiptap/pm/state"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { getIndentParagraphs } from "../src/pages/editor/extensions/paragraph-indent.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const createEditor = (content = "<p>第一段</p><p>第二段</p><p></p>") => new Editor({
  element: document.createElement("div"), extensions: createExtensions(), content
})

test("光标、跨段选区与下一段起点边界只改变应选段落，一次撤销恢复", () => {
  const editor = createEditor()
  let updates = 0
  editor.on("update", () => { updates += 1 })
  try {
    editor.commands.setTextSelection({ from: 1, to: 6 })
    assert.equal(getIndentParagraphs(editor.state).length, 1)
    assert.equal(editor.can().setParagraphIndent({ firstLineIndent: 2, leftIndent: 3 }), true)
    assert.equal(updates, 0)
    editor.commands.setParagraphIndent({ firstLineIndent: 2, leftIndent: 3 })
    assert.equal(updates, 1)
    assert.equal(editor.getJSON().content[0].attrs.firstLineIndent, 2)
    assert.equal(editor.getJSON().content[1].attrs.firstLineIndent, 0)
    editor.commands.setParagraphIndent({ firstLineIndent: 2, leftIndent: 3 })
    assert.equal(updates, 1)
    editor.commands.undo()
    assert.equal(editor.getJSON().content[0].attrs.leftIndent, 0)
    editor.commands.setTextSelection({ from: 1, to: 9 })
    editor.commands.setParagraphIndent({ leftIndent: 4 })
    assert.deepEqual(editor.getJSON().content.map(node => node.attrs.leftIndent), [4, 4, 0])
    editor.commands.setTextSelection(11)
    editor.commands.setParagraphIndent({ firstLineIndent: 2 })
    assert.equal(editor.getJSON().content[2].attrs.firstLineIndent, 2)
  } finally {
    editor.destroy()
  }
})

test("参数非法、只读、组合输入与节点选区均不写入", () => {
  const editor = createEditor()
  try {
    const before = editor.getJSON()
    for (const attrs of [null, [], {}, { leftIndent: "2" }, { leftIndent: 9 }, { leftIndent: -1 },
      { firstLineIndent: 0.5 }, { firstLineIndent: 5 }, { firstLineIndent: NaN }, { width: 2 }]) {
      assert.equal(editor.commands.setParagraphIndent(attrs), false)
    }
    editor.setEditable(false)
    assert.equal(editor.commands.setParagraphIndent({ leftIndent: 2 }), false)
    editor.setEditable(true)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionstart", { bubbles: true }))
    assert.equal(editor.commands.setParagraphIndent({ leftIndent: 2 }), false)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionend", { bubbles: true }))
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    assert.equal(editor.commands.setParagraphIndent({ leftIndent: 2 }), false)
    assert.deepEqual(editor.getJSON(), before)
  } finally {
    editor.destroy()
  }
})

test("段落切标题、Enter 分段继承缩进，列表层级命令仍可使用", () => {
  const editor = createEditor()
  try {
    editor.commands.setTextSelection(2)
    editor.commands.setParagraphIndent({ firstLineIndent: 2, leftIndent: 1 })
    editor.commands.setHeading({ level: 2 })
    assert.equal(editor.getJSON().content[0].attrs.leftIndent, 1)
    editor.commands.setParagraph()
    editor.commands.splitBlock()
    assert.deepEqual(editor.getJSON().content.slice(0, 2).map(node => node.attrs.firstLineIndent), [2, 2])
    editor.commands.toggleBulletList()
    assert.equal(editor.isActive("bulletList"), true)
    assert.equal(editor.commands.setParagraphIndent({ leftIndent: 3 }), true)
    assert.equal(editor.commands.liftListItem("listItem"), true)
    assert.equal(editor.isActive("bulletList"), false)
    assert.equal(editor.getAttributes("paragraph").leftIndent, 3)
  } finally {
    editor.destroy()
  }
})

test("表格内文字可缩进，全选不改代码块和结构", () => {
  const editor = createEditor("<table><tr><td><p>单元格</p></td></tr></table><pre><code>代码</code></pre><p></p>")
  try {
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    editor.commands.setParagraphIndent({ firstLineIndent: 2, leftIndent: 1 })
    const content = editor.getJSON().content
    assert.equal(content[0].content[0].content[0].content[0].attrs.firstLineIndent, 2)
    assert.equal(content[1].attrs.firstLineIndent, undefined)
    assert.deepEqual(content.map(node => node.type), ["table", "codeBlock", "paragraph"])
    assert.doesNotThrow(() => validateDocument({ ...createDocument(), content: editor.getJSON() }))
  } finally {
    editor.destroy()
  }
})

test("HTML 和清理后的内部粘贴保留缩进，非法 CSS 单位及越界值不带入", () => {
  const editor = createEditor()
  let pasted
  try {
    editor.commands.setParagraphIndent({ firstLineIndent: 2, leftIndent: 4 })
    const html = editor.getHTML()
    assert.match(html, /text-indent: 2em/)
    assert.match(html, /margin-left: 4em/)
    pasted = createEditor(cleanPastedHtml(html))
    assert.deepEqual(pasted.getJSON(), editor.getJSON())
    pasted.commands.setContent(cleanPastedHtml('<p style="text-indent: -2em; margin-left: 100em">一</p><p style="text-indent: 20px; margin-left: 50%">二</p>'))
    assert.equal(pasted.getJSON().content.every(node => node.attrs.firstLineIndent === 0 && node.attrs.leftIndent === 0), true)
  } finally {
    editor.destroy()
    pasted?.destroy()
  }
})

test("格式刷复制缩进，普通来源清除目标缩进", () => {
  const editor = createEditor()
  try {
    editor.commands.setParagraphIndent({ firstLineIndent: 2, leftIndent: 4 })
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 6, to: 9 })
    editor.commands.applyFormat()
    assert.equal(editor.getJSON().content[1].attrs.leftIndent, 4)
    editor.commands.setTextSelection(11)
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 6, to: 9 })
    editor.commands.applyFormat()
    assert.equal(editor.getJSON().content[1].attrs.firstLineIndent, 0)
    assert.equal(editor.getJSON().content[1].attrs.leftIndent, 0)
  } finally {
    editor.destroy()
  }
})

test("旧文件补默认属性，新文件往返保存缩进，非法 JSON 拒绝", async () => {
  const record = createDocument()
  const editor = createEditor(record.content)
  try {
    assert.equal(editor.getJSON().content[0].attrs.firstLineIndent, 0)
    editor.commands.setParagraphIndent({ firstLineIndent: 2, leftIndent: 4 })
    const content = editor.getJSON()
    const portable = await createPortableFile({ ...record, content }, new Map())
    const imported = await readPortableFile(new File([JSON.stringify(portable)], "indent.mewoc.json"))
    assert.deepEqual(imported.document.content, JSON.parse(JSON.stringify(content)))
    for (const value of [-1, 1.5, 9, "2", Infinity]) {
      const invalid = structuredClone(content)
      invalid.content[0].attrs.leftIndent = value
      assert.throws(() => validateDocument({ ...record, content: invalid }), /leftIndent 无效/)
    }
  } finally {
    editor.destroy()
  }
})
