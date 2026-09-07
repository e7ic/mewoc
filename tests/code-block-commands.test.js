import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { getCodeBlockTarget, insertCodeBlock, setCodeBlockLanguage, exitCodeBlock, indentCodeBlock, insertCodeNewline } from "../src/pages/editor/tools/code-block-commands.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const createEditor = content => new Editor({
  element: document.createElement("div"), extensions: [StarterKit.configure({ trailingNode: false }), TableKit], content
})
const codeDocument = text => ({ type: "doc", content: [{
  type: "codeBlock", attrs: { language: "plaintext" }, content: text ? [{ type: "text", text }] : []
}] })
const selectText = (editor, anchor, head = anchor) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)))
const selectNode = (editor, pos) => editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))

test("代码目标支持单块正反选区和节点选区，排除跨块及其他节点", () => {
  const editor = createEditor("<pre><code>abc</code></pre><p>after</p>")
  try {
    selectText(editor, 4, 2)
    assert.equal(getCodeBlockTarget(editor.state.selection).pos, 0)
    selectNode(editor, 0)
    assert.equal(getCodeBlockTarget(editor.state.selection).node.textContent, "abc")
    selectText(editor, 2, 7)
    assert.equal(getCodeBlockTarget(editor.state.selection), null)
    selectNode(editor, 5)
    assert.equal(getCodeBlockTarget(editor.state.selection), null)
  } finally {
    editor.destroy()
  }
})

test("转换整段保留源码并移除文字标记，拒绝含非文本节点或跨段选区", () => {
  const editor = createEditor("<h2><strong>const a = 1</strong></h2><p>a<br>b</p><p>last</p>")
  try {
    selectText(editor, 3)
    assert.equal(insertCodeBlock(editor), true)
    assert.equal(editor.state.doc.firstChild.type.name, "codeBlock")
    assert.equal(editor.state.doc.firstChild.attrs.language, "plaintext")
    assert.equal(editor.state.doc.firstChild.textContent, "const a = 1")
    assert.equal(editor.state.doc.firstChild.firstChild.marks.length, 0)
    assert.equal(editor.state.selection.from, 3)
    editor.commands.undo()
    assert.equal(editor.state.doc.firstChild.type.name, "heading")
    assert.equal(editor.state.doc.firstChild.firstChild.marks[0].type.name, "bold")
    const second = editor.state.doc.firstChild.nodeSize + 1
    selectText(editor, second)
    assert.equal(insertCodeBlock(editor), false)
    selectText(editor, 2, second)
    assert.equal(insertCodeBlock(editor), false)
    selectNode(editor, 0)
    assert.equal(insertCodeBlock(editor), false)
    editor.commands.setContent("<p></p>")
    selectText(editor, 1)
    assert.equal(insertCodeBlock(editor), true)
    assert.equal(editor.state.doc.firstChild.textContent, "")
  } finally {
    editor.destroy()
  }
})

test("语言修改支持节点选区，同值不更新，历史与后续输入隔开", () => {
  const editor = createEditor(codeDocument("a"))
  let updates = 0
  editor.on("update", () => { updates += 1 })
  try {
    selectNode(editor, 0)
    assert.equal(setCodeBlockLanguage(editor, "plaintext"), true)
    assert.equal(updates, 0)
    assert.equal(setCodeBlockLanguage(editor, "javascript"), true)
    assert.equal(updates, 1)
    selectText(editor, 2)
    editor.commands.insertContent("b")
    editor.commands.undo()
    assert.equal(editor.state.doc.firstChild.textContent, "a")
    assert.equal(editor.state.doc.firstChild.attrs.language, "javascript")
    editor.commands.undo()
    assert.equal(editor.state.doc.firstChild.attrs.language, "plaintext")
    assert.equal(setCodeBlockLanguage(editor, "unknown"), false)
    const stale = editor.state.selection
    editor.commands.insertContent("c")
    assert.equal(setCodeBlockLanguage(editor, "python", stale), false)
  } finally {
    editor.destroy()
  }
})

test("Tab 在光标插入两空格，缩进历史与前后输入独立", () => {
  const editor = createEditor(codeDocument("ab"))
  try {
    selectText(editor, 2)
    editor.commands.insertContent("x")
    assert.equal(indentCodeBlock(editor), true)
    assert.equal(editor.state.doc.firstChild.textContent, "ax  b")
    assert.equal(editor.state.selection.from, 5)
    editor.commands.insertContent("y")
    editor.commands.undo()
    assert.equal(editor.state.doc.firstChild.textContent, "ax  b")
    editor.commands.undo()
    assert.equal(editor.state.doc.firstChild.textContent, "axb")
    editor.commands.undo()
    assert.equal(editor.state.doc.firstChild.textContent, "ab")
  } finally {
    editor.destroy()
  }
})

test("多行缩进按整行处理，下一行起点不扩选，正反向选区保持", () => {
  for (const backward of [false, true]) {
    const editor = createEditor(codeDocument("one\ntwo\nthree"))
    try {
      selectText(editor, backward ? 9 : 2, backward ? 2 : 9)
      assert.equal(indentCodeBlock(editor), true)
      assert.equal(editor.state.doc.firstChild.textContent, "  one\n  two\nthree")
      assert.equal(editor.state.selection.anchor, backward ? 13 : 4)
      assert.equal(editor.state.selection.head, backward ? 4 : 13)
      assert.equal(indentCodeBlock(editor, true), true)
      assert.equal(editor.state.doc.firstChild.textContent, "one\ntwo\nthree")
      assert.equal(editor.state.selection.anchor, backward ? 9 : 2)
      assert.equal(editor.state.selection.head, backward ? 2 : 9)
      editor.commands.undo()
      assert.equal(editor.state.doc.firstChild.textContent, "  one\n  two\nthree")
    } finally {
      editor.destroy()
    }
  }
})

