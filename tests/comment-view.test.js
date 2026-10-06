/** 批注 UI 的 selector 必须能被 Tiptap 默认深比较安全消费，并跟随锚点和选区的语义变化。 */
import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { DocumentComments, CommentAnchor } from "../src/pages/editor/extensions/document-comments.js"
import { Superscript, Subscript } from "../src/pages/editor/extensions/text-scripts.js"
import { addDocumentComment, getCommentSelectionError } from "../src/pages/editor/tools/document-comments.js"
import { selectCommentViewState } from "../src/pages/editor/tools/comment-view.js"

// 使用 useEditorState 实际依赖的比较器，不用宽松的 JSON 字符串比较掩盖运行时循环引用。
const { deepEqual } = createRequire(createRequire(import.meta.url).resolve("@tiptap/react"))("fast-equals")
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const createEditor = () => new Editor({
  element: document.createElement("div"), extensions: [StarterKit, DocumentComments, CommentAnchor, Superscript, Subscript],
  content: "<p>H2O 和 x2</p>"
})
const read = editor => selectCommentViewState({ editor })

test("批注投影在上下标互换时保持可序列化，默认深比较不进入 schema 循环引用", () => {
  const editor = createEditor()
  try {
    editor.commands.setTextSelection({ from: 2, to: 3 })
    editor.commands.setSubscript()
    let previous = read(editor)
    for (let index = 0; index < 12; index += 1) {
      editor.commands[index % 2 ? "setSubscript" : "setSuperscript"]()
      const next = read(editor)
      assert.equal(deepEqual(previous, next), false)
      assert.deepEqual(JSON.parse(JSON.stringify(next)), next)
      assert.deepEqual(next.selection, { from: 2, to: 3, empty: false, type: "text" })
      assert.equal(getCommentSelectionError(editor), "")
      assert.equal(Object.hasOwn(next, "doc"), false)
      previous = next
    }
  } finally { editor.destroy() }
})

test("批注投影复用同正文的 entries，选择移动、线程新增、引用编辑与只读状态仍正确更新", () => {
  const editor = createEditor()
  try {
    editor.commands.setTextSelection({ from: 2, to: 3 })
    const initial = read(editor)
    const id = addDocumentComment(editor, editor.state.selection, "这里是下标")
    assert.ok(id)
    const added = read(editor)
    assert.equal(deepEqual(initial, added), false)
    assert.equal(added.entries[0].id, id)
    assert.equal(added.entries[0].anchorText, "2")
    assert.match(getCommentSelectionError(editor), /已有批注/)
    assert.equal(read(editor).entries, added.entries)
    editor.commands.setTextSelection({ from: 5, to: 6 })
    const moved = read(editor)
    assert.equal(moved.entries, added.entries)
    assert.equal(getCommentSelectionError(editor), "")
    assert.equal(deepEqual(added, moved), false)
    editor.commands.insertContentAt(1, "前")
    const changed = read(editor)
    assert.notEqual(changed.entries, moved.entries)
    assert.deepEqual(changed.entries[0].ranges, [{ from: 3, to: 4 }])
    editor.setEditable(false, false)
    assert.match(getCommentSelectionError(editor), /只读/)
    editor.setEditable(true, false)
    editor.commands.setTextSelection({ from: 6, to: 7 })
    assert.equal(getCommentSelectionError(editor), "")
  } finally { editor.destroy() }
})
