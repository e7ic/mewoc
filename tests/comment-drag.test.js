/** 通过编辑器 DOM 的 dragstart/drop 路径验证批注移动与复制：移动保留锚点，复制剥离引用。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createCommentClipboardHandlers } from "../src/pages/editor/tools/comment-clipboard.js"
import { addDocumentComment, getCommentEntries } from "../src/pages/editor/tools/document-comments.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"

// 使用 JSDOM 与合成事件覆盖原生处理链，不依赖真实屏幕坐标或系统拖放窗口。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// 来源正文带格式并可附批注；canEdit 参数注入切换/只读等提交条件。
const createEditor = (canEdit, annotated = true) => {
  const handlers = createCommentClipboardHandlers(canEdit)
  const editor = new Editor({
    element: document.createElement("div"), extensions: createExtensions(),
    content: "<p><strong>source</strong></p><p>target</p>", editorProps: handlers
  })
  editor.commands.setTextSelection({ from: 1, to: 7 })
  if (annotated) addDocumentComment(editor, editor.state.selection, "跟随原文字")
  return { editor, handlers }
}
// 用内存 Map 提供 DataTransfer 的文本读写接口，观察同一拖动传递的内容。
const transfer = () => {
  const data = new Map()
  return { files: [], clearData: () => data.clear(), setData: (kind, value) => data.set(kind, value), getData: kind => data.get(kind) || "" }
}
// 构造可取消的拖放事件，并同步各平台复制修饰键，覆盖最终复制状态判断。
const event = (type, dataTransfer, copy = false) => {
  const result = new window.Event(type, { bubbles: true, cancelable: true })
  Object.assign(result, { clientX: 0, clientY: 0, dataTransfer, ctrlKey: copy, altKey: copy, metaKey: false })
  return result
}
// 定位替身只固定目标坐标，dragging 切片仍由真实 ProseMirror 处理器生成。
const beginDrag = (editor, copy = false) => {
  const data = transfer()
  editor.view.posAtCoords = () => ({ pos: editor.state.selection.from, inside: -1 })
  editor.view.dom.dispatchEvent(event("dragstart", data, copy))
  assert.ok(editor.view.dragging)
  return data
}
// 在指定文档位置结束拖动，复制与移动均走编辑器自己的 drop 处理链。
const drop = (editor, data, position, copy = false) => {
  editor.view.posAtCoords = () => ({ pos: position, inside: -1 })
  editor.view.dom.dispatchEvent(event("drop", data, copy))
}
// 直接检查待传递 Slice 中是否存在批注 mark，避免仅凭最终文字推断引用状态。
const containsAnchor = slice => {
  let found = false
  slice.content.descendants(node => { if (node.marks.some(mark => mark.type.name === "commentAnchor")) found = true })
  return found
}
// 最终 JSON 必须继续满足文档协议，防止拖动留下孤立引用。
const validateEditor = editor => assert.doesNotThrow(() => validateDocument({ ...createDocument(), content: editor.getJSON() }))

test("真实原生 dragstart/drop 移动带批注文字，锚点随文字移动且撤销完整恢复", async () => {
  const { editor } = createEditor()
  try {
    const before = getCommentEntries(editor.state.doc)[0]
    const data = beginDrag(editor)
    assert.equal(containsAnchor(editor.view.dragging.slice), true)
    await Promise.resolve()
    drop(editor, data, 15)
    const after = getCommentEntries(editor.state.doc)[0]
    assert.equal(editor.state.doc.textContent, "targetsource")
    assert.equal(after.id, before.id)
    assert.equal(after.anchorText, "source")
    assert.equal(after.orphaned, false)
    assert.notDeepEqual(after.ranges, before.ranges)
    validateEditor(editor)
    editor.commands.undo()
    assert.equal(editor.state.doc.textContent, "sourcetarget")
    assert.deepEqual(getCommentEntries(editor.state.doc)[0].ranges, before.ranges)
  } finally { editor.destroy() }
})

test("原生拖动复制剥离新副本锚点，保留原批注和文字格式", async () => {
  const { editor } = createEditor()
  try {
    const before = getCommentEntries(editor.state.doc)[0]
    const data = beginDrag(editor, true)
    await Promise.resolve()
    drop(editor, data, 15, true)
    assert.equal(editor.state.doc.textContent, "sourcetargetsource")
    assert.equal(getCommentEntries(editor.state.doc).length, 1)
    assert.deepEqual(getCommentEntries(editor.state.doc)[0], before)
    const copied = editor.state.doc.lastChild.lastChild
    assert.equal(copied.text, "source")
    assert.deepEqual(copied.marks.map(mark => mark.type.name), ["bold"])
    validateEditor(editor)
    editor.commands.undo()
    assert.equal(editor.state.doc.textContent, "sourcetarget")
    assert.deepEqual(getCommentEntries(editor.state.doc)[0], before)
  } finally { editor.destroy() }
})

// 开始与结束的修饰键可不同，锚点策略必须按真正提交时的状态选择。
test("最终复制状态决定锚点处理，修饰键可在拖动途中改变", async () => {
  for (const [startCopy, endCopy] of [[false, true], [true, false]]) {
    const { editor } = createEditor()
    try {
      const before = getCommentEntries(editor.state.doc)[0]
      const data = beginDrag(editor, startCopy)
      await Promise.resolve()
      drop(editor, data, 15, endCopy)
      const after = getCommentEntries(editor.state.doc)[0]
      assert.equal(after.orphaned, false)
      assert.equal(after.anchorText, "source")
      if (endCopy) {
        assert.equal(editor.state.doc.textContent, "sourcetargetsource")
        assert.deepEqual(after.ranges, before.ranges)
      } else {
        assert.equal(editor.state.doc.textContent, "targetsource")
        assert.notDeepEqual(after.ranges, before.ranges)
      }
      validateEditor(editor)
    } finally { editor.destroy() }
  }
})

test("普通复制和粘贴仍剥离锚点，拖动状态不会污染后续剪贴板操作", async () => {
  const { editor, handlers } = createEditor()
  try {
    const slice = editor.state.selection.content()
    assert.equal(containsAnchor(handlers.transformCopied(slice, editor.view)), false)
    assert.equal(containsAnchor(handlers.transformPasted(slice, editor.view)), false)
    beginDrag(editor)
    await Promise.resolve()
    assert.equal(containsAnchor(handlers.transformCopied(slice, editor.view)), false)
    // 即使系统尚未清掉 dragging，普通 paste 不处于本次同步 drop 处理期。
    assert.equal(containsAnchor(handlers.transformPasted(slice, editor.view)), false)
    assert.equal(getCommentEntries(editor.state.doc)[0].anchorText, "source")
  } finally { editor.destroy() }
})

test("跨编辑器外部 HTML 拖入只复制正文和格式，不复用来源批注", async () => {
  const source = createEditor().editor
  const target = createEditor(undefined, false).editor
  try {
    const data = beginDrag(source)
    await Promise.resolve()
    drop(target, data, 15)
    assert.equal(target.state.doc.textContent, "sourcetargetsource")
    assert.deepEqual(getCommentEntries(target.state.doc), [])
    assert.equal(target.state.doc.lastChild.lastChild.marks.some(mark => mark.type.name === "bold"), true)
    assert.equal(getCommentEntries(source.state.doc)[0].anchorText, "source")
    validateEditor(source)
    validateEditor(target)
  } finally { source.destroy(); target.destroy() }
})

test("含批注段落的节点拖动复制使用原生节点选区，其余无批注拖动不受影响", async () => {
  const { editor } = createEditor()
  const ordinary = createEditor(undefined, false).editor
  try {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    const data = beginDrag(editor, true)
    await Promise.resolve()
    drop(editor, data, editor.state.doc.content.size, true)
    assert.equal(editor.state.doc.childCount, 3)
    assert.equal(editor.state.selection instanceof NodeSelection, true)
    assert.equal(editor.state.doc.lastChild.textContent, "source")
    assert.equal(editor.state.doc.lastChild.firstChild.marks.some(mark => mark.type.name === "commentAnchor"), false)
    assert.equal(getCommentEntries(editor.state.doc)[0].anchorText, "source")
    const plainData = beginDrag(ordinary)
    await Promise.resolve()
    drop(ordinary, plainData, 15)
    assert.equal(ordinary.state.doc.textContent, "targetsource")
    validateEditor(editor)
    validateEditor(ordinary)
  } finally { editor.destroy(); ordinary.destroy() }
})

test("只读、切换和输入法组合期间不允许带批注的拖动写入", async () => {
  for (const mode of ["readonly", "switching", "composing"]) {
    let allowed = true
    const { editor } = createEditor(view => allowed && view.editable && !view.composing)
    try {
      const before = editor.getJSON()
      const data = beginDrag(editor)
      await Promise.resolve()
      if (mode === "readonly") editor.setEditable(false)
      if (mode === "switching") allowed = false
      if (mode === "composing") editor.view.input.composing = true
      drop(editor, data, 15)
      assert.deepEqual(editor.getJSON(), before)
      editor.view.input.composing = false
    } finally { editor.destroy() }
  }
})