test("Shift-Tab 安全处理纯空白、Tab、无缩进及光标位于前导空白", () => {
  const editor = createEditor(codeDocument("  "))
  try {
    selectText(editor, 1, 3)
    assert.equal(indentCodeBlock(editor, true), true)
    assert.equal(editor.state.doc.firstChild.textContent, "")
    assert.equal(editor.state.selection.from, 1)
    editor.commands.setContent(codeDocument("\tfoo\n    bar"))
    selectText(editor, 1, editor.state.doc.firstChild.nodeSize - 1)
    indentCodeBlock(editor, true)
    assert.equal(editor.state.doc.firstChild.textContent, "foo\n  bar")
    editor.commands.setContent(codeDocument("    foo"))
    selectText(editor, 2)
    indentCodeBlock(editor, true)
    assert.equal(editor.state.doc.firstChild.textContent, "  foo")
    assert.equal(editor.state.selection.from, 1)
    editor.commands.setContent(codeDocument("foo"))
    let updates = 0
    editor.on("update", () => { updates += 1 })
    selectText(editor, 2)
    assert.equal(indentCodeBlock(editor, true), true)
    assert.equal(updates, 0)
  } finally {
    editor.destroy()
  }
})

test("跨块 Tab 不吞并正文，节点选区不执行缩进或换行", () => {
  const editor = createEditor("<pre><code>a\nb</code></pre><p>after</p>")
  try {
    const content = editor.getJSON()
    selectText(editor, 2, 8)
    assert.equal(indentCodeBlock(editor), false)
    assert.equal(indentCodeBlock(editor, true), false)
    assert.equal(insertCodeNewline(editor), false)
    assert.deepEqual(editor.getJSON(), content)
    selectNode(editor, 0)
    assert.equal(indentCodeBlock(editor), false)
    assert.equal(insertCodeNewline(editor), false)
  } finally {
    editor.destroy()
  }
})

test("换行继承已有缩进并替换选区，行首与空代码块保持安全", () => {
  const editor = createEditor(codeDocument(" \tvalue\nnext"))
  try {
    selectText(editor, 8)
    assert.equal(insertCodeNewline(editor), true)
    assert.equal(editor.state.doc.firstChild.textContent, " \tvalue\n \t\nnext")
    editor.commands.undo()
    selectText(editor, 8, 3)
    insertCodeNewline(editor)
    assert.equal(editor.state.doc.firstChild.textContent, " \t\n \t\nnext")
    editor.commands.setContent(codeDocument("  value"))
    selectText(editor, 1)
    insertCodeNewline(editor)
    assert.equal(editor.state.doc.firstChild.textContent, "\n  value")
    editor.commands.setContent(codeDocument(""))
    selectText(editor, 1)
    insertCodeNewline(editor)
    assert.equal(editor.state.doc.firstChild.textContent, "\n")
  } finally {
    editor.destroy()
  }
})

test("退出保留源码，进入既有正文或新建正文，并支持表格内代码块", () => {
  const editor = createEditor("<pre><code>a\n\n</code></pre><p>after</p>")
  try {
    const content = editor.getJSON()
    selectNode(editor, 0)
    assert.equal(exitCodeBlock(editor), true)
    assert.equal(editor.state.selection.$from.parent.textContent, "after")
    assert.deepEqual(editor.getJSON(), content)
    editor.commands.setContent(codeDocument("a\n\n"))
    selectNode(editor, 0)
    assert.equal(exitCodeBlock(editor), true)
    assert.equal(editor.state.doc.childCount, 2)
    assert.equal(editor.state.doc.firstChild.textContent, "a\n\n")
    editor.commands.undo()
    assert.equal(editor.state.doc.childCount, 1)
    editor.commands.setContent("<table><tbody><tr><td><pre><code>x</code></pre></td></tr></tbody></table>")
    let pos = 0
    editor.state.doc.descendants((node, position) => { if (node.type.name === "codeBlock") pos = position })
    selectNode(editor, pos)
    assert.equal(setCodeBlockLanguage(editor, "json"), true)
    selectText(editor, pos + 2)
    assert.equal(indentCodeBlock(editor), true)
    assert.equal(insertCodeNewline(editor), true)
    assert.equal(editor.state.doc.nodeAt(pos).textContent, "x  \n")
    selectNode(editor, pos)
    assert.equal(exitCodeBlock(editor), true)
    assert.equal(editor.state.selection.$from.parent.type.name, "paragraph")
    assert.equal(editor.state.selection.$from.node(-1).type.name, "tableCell")
    editor.state.doc.check()
  } finally {
    editor.destroy()
  }
})

test("只读、组合输入与销毁状态拒绝所有代码写操作", () => {
  const editor = createEditor(codeDocument("a"))
  const operations = [insertCodeBlock, exitCodeBlock, indentCodeBlock, insertCodeNewline,
    current => setCodeBlockLanguage(current, "python")]
  try {
    selectText(editor, 2)
    const content = editor.getJSON()
    editor.setEditable(false)
    operations.forEach(operation => assert.equal(operation(editor), false))
    assert.deepEqual(editor.getJSON(), content)
    editor.setEditable(true)
    editor.view.input.composing = true
    operations.forEach(operation => assert.equal(operation(editor), false))
    assert.deepEqual(editor.getJSON(), content)
    editor.view.input.composing = false
    editor.destroy()
    operations.forEach(operation => assert.equal(operation(editor), false))
  } finally {
    if (!editor.isDestroyed) editor.destroy()
  }
})
