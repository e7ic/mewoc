/** 原生 dragstart/drop 导航回归：复制重映射整个 Slice，移动保留身份，提交守卫实时生效。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { Fragment, Slice } from "@tiptap/pm/model"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createCommentClipboardHandlers } from "../src/pages/editor/tools/comment-clipboard.js"
import { hasNavigationSliceFeatures, remapNavigationSlice } from "../src/pages/editor/tools/navigation-clipboard.js"
import { collectNavigationTargets, isNavigationId } from "../src/pages/editor/tools/document-navigation.js"
import { addDocumentComment, getCommentEntries } from "../src/pages/editor/tools/document-comments.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"

// 坐标使用替身；切片序列化、修饰键判定、插入事务和附加目录维护仍由真实 ProseMirror 执行。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "Element", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const ID1 = "nav-11111111-1111-4111-8111-111111111111"
const ID2 = "nav-22222222-2222-4222-8222-222222222222"
const ID3 = "nav-33333333-3333-4333-8333-333333333333"
const OUTSIDE_ID = "nav-44444444-4444-4444-8444-444444444444"
const text = (value, marks) => ({ type: "text", text: value, ...(marks && { marks }) })
const paragraph = (value, attrs = {}) => ({ type: "paragraph", attrs, content: typeof value === "string" ? [text(value)] : value })
const link = (value, id) => text(value, [{ type: "link", attrs: { href: `#${id}`, target: "_self" } }, { type: "bold" }])
const heading = (value, level, id, name = null) => ({ type: "heading", attrs: { level, navigationId: id, bookmarkName: name }, content: [text(value, [{ type: "bold" }])] })
const fixture = () => ({ type: "doc", content: [
  paragraph("组前文字"),
  { type: "tableOfContents", attrs: { title: "拖动目录", maxLevel: 3, entries: [{ id: ID1, level: 1, text: "章节正文" }, { id: ID3, level: 2, text: "内部标题" }] } },
  heading("章节正文", 1, ID1, "章节书签"),
  paragraph("命名段落", { navigationId: ID2, bookmarkName: "段落书签" }),
  paragraph([link("跳往章节", ID1), text("／"), link("跳往段落", ID2), text("／"), link("切片外目标", OUTSIDE_ID)]),
  { type: "details", attrs: { summary: "折叠部分" }, content: [
    { type: "textBox", content: [heading("内部标题", 2, ID3, "内部书签"), paragraph([link("跳往内部", ID3)])] }
  ] },
  paragraph("组后文字"),
  paragraph("外部原目标", { navigationId: OUTSIDE_ID, bookmarkName: "外部书签" }),
  paragraph("目标文字")
] })
const makeEditor = canEdit => new Editor({
  element: document.createElement("div"), extensions: createExtensions(), content: fixture(),
  editorProps: createCommentClipboardHandlers(canEdit, {
    hasLocalCopyFeatures: hasNavigationSliceFeatures,
    prepareLocalCopy: (slice, view) => remapNavigationSlice(slice, view.state.doc.toJSON())
  })
})
const nodes = (editor, type) => {
  const found = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === type) found.push({ node, pos }) })
  return found
}
const block = (editor, value) => {
  let found
  editor.state.doc.descendants((node, pos) => { if (node.isTextblock && node.textContent === value && !found) found = { node, pos } })
  assert.ok(found, `缺少正文块：${value}`)
  return found
}
const selectNode = (editor, value) => editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, block(editor, value).pos)))
const selectGroup = editor => {
  const end = block(editor, "组后文字")
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, end.pos + 1 + end.node.textContent.length)))
}
const transfer = () => {
  const data = new Map()
  return { files: [], clearData: () => data.clear(), setData: (kind, value) => data.set(kind, value), getData: kind => data.get(kind) || "" }
}
const dragEvent = (type, dataTransfer, copy = false) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: 0, clientY: 0, dataTransfer, ctrlKey: copy, altKey: copy, metaKey: false })
  return event
}
const beginDrag = (editor, copy = false) => {
  const data = transfer()
  editor.view.posAtCoords = () => ({ pos: editor.state.selection.from, inside: -1 })
  editor.view.dom.dispatchEvent(dragEvent("dragstart", data, copy))
  assert.ok(editor.view.dragging)
  return data
}
const drop = (editor, data, pos = editor.state.doc.content.size, copy = false) => {
  editor.view.posAtCoords = () => ({ pos, inside: -1 })
  const event = dragEvent("drop", data, copy)
  editor.view.dom.dispatchEvent(event)
  return event
}
const hrefs = node => {
  const found = []
  node.descendants(child => { for (const mark of child.marks) if (mark.type.name === "link") found.push(mark.attrs.href) })
  return found
}
const validateEditor = editor => validateDocument({ ...createDocument(), content: editor.getJSON() })

test("真实 DOM 拖动复制目录和容器内目标，副本链接跟随副本，切片外链接与原目标不变", async () => {
  const editor = makeEditor()
  try {
    selectGroup(editor)
    const before = editor.getJSON()
    const data = beginDrag(editor, true)
    const sourceSlice = editor.view.dragging.slice
    const serialized = sourceSlice.toJSON()
    const prepared = remapNavigationSlice(sourceSlice, editor.getJSON())
    assert.deepEqual(sourceSlice.toJSON(), serialized)
    assert.equal(prepared.openStart, sourceSlice.openStart)
    assert.equal(prepared.openEnd, sourceSlice.openEnd)
    let copiedToc
    prepared.content.descendants(node => { if (node.type.name === "tableOfContents") copiedToc = node })
    assert.ok(copiedToc.attrs.entries.every(entry => ![ID1, ID3].includes(entry.id)))
    assert.ok(hrefs(prepared.content).includes(`#${OUTSIDE_ID}`))
    await Promise.resolve()
    assert.equal(drop(editor, data, undefined, true).defaultPrevented, true)
    const targets = collectNavigationTargets(editor.getJSON())
    const copied = ["章节书签", "段落书签", "内部书签"].map(name => targets.find(target => target.type === "bookmark" && target.name === `${name}（副本 1）`))
    assert.equal(copied.every(target => target && isNavigationId(target.id)), true)
    assert.equal(new Set(copied.map(target => target.id)).size, 3)
    assert.equal(copied.some(target => [ID1, ID2, ID3, OUTSIDE_ID].includes(target.id)), false)
    for (const [name, id] of [["章节书签", ID1], ["段落书签", ID2], ["内部书签", ID3], ["外部书签", OUTSIDE_ID]]) {
      assert.equal(targets.find(target => target.type === "bookmark" && target.name === name).id, id)
    }
    const links = hrefs(editor.state.doc)
    copied.forEach(target => assert.ok(links.includes(`#${target.id}`)))
    assert.equal(links.filter(href => href === `#${OUTSIDE_ID}`).length, 2)
    assert.equal(nodes(editor, "tableOfContents").length, 2)
    for (const { node } of nodes(editor, "tableOfContents")) assert.ok(node.attrs.entries.some(entry => entry.id === copied[0].id))
    assert.equal(nodes(editor, "details").length, 2)
    assert.equal(nodes(editor, "textBox").length, 2)
    validateEditor(editor)
    const after = editor.getJSON()
    assert.equal(editor.commands.undo(), true)
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(editor.commands.redo(), true)
    assert.deepEqual(editor.getJSON(), after)
  } finally { editor.destroy() }
})

test("原生节点复制保留文字格式和节点选区，多次副本书签名称不冲突", async () => {
  const editor = makeEditor()
  try {
    for (let index = 1; index <= 2; index += 1) {
      selectNode(editor, "章节正文")
      const data = beginDrag(editor, true)
      await Promise.resolve()
      drop(editor, data, undefined, true)
      assert.equal(editor.state.selection instanceof NodeSelection, true)
      assert.equal(editor.state.selection.node.attrs.bookmarkName, `章节书签（副本 ${index}）`)
      assert.equal(editor.state.selection.node.firstChild.marks.some(mark => mark.type.name === "bold"), true)
    }
    const names = collectNavigationTargets(editor.getJSON()).filter(target => target.type === "bookmark").map(target => target.name)
    assert.equal(new Set(names).size, names.length)
    validateEditor(editor)
  } finally { editor.destroy() }
})

test("只复制内部链接文字时仍指向原目标，部分标题切片不把宿主段落变成新书签", async () => {
  const editor = makeEditor()
  try {
    const links = block(editor, "跳往章节／跳往段落／切片外目标")
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, links.pos + 1, links.pos + 5)))
    const data = beginDrag(editor, true)
    await Promise.resolve()
    drop(editor, data, undefined, true)
    assert.equal(hrefs(editor.state.doc).filter(href => href === `#${ID1}`).length, 2)
    assert.equal(collectNavigationTargets(editor.getJSON()).filter(target => target.type === "bookmark").length, 4)
    const source = block(editor, "章节正文")
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, source.pos + 2, source.pos + 4)))
    const partial = beginDrag(editor, true)
    const originalSlice = editor.view.dragging.slice
    const prepared = remapNavigationSlice(originalSlice, editor.getJSON())
    assert.equal(prepared.openStart, 1)
    assert.equal(prepared.openEnd, 1)
    assert.equal(prepared.content.textBetween(0, prepared.content.size), "节正")
    await Promise.resolve()
    const target = block(editor, "目标文字")
    drop(editor, partial, target.pos + 3, true)
    const host = block(editor, "目标节正文字")
    assert.equal(host.node.attrs.bookmarkName, null)
    assert.equal(host.node.attrs.navigationId, null)
    assert.equal(collectNavigationTargets(editor.getJSON()).filter(target => target.type === "bookmark").length, 4)
    validateEditor(editor)
  } finally { editor.destroy() }
})

test("复制与移动按 drop 时修饰键决定，移动保留导航 ID、名称及原链接并可撤销", async () => {
  for (const [startCopy, endCopy] of [[false, true], [true, false]]) {
    const editor = makeEditor()
    try {
      selectNode(editor, "章节正文")
      const before = editor.getJSON()
      const data = beginDrag(editor, startCopy)
      await Promise.resolve()
      drop(editor, data, undefined, endCopy)
      const headings = nodes(editor, "heading").filter(({ node }) => node.textContent === "章节正文")
      assert.equal(headings.length, endCopy ? 2 : 1)
      assert.equal(headings.find(({ node }) => node.attrs.navigationId === ID1).node.attrs.bookmarkName, "章节书签")
      if (endCopy) assert.equal(headings.some(({ node }) => node.attrs.bookmarkName === "章节书签（副本 1）"), true)
      else assert.ok(headings[0].pos > block(editor, "目标文字").pos)
      assert.ok(hrefs(editor.state.doc).includes(`#${ID1}`))
      validateEditor(editor)
      assert.equal(editor.commands.undo(), true)
      assert.deepEqual(editor.getJSON(), before)
    } finally { editor.destroy() }
  }
})

test("同一不可变 Node 在切片中复用时副本身份逐出现分配，歧义链接去 mark 且保留原文字及格式", () => {
  const editor = makeEditor()
  try {
    const shared = block(editor, "章节正文").node
    const linkNode = editor.schema.nodes.paragraph.create({}, editor.schema.text("歧义链接原文", [
      editor.schema.marks.link.create({ href: `#${ID1}`, target: "_self" }), editor.schema.marks.bold.create()
    ]))
    const directory = nodes(editor, "tableOfContents")[0].node
    const source = new Slice(Fragment.fromArray([directory, shared, shared, linkNode]), 0, 0)
    assert.equal(source.content.child(1), source.content.child(2))
    const before = source.toJSON()
    const copied = remapNavigationSlice(source, editor.getJSON())
    const first = copied.content.child(1)
    const second = copied.content.child(2)
    assert.notEqual(first.attrs.navigationId, second.attrs.navigationId)
    assert.notEqual(first.attrs.navigationId, ID1)
    assert.notEqual(second.attrs.navigationId, ID1)
    assert.equal(first.attrs.bookmarkName, "章节书签（副本 1）")
    assert.equal(second.attrs.bookmarkName, "章节书签（副本 2）")
    assert.equal(copied.content.child(3).textContent, "歧义链接原文")
    assert.deepEqual(copied.content.child(3).firstChild.marks.map(mark => mark.type.name), ["bold"])
    assert.equal(copied.content.child(0).attrs.entries.some(entry => entry.id === ID1), false)
    assert.ok(copied.content.child(0).attrs.entries.some(entry => entry.id === ID3))
    assert.deepEqual(source.toJSON(), before)
  } finally { editor.destroy() }
})

test("导航与批注共存时复制重映射书签并去除副本批注，原线程和原定位不变", async () => {
  const editor = makeEditor()
  try {
    const source = block(editor, "章节正文")
    editor.commands.setTextSelection({ from: source.pos + 1, to: source.pos + 5 })
    addDocumentComment(editor, editor.state.selection, "原章节批注")
    const before = getCommentEntries(editor.state.doc)
    selectNode(editor, "章节正文")
    const data = beginDrag(editor, true)
    await Promise.resolve()
    drop(editor, data, undefined, true)
    assert.deepEqual(getCommentEntries(editor.state.doc), before)
    const copied = editor.state.selection.node
    assert.equal(copied.attrs.bookmarkName, "章节书签（副本 1）")
    assert.equal(copied.firstChild.marks.some(mark => mark.type.name === "commentAnchor"), false)
    assert.equal(copied.firstChild.marks.some(mark => mark.type.name === "bold"), true)
    validateEditor(editor)
  } finally { editor.destroy() }
})

test("只读、切换和输入法组合守卫阻止含导航的复制或移动，不改变正文、ID及目录", async () => {
  for (const mode of ["readonly", "switching", "composing"]) for (const copy of [false, true]) {
    let allowed = true
    const editor = makeEditor(view => allowed && view.editable && !view.composing)
    try {
      selectNode(editor, "章节正文")
      const before = editor.getJSON()
      const data = beginDrag(editor, copy)
      await Promise.resolve()
      if (mode === "readonly") editor.setEditable(false, false)
      if (mode === "switching") allowed = false
      if (mode === "composing") editor.view.input.composing = true
      drop(editor, data, undefined, copy)
      assert.deepEqual(editor.getJSON(), before, `${mode}/${copy ? "copy" : "move"}`)
      editor.view.input.composing = false
    } finally { editor.destroy() }
  }
})
