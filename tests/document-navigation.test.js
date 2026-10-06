/** 验证导航 JSON 契约、稳定身份、同事务目录维护和内部链接的实际编辑行为。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor, getSchema } from "@tiptap/core"
import { Node as ModelNode } from "@tiptap/pm/model"
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, isSafeLink, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { collectNavigationTargets, getTableOfContentsEntries, isInternalNavigationHref, isNavigationId, isSafeDocumentLink, prepareNavigationContent,
  validateNavigationBlockAttrs, validateTableOfContentsAttrs } from "../src/pages/editor/tools/document-navigation.js"
import { applyInternalNavigationLink, applyTableOfContentsSettings, captureNavigationBlockTarget, captureNavigationInsertTarget, captureNavigationLinkTarget,
  captureTableOfContentsTarget, ensureHeadingTarget, getNavigationLinkSelection, insertTableOfContentsAtTarget, listNavigationTargets, mapNavigationBlockTarget,
  mapNavigationInsertTarget, mapNavigationLinkTarget, mapTableOfContentsTarget, navigateToTarget, readNavigationBlockTarget, readTableOfContentsSettings,
  removeBookmarkName, removeTableOfContents, setBookmarkName, supportsNavigationBlockSelection, supportsNavigationInsertSelection } from "../src/pages/editor/tools/navigation-commands.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle", "KeyboardEvent", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const ID1 = "nav-11111111-1111-4111-8111-111111111111"
const ID2 = "nav-22222222-2222-4222-8222-222222222222"
const paragraph = (text = "", attrs = {}) => ({ type: "paragraph", attrs, ...(text ? { content: [{ type: "text", text }] } : {}) })
const heading = (text = "Heading", level = 2, navigationId = null, bookmarkName = null) => ({ type: "heading", attrs: { level, navigationId, bookmarkName }, ...(text ? { content: [{ type: "text", text }] } : {}) })
const toc = (attrs = {}) => ({ type: "tableOfContents", attrs: { title: "目录", maxLevel: 3, entries: [], ...attrs } })
const createEditor = (content = { type: "doc", content: [paragraph("source"), heading("first"), heading("second", 4), paragraph("after")] }) => new Editor({ element: document.createElement("div"), extensions: createExtensions(), content })
const select = (editor, from, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
const nodes = (editor, type) => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === type) result.push({ node, pos }) })
  return result
}
const track = (editor, target, mapper) => {
  const listener = ({ transaction, appendedTransactions = [] }) => [transaction, ...appendedTransactions].forEach(tr => mapper(target, tr))
  editor.on("transaction", listener)
  return () => editor.off("transaction", listener)
}
const record = content => ({ ...createDocument(), content })
const insertToc = editor => { select(editor, 1); return insertTableOfContentsAtTarget(editor, captureNavigationInsertTarget(editor), {}) }

test("内部 URL 仅接受规范稳定 ID，外部协议保持原白名单", () => {
  assert.equal(isNavigationId(ID1), true)
  assert.equal(isInternalNavigationHref(`#${ID1}`), true)
  assert.equal(isSafeLink(`#${ID1}`), true)
  for (const href of ["#foo", "#nav-test", `${ID1}`, `#${ID1.toUpperCase()}`, `#${ID1}/tail`, "javascript:alert(1)", " data:text/html,evil", "https://a.invalid/a b"]) assert.equal(isSafeDocumentLink(href), false)
  for (const href of ["https://a.invalid/", "http://a.invalid/", "mailto:a@b.invalid", "tel:1234"]) assert.equal(isSafeDocumentLink(href), true)
})

test("书签与目录文件属性严格校验，重复 ID 拒绝但旧文档及悬空内部链接仍合法", () => {
  for (const attrs of [{ navigationId: "bad" }, { bookmarkName: "name" }, { bookmarkName: "" }, { navigationId: ID1, bookmarkName: "x\ny" }, { navigationId: ID1, bookmarkName: "x".repeat(81) }]) assert.ok(validateNavigationBlockAttrs(attrs))
  for (const attrs of [{ title: null }, { title: "" }, { maxLevel: 0 }, { maxLevel: 7 }, { maxLevel: "3" }, { entries: null }, { entries: [{ id: ID1, level: 2, text: "bad\ntext" }] },
    { entries: [{ id: ID1, level: 2, text: "one" }, { id: ID1, level: 2, text: "two" }] }, { entries: [{ id: ID1, level: 2, text: "x".repeat(1001) }] }]) assert.ok(validateTableOfContentsAttrs(attrs))
  assert.throws(() => validateDocument(record({ type: "doc", content: [heading("a", 1, ID1), paragraph("b", { navigationId: ID1, bookmarkName: "b" })] })), /导航 ID 重复/)
  validateDocument(createDocument())
  validateDocument(record({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "dangling", marks: [{ type: "link", attrs: { href: `#${ID1}`, target: "_self" } }] }] }] }))
  const large = Array.from({ length: 2000 }, (_, index) => ({ id: `nav-${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`, level: 1, text: "x".repeat(1000) }))
  assert.throws(() => validateDocument(record({ type: "doc", content: [toc({ entries: large }), paragraph("over budget")] })), /文字超过/)
})

test("纯目标收集使用真实坐标并区分标题和同段书签，导出副本仅刷新既有 ID", () => {
  const source = { type: "doc", content: [paragraph("start"), { type: "details", attrs: { summary: "detail" }, content: [heading("inner\nheading", 3, ID1, "anchor")] },
    heading("missing", 1), toc({ maxLevel: 3, entries: [{ id: ID2, level: 1, text: "stale" }] })] }
  const editor = createEditor(source)
  try {
    const targets = collectNavigationTargets(source)
    assert.equal(targets[0].pos, nodes(editor, "heading")[0].pos)
    assert.deepEqual(targets.map(item => [item.type, item.id, item.name]), [["heading", ID1, "inner heading"], ["bookmark", ID1, "anchor"], ["heading", null, "missing"]])
    assert.deepEqual(getTableOfContentsEntries(source, 2), [])
    const refreshed = prepareNavigationContent(source)
    assert.deepEqual(refreshed.content.at(-1).attrs.entries, [{ id: ID1, level: 3, text: "inner heading" }])
    assert.equal(refreshed.content[2].attrs.navigationId, null)
    assert.equal(source.content.at(-1).attrs.entries[0].text, "stale")
  } finally { editor.destroy() }
})

test("目录插入为所有标题建立稳定 ID，保留光标两侧文字与格式，所有操作为一步撤销", () => {
  const editor = createEditor("<p><strong>source</strong></p><h1>first</h1><h4>second</h4><p>after</p>")
  try {
    select(editor, 4)
    const before = editor.getJSON()
    assert.equal(insertTableOfContentsAtTarget(editor, captureNavigationInsertTarget(editor), { title: "文章目录", maxLevel: 3 }).ok, true)
    const inserted = editor.getJSON()
    assert.equal(editor.state.doc.child(0).textContent, "sou")
    assert.equal(editor.state.doc.child(2).textContent, "rce")
    assert.equal(editor.state.doc.child(0).firstChild.marks[0].type.name, "bold")
    assert.equal(nodes(editor, "heading").every(({ node }) => isNavigationId(node.attrs.navigationId)), true)
    assert.deepEqual(nodes(editor, "tableOfContents")[0].node.attrs.entries.map(entry => entry.text), ["first"])
    assert.ok(editor.state.selection instanceof NodeSelection)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.redo()
    assert.deepEqual(editor.getJSON(), inserted)
  } finally { editor.destroy() }
})

test("大量无ID标题批量分配只扫描正文常数次，全部身份唯一且目录快照遵守条目上限", () => {
  const schema = getSchema(createExtensions())
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON({ type: "doc", content: [paragraph(), ...Array.from({ length: 3000 }, (_, index) => heading(`heading ${index}`, 1))] }) })
  const editor = { isDestroyed: false, isEditable: true, schema, get state() { return state }, view: { composing: false, dispatch: tr => { state = state.apply(tr) } } }
  let scans = 0
  const original = ModelNode.prototype.descendants
  ModelNode.prototype.descendants = function (...args) { scans += 1; return original.apply(this, args) }
  try {
    assert.equal(insertTableOfContentsAtTarget(editor, captureNavigationInsertTarget(editor), {}).ok, true)
    // 计数直接验证批量算法，不使用机器速度相关的毫秒阈值；无 DOM/插件的真实 schema 与事务保持契约一致。
    assert.ok(scans <= 4, `正文完整扫描次数为 ${scans}`)
  } finally { ModelNode.prototype.descendants = original }
  const ids = []
  let entries = null
  state.doc.descendants(node => {
    if (node.type.name === "heading") ids.push(node.attrs.navigationId)
    if (node.type.name === "tableOfContents") entries = node.attrs.entries
  })
  assert.equal(ids.length, 3000)
  assert.equal(ids.every(isNavigationId), true)
  assert.equal(new Set(ids).size, 3000)
  assert.equal(entries.length, 2000)
})

test("标题改名、级别、新增、重排、删除实时刷新所有目录并随原编辑一起撤销", () => {
  const editor = createEditor()
  try {
    assert.equal(insertToc(editor).ok, true)
    const selected = captureTableOfContentsTarget(editor)
    assert.equal(applyTableOfContentsSettings(editor, selected, { maxLevel: 6 }).ok, true)
    const before = editor.getJSON()
    let first = nodes(editor, "heading")[0]
    editor.view.dispatch(editor.state.tr.insertText(" renamed", first.pos + first.node.nodeSize - 1))
    assert.equal(nodes(editor, "tableOfContents")[0].node.attrs.entries[0].text, "first renamed")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    first = nodes(editor, "heading")[0]
    editor.view.dispatch(editor.state.tr.setNodeMarkup(first.pos, undefined, { ...first.node.attrs, level: 5 }))
    assert.equal(nodes(editor, "tableOfContents")[0].node.attrs.entries[0].level, 5)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.heading.create({ level: 1 }, editor.schema.text("new"))))
    assert.deepEqual(nodes(editor, "tableOfContents")[0].node.attrs.entries.map(entry => entry.text), ["new", "first", "second"])
    assert.ok(isNavigationId(editor.state.doc.firstChild.attrs.navigationId))
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    const items = nodes(editor, "heading")
    const move = editor.state.tr.delete(items[1].pos, items[1].pos + items[1].node.nodeSize).insert(items[0].pos, items[1].node)
    editor.view.dispatch(move)
    assert.deepEqual(nodes(editor, "tableOfContents")[0].node.attrs.entries.map(entry => entry.text), ["second", "first"])
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    first = nodes(editor, "heading")[0]
    editor.view.dispatch(editor.state.tr.delete(first.pos, first.pos + first.node.nodeSize))
    assert.deepEqual(nodes(editor, "tableOfContents")[0].node.attrs.entries.map(entry => entry.text), ["second"])
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
  } finally { editor.destroy() }
})

test("重复副本插在原节点前也不抢原 ID，拆分段落只保留一个命名书签", () => {
  const editor = createEditor({ type: "doc", content: [heading("original", 1, ID1, "heading bookmark"), paragraph("after")] })
  try {
    const original = editor.state.doc.firstChild
    editor.view.dispatch(editor.state.tr.insert(0, original))
    assert.notEqual(editor.state.doc.child(0).attrs.navigationId, ID1)
    assert.equal(editor.state.doc.child(0).attrs.bookmarkName, null)
    assert.equal(editor.state.doc.child(1).attrs.navigationId, ID1)
    assert.equal(editor.state.doc.child(1).attrs.bookmarkName, "heading bookmark")
    validateDocument(record(editor.getJSON()))
    editor.commands.setContent({ type: "doc", content: [paragraph("bookmark text", { navigationId: ID2, bookmarkName: "original paragraph" }), paragraph("after")] })
    select(editor, 5)
    editor.commands.splitBlock()
    assert.equal(editor.state.doc.child(0).attrs.navigationId, ID2)
    assert.equal(editor.state.doc.child(0).attrs.bookmarkName, "original paragraph")
    assert.equal(editor.state.doc.child(1).attrs.navigationId, null)
    assert.equal(editor.state.doc.child(1).attrs.bookmarkName, null)
    validateDocument(record(editor.getJSON()))
  } finally { editor.destroy() }
})

test("单段书签增改删保留内容和其他属性，标题删除书签后继续保留标题身份", () => {
  for (const type of ["paragraph", "heading"]) {
    const editor = createEditor({ type: "doc", content: [type === "heading" ? heading("text", 2) : paragraph("text", { textAlign: "right" }), paragraph("after")] })
    try {
      select(editor, 3)
      const target = captureNavigationBlockTarget(editor)
      const stop = track(editor, target, mapNavigationBlockTarget)
      assert.equal(setBookmarkName(editor, target, "标记一").ok, true)
      const id = readNavigationBlockTarget(editor, target).attrs.navigationId
      assert.ok(isNavigationId(id))
      assert.equal(setBookmarkName(editor, target, "标记二").ok, true)
      assert.equal(readNavigationBlockTarget(editor, target).attrs.navigationId, id)
      assert.equal(removeBookmarkName(editor, target).ok, true)
      assert.equal(editor.state.doc.firstChild.textContent, "text")
      assert.equal(editor.state.doc.firstChild.attrs.navigationId, type === "heading" ? id : null)
      assert.equal(editor.state.doc.firstChild.attrs.bookmarkName, null)
      if (type === "paragraph") assert.equal(editor.state.doc.firstChild.attrs.textAlign, "right")
      stop()
    } finally { editor.destroy() }
  }
})

test("原节点书签映射前方输入与属性变化，整段替换及身份清除后永久拒绝旧草稿", () => {
  for (const action of ["prefix", "replace", "remove"]) {
    const editor = createEditor({ type: "doc", content: [paragraph("text", { navigationId: ID1, bookmarkName: "name" }), paragraph("after")] })
    try {
      select(editor, 3)
      const target = captureNavigationBlockTarget(editor)
      const stop = track(editor, target, mapNavigationBlockTarget)
      if (action === "prefix") editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.paragraph.create(null, editor.schema.text("prefix"))))
      else if (action === "replace") editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.firstChild.nodeSize, editor.state.doc.firstChild))
      else removeBookmarkName(editor, target)
      const before = editor.getJSON()
      assert.equal(setBookmarkName(editor, target, "changed").ok, action === "prefix")
      if (action !== "prefix") {
        assert.deepEqual(editor.getJSON(), before)
        editor.commands.undo()
        assert.equal(readNavigationBlockTarget(editor, target), null)
      }
      stop()
    } finally { editor.destroy() }
  }
})

test("目录目标允许自身快照刷新，但整节点替换后旧设置目标不能复活", () => {
  const editor = createEditor()
  try {
    insertToc(editor)
    const target = captureTableOfContentsTarget(editor)
    const stop = track(editor, target, mapTableOfContentsTarget)
    const first = nodes(editor, "heading")[0]
    editor.view.dispatch(editor.state.tr.insertText(" new", first.pos + first.node.nodeSize - 1))
    assert.ok(readTableOfContentsSettings(editor, target))
    assert.equal(applyTableOfContentsSettings(editor, target, { title: "新目录", maxLevel: 6 }).ok, true)
    const tocNode = editor.state.doc.nodeAt(target.pos)
    editor.view.dispatch(editor.state.tr.replaceWith(target.pos, target.pos + 1, tocNode))
    const before = editor.getJSON()
    assert.equal(applyTableOfContentsSettings(editor, target, { title: "旧草稿" }).ok, false)
    assert.equal(removeTableOfContents(editor, target).ok, false)
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.undo()
    assert.equal(readTableOfContentsSettings(editor, target), null)
    stop()
  } finally { editor.destroy() }
})

test("相邻目录删除首个后旧目标永久失效，不能把草稿套给后一个目录或 undo 恢复的目录", () => {
  const editor = createEditor({ type: "doc", content: [toc({ title: "first" }), toc({ title: "second" }), paragraph("after")] })
  try {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    const target = captureTableOfContentsTarget(editor)
    const stop = track(editor, target, mapTableOfContentsTarget)
    assert.equal(removeTableOfContents(editor, target).ok, true)
    assert.equal(target.valid, false)
    assert.equal(readTableOfContentsSettings(editor, target), null)
    const before = editor.getJSON()
    assert.equal(applyTableOfContentsSettings(editor, target, { title: "WRONG" }).ok, false)
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(editor.state.doc.firstChild.attrs.title, "second")
    editor.commands.undo()
    assert.equal(readTableOfContentsSettings(editor, target), null)
    assert.equal(applyTableOfContentsSettings(editor, target, { title: "WRONG" }).ok, false)
    assert.deepEqual(nodes(editor, "tableOfContents").map(({ node }) => node.attrs.title), ["first", "second"])
    stop()
  } finally { editor.destroy() }
})

test("目录插入与书签只接受明确普通段落，文字范围及跨结构选择不会吞并正文", () => {
  const editor = createEditor()
  try {
    select(editor, 2, 4)
    assert.equal(supportsNavigationBlockSelection(editor), true)
    assert.equal(supportsNavigationInsertSelection(editor), false)
    assert.equal(captureNavigationInsertTarget(editor), null)
    select(editor, 2, editor.state.doc.content.size - 2)
    assert.equal(captureNavigationBlockTarget(editor), null)
    editor.commands.setContent("<ul><li><p>list</p></li></ul><table><tr><td><p>cell</p></td></tr></table>")
    const paragraphs = nodes(editor, "paragraph")
    for (const { pos } of paragraphs.slice(0, 2)) {
      select(editor, pos + 1)
      assert.equal(supportsNavigationBlockSelection(editor), true)
      assert.equal(supportsNavigationInsertSelection(editor), false)
      assert.equal(setBookmarkName(editor, captureNavigationBlockTarget(editor), "allowed single block").ok, true)
    }
  } finally { editor.destroy() }
})

test("插入目录使用映射后的原光标，整段替换与 undo 后旧插入目标仍失效", () => {
  for (const replacement of [false, true]) {
    const editor = createEditor()
    try {
      select(editor, 3)
      const target = captureNavigationInsertTarget(editor)
      const stop = track(editor, target, mapNavigationInsertTarget)
      if (replacement) editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.firstChild.nodeSize, editor.state.doc.firstChild))
      else editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.paragraph.create(null, editor.schema.text("prefix"))))
      select(editor, editor.state.doc.content.size - 2)
      const before = editor.getJSON()
      assert.equal(insertTableOfContentsAtTarget(editor, target, {}).ok, !replacement)
      if (replacement) {
        assert.deepEqual(editor.getJSON(), before)
        editor.commands.undo()
        assert.equal(insertTableOfContentsAtTarget(editor, target, {}).ok, false)
      } else assert.deepEqual(editor.getJSON().content.slice(0, 4).map(node => [node.type, node.content?.[0]?.text || ""]), [["paragraph", "prefix"], ["paragraph", "so"], ["tableOfContents", ""], ["paragraph", "urce"]])
      stop()
    } finally { editor.destroy() }
  }
})

test("内部链接创建同时建立标题 ID 与文字 mark，为同一次撤销且保留前后输入", () => {
  const editor = createEditor()
  try {
    select(editor, 2, 5)
    const source = captureNavigationLinkTarget(editor)
    const destination = captureNavigationBlockTarget(editor, nodes(editor, "heading")[0].pos)
    const stopSource = track(editor, source, mapNavigationLinkTarget)
    const stopTarget = track(editor, destination, mapNavigationBlockTarget)
    const before = editor.getJSON()
    const result = applyInternalNavigationLink(editor, source, destination)
    assert.equal(result.ok, true)
    const applied = editor.getJSON()
    const linked = editor.state.doc.firstChild.child(1)
    assert.equal(linked.text, "our")
    assert.equal(linked.marks[0].attrs.href, `#${result.id}`)
    assert.equal(linked.marks[0].attrs.target, "_self")
    assert.equal(editor.state.doc.firstChild.textContent, "source")
    select(editor, 3)
    const expanded = captureNavigationLinkTarget(editor)
    assert.deepEqual([getNavigationLinkSelection(editor, expanded).from, getNavigationLinkSelection(editor, expanded).to], [2, 5])
    editor.commands.insertContent("X")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), applied)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    editor.commands.redo()
    assert.deepEqual(editor.getJSON(), applied)
    stopSource()
    stopTarget()
  } finally { editor.destroy() }
})

test("内部链接源删除后 undo 不复活旧选区，标题确保ID不改文字或已有ID", () => {
  const editor = createEditor()
  try {
    select(editor, 2, 5)
    const source = captureNavigationLinkTarget(editor)
    const stop = track(editor, source, mapNavigationLinkTarget)
    const destination = captureNavigationBlockTarget(editor, nodes(editor, "heading")[0].pos)
    editor.view.dispatch(editor.state.tr.delete(2, 5))
    editor.commands.undo()
    const before = editor.getJSON()
    assert.equal(applyInternalNavigationLink(editor, source, destination).ok, false)
    assert.deepEqual(editor.getJSON(), before)
    stop()
    const headingTarget = captureNavigationBlockTarget(editor, nodes(editor, "heading")[0].pos)
    const stopHeading = track(editor, headingTarget, mapNavigationBlockTarget)
    const result = ensureHeadingTarget(editor, headingTarget)
    assert.equal(result.ok, true)
    assert.equal(nodes(editor, "heading")[0].node.textContent, "first")
    assert.equal(ensureHeadingTarget(editor, headingTarget).changed, false)
    assert.equal(listNavigationTargets(editor).find(item => item.id === result.id).name, "first")
    stopHeading()
  } finally { editor.destroy() }
})

test("定位只改变选区，展开折叠祖先；只读可跳转，编辑普通点击不会离开正文", () => {
  const editor = createEditor({ type: "doc", content: [paragraph("source"), { type: "details", attrs: { summary: "details" }, content: [heading("hidden heading", 2, ID1)] },
    toc({ entries: [{ id: ID1, level: 2, text: "hidden heading" }] }), paragraph("after")] })
  let updates = 0
  editor.on("update", () => { updates += 1 })
  try {
    select(editor, 2)
    const before = editor.getJSON()
    editor.view.dom.querySelector("[data-details-toggle]").click()
    const anchor = editor.view.dom.querySelector("[data-toc-view] a")
    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    assert.equal(event.defaultPrevented, true)
    assert.equal(editor.state.selection.from, 2)
    assert.equal(navigateToTarget(editor, ID1).ok, true)
    assert.equal(editor.view.dom.querySelector("[data-details-content]").hidden, false)
    assert.equal(editor.state.selection.$from.parent.textContent, "hidden heading")
    editor.setEditable(false, false)
    select(editor, 2)
    editor.view.dom.querySelector("[data-details-toggle]").click()
    assert.equal(editor.view.dom.querySelector("[data-details-content]").hidden, true)
    const readonlyEvent = new MouseEvent("click", { bubbles: true, cancelable: true })
    anchor.dispatchEvent(readonlyEvent)
    assert.equal(readonlyEvent.defaultPrevented, true)
    assert.equal(editor.state.selection.$from.parent.textContent, "hidden heading")
    assert.equal(editor.view.dom.querySelector("[data-details-content]").hidden, false)
    assert.equal(DOM.window.location.hash, "")
    assert.equal(navigateToTarget(editor, ID2).ok, false)
    assert.equal(updates, 0)
    assert.deepEqual(editor.getJSON(), before)
  } finally { editor.destroy() }
})

test("纯选区与视图切换不刷新目录，IME延迟刷新随原输入撤销且销毁解除计时器", async () => {
  const editor = createEditor()
  try {
    insertToc(editor)
    const before = editor.getJSON()
    let updates = 0
    editor.on("update", () => { updates += 1 })
    select(editor, 2)
    editor.commands.setFormattingMarksVisible(true)
    assert.equal(updates, 0)
    editor.view.input.composing = true
    const first = nodes(editor, "heading")[0]
    editor.view.dispatch(editor.state.tr.insertText(" IME", first.pos + first.node.nodeSize - 1))
    assert.equal(nodes(editor, "tableOfContents")[0].node.attrs.entries[0].text, "first")
    editor.view.input.composing = false
    editor.view.dom.dispatchEvent(new DOM.window.Event("compositionend", { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(nodes(editor, "tableOfContents")[0].node.attrs.entries[0].text, "first IME")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), before)
    editor.view.dom.dispatchEvent(new DOM.window.Event("compositionend", { bubbles: true }))
    editor.destroy()
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally { if (!editor.isDestroyed) editor.destroy() }
})

test("只读、切换与组合输入拒绝全部写命令，目录模型和原选区保持一致", () => {
  const editor = createEditor()
  try {
    select(editor, 1)
    const insertion = captureNavigationInsertTarget(editor)
    const block = captureNavigationBlockTarget(editor, nodes(editor, "heading")[0].pos)
    const linkSource = captureNavigationLinkTarget(editor)
    for (const mode of ["readonly", "switching", "composing"]) {
      editor.setEditable(mode !== "readonly", false)
      editor.view.input.composing = mode === "composing"
      const before = editor.getJSON()
      const selection = editor.state.selection.toJSON()
      const blocked = mode === "switching"
      assert.equal(insertTableOfContentsAtTarget(editor, insertion, {}, blocked).ok, false)
      assert.equal(setBookmarkName(editor, block, "name", blocked).ok, false)
      assert.equal(removeBookmarkName(editor, block, blocked).ok, false)
      assert.equal(ensureHeadingTarget(editor, block, blocked).ok, false)
      assert.equal(applyInternalNavigationLink(editor, linkSource, block, blocked).ok, false)
      assert.deepEqual(editor.getJSON(), before)
      assert.deepEqual(editor.state.selection.toJSON(), selection)
    }
    editor.view.input.composing = false
    editor.setEditable(true, false)
    assert.equal(insertTableOfContentsAtTarget(editor, insertion, {}).ok, true)
    const target = captureTableOfContentsTarget(editor)
    editor.setEditable(false, false)
    assert.equal(applyTableOfContentsSettings(editor, target, { title: "new" }).ok, false)
    assert.equal(removeTableOfContents(editor, target).ok, false)
  } finally { editor.destroy() }
})

test("目录HTML往返与纯文本复制保留完整快照，内部link目标_self且未知fragment不恢复", () => {
  const editor = createEditor({ type: "doc", content: [heading("first", 2, ID1), toc({ title: "outline", entries: [{ id: ID1, level: 2, text: "first" }] }), paragraph("after")] })
  try {
    const before = editor.getJSON()
    const html = editor.getHTML()
    assert.match(html, /data-navigation-id="nav-/)
    assert.match(html, /data-toc-level="2"/)
    editor.commands.setContent(html)
    assert.deepEqual(editor.getJSON(), before)
    const item = nodes(editor, "tableOfContents")[0]
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, item.pos)))
    assert.equal(editor.view.serializeForClipboard(editor.state.selection.content()).text, "outline\n\nfirst")
    editor.commands.setContent(`<p><a href="#${ID1}">internal</a> <a href="#unknown">unknown</a></p>`)
    assert.equal(editor.state.doc.firstChild.firstChild.marks[0].attrs.target, "_self")
    assert.equal(editor.state.doc.firstChild.lastChild.marks.length, 0)
    assert.equal(editor.state.doc.firstChild.textContent, "internal unknown")
  } finally { editor.destroy() }
})
