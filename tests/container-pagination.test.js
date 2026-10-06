/** 真实 schema 的只读递归分页结构，另以实际 NodeView 核对合法内容挂载点；不以 JSDOM 验证字体几何。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor, getSchema, Node as TiptapNode } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { DocumentTaskList, DocumentTaskItem } from "../src/pages/editor/extensions/document-task-list.js"
import { DocumentTextBox, DocumentDetails } from "../src/pages/editor/extensions/block-containers.js"
import { DocumentCodeBlock } from "../src/pages/editor/extensions/code-block.js"
import { PAGINATION_CONTAINER_TYPES, analyzeContainerPagination, getContainerPaginationDOM, analyzeCodeBlockPagination } from "../src/pages/editor/tools/container-pagination.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const unknownContainer = TiptapNode.create({ name: "unknownContainer", group: "block", content: "block+", renderHTML: () => ["div", {}, 0] })
const blockAtom = TiptapNode.create({ name: "blockAtom", group: "block", atom: true, renderHTML: () => ["div", { "data-block-atom": "" }] })
const extensions = [StarterKit.configure({ trailingNode: false, codeBlock: false }), TableKit.configure({ table: { resizable: false } }),
  DocumentTaskList, DocumentTaskItem, DocumentTextBox, DocumentDetails, DocumentCodeBlock, unknownContainer, blockAtom]
const schema = getSchema(extensions)
const p = text => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
const item = (children, task = false, checked = false) => schema.nodes[task ? "taskItem" : "listItem"].create(task ? { checked } : null, children)
const list = (type, children, attrs = null) => schema.nodes[type].create(attrs, children)
const shell = (type, children, attrs = null) => schema.nodes[type].create(attrs, children)
const table = (merged = false) => schema.nodes.table.create(null, [
  schema.nodes.tableRow.create(null, [schema.nodes.tableHeader.create(merged ? { rowspan: 2 } : null, p("头")), schema.nodes.tableHeader.create(null, p("另一列"))]),
  schema.nodes.tableRow.create(null, [...(merged ? [] : [schema.nodes.tableCell.create(null, p("a"))]), schema.nodes.tableCell.create(null, p("b"))])
])
const code = text => schema.nodes.codeBlock.create({ language: "javascript" }, text ? schema.text(text) : null)
const checkPositions = (node, pos, result) => {
  const prefix = p("原表前置")
  const doc = schema.nodes.doc.create(null, [prefix, node])
  const offset = prefix.nodeSize - pos
  result.leaves.forEach(leaf => assert.equal(doc.nodeAt(leaf.pos + offset), leaf.node))
}

test("普通/有序/任务列表保留原编号与勾选属性，叶子模型位置按真实 token 累加", () => {
  for (const type of ["bulletList", "orderedList", "taskList"]) {
    const node = list(type, [item([p("短")], type === "taskList", true), item([p("正文更长"), p("第二段")], type === "taskList")],
      type === "orderedList" ? { start: 7, type: "A" } : null)
    const before = node.toJSON()
    const result = analyzeContainerPagination(node, 11)
    assert.deepEqual(result.leaves.map(leaf => leaf.node.textContent), ["短", "正文更长", "第二段"])
    assert.deepEqual(result.leaves.map(leaf => leaf.kind), ["paragraph", "paragraph", "paragraph"])
    assert.deepEqual(result.containers.map(container => [container.type, container.firstLeaf, container.lastLeaf]), [
      [type, 0, 2], [type === "taskList" ? "taskItem" : "listItem", 0, 0], [type === "taskList" ? "taskItem" : "listItem", 1, 2]
    ])
    assert.equal(result.leaves[0].ancestors[0].node, node)
    assert.equal(result.leaves[0].ancestors[1].node, node.firstChild)
    assert.equal(result.containers[1].parentPos, 11)
    checkPositions(node, 11, result)
    assert.deepEqual(node.toJSON(), before)
  }
})

test("多层列表、引用和文本框按 outer→inner 保留全部祖先，不展平为新正文节点", () => {
  const node = shell("textBox", [p("前段"), shell("blockquote", [list("orderedList", [item([
    p("条目"), list("bulletList", [item([p("嵌套第一项")]), item([p("嵌套第二项")])])
  ])], { start: 3 })]), p("尾段")])
  const result = analyzeContainerPagination(node, 3)
  assert.deepEqual(result.leaves.map(leaf => leaf.node.textContent), ["前段", "条目", "嵌套第一项", "嵌套第二项", "尾段"])
  assert.deepEqual(result.leaves[2].ancestors.map(container => container.type), ["textBox", "blockquote", "orderedList", "listItem", "bulletList", "listItem"])
  assert.deepEqual(result.containers[0], { node, pos: 3, type: "textBox", parentPos: null, firstLeaf: 0, lastLeaf: 4 })
  result.containers.forEach(container => {
    assert.ok(container.firstLeaf <= container.lastLeaf)
    assert.ok(result.leaves.slice(container.firstLeaf, container.lastLeaf + 1).every(leaf => leaf.ancestors.includes(container)))
  })
  checkPositions(node, 3, result)
})

test("展开详情可递归，闭合详情保留自身完整 leaf，状态由回调读取且默认保守闭合", () => {
  const closed = shell("details", [p("隐藏正文"), list("bulletList", [item([p("隐藏列表")])])], { summary: "闭合" })
  const node = shell("details", [p("可见前段"), closed, p("可见尾段")], { summary: "展开" })
  const result = analyzeContainerPagination(node, 5, { isDetailsExpanded: current => current.attrs.summary === "展开" })
  assert.deepEqual(result.leaves.map(leaf => [leaf.node.type.name, leaf.kind]), [["paragraph", "paragraph"], ["details", "block"], ["paragraph", "paragraph"]])
  assert.equal(result.leaves[1].node, closed)
  assert.deepEqual(result.containers.map(container => [container.type, container.firstLeaf, container.lastLeaf]), [["details", 0, 2], ["details", 1, 1]])
  assert.deepEqual(result.leaves[1].ancestors.map(container => container.node.attrs.summary), ["展开", "闭合"])
  assert.equal(analyzeContainerPagination(node, 5).leaves[0].node, node)
  assert.equal(analyzeContainerPagination(node, 5, { isDetailsExpanded: () => { throw new Error("视图已销毁") } }).leaves[0].node, node)
})

test("容器中的表格沿用安全 rowspan 行组，绝不递归拆分单元格里的列表或嵌套表", () => {
  const inner = table()
  const outer = schema.nodes.table.create(null, [schema.nodes.tableRow.create(null, [schema.nodes.tableCell.create(null, [p("格内正文"), inner,
    list("bulletList", [item([p("格内列表")])])])])])
  const node = shell("textBox", [p("前"), table(true), outer, p("尾")])
  const result = analyzeContainerPagination(node, 0)
  assert.deepEqual(result.leaves.map(leaf => leaf.kind), ["paragraph", "table", "table", "paragraph"])
  assert.equal(result.leaves[1].table.columns, 2)
  assert.deepEqual(result.leaves[1].table.groups.map(group => [group.firstRow, group.lastRow]), [[0, 1]])
  assert.equal(result.leaves[2].table.columns, 1)
  assert.equal(result.leaves.some(leaf => leaf.node === inner), false)
  assert.equal(result.containers.length, 1)
  checkPositions(node, 0, result)
})

test("原子、未知外壳、错误容器与非法 TableMap 都完整保留，不能悄悄丢掉不认识的正文", () => {
  const atom = schema.nodes.blockAtom.create()
  const unknown = shell("unknownContainer", [p("未知内部正文")])
  const invalidList = list("bulletList", [p("损坏但须保留")])
  const invalidTable = schema.nodes.table.create(null, [schema.nodes.tableRow.create(null, [schema.nodes.tableCell.create({ rowspan: 4 }, p("越界表格"))])])
  const node = shell("blockquote", [atom, unknown, invalidList, invalidTable, code("const x = 1")])
  const result = analyzeContainerPagination(node, 1)
  assert.deepEqual(result.leaves.map(leaf => leaf.kind), ["block", "block", "block", "block", "code"])
  assert.equal(result.leaves[1].node, unknown)
  assert.equal(result.leaves[2].node, invalidList)
  assert.equal(result.leaves[3].node, invalidTable)
  assert.equal(result.leaves.some(leaf => leaf.node.textContent === "未知内部正文" && leaf.node.type.name === "paragraph"), false)
})

test("过深递归在安全层数收口为完整子树，不递归溢出或丢失最深正文", () => {
  let node = p("最深内容")
  for (let depth = 0; depth < 150; depth += 1) node = shell("textBox", [node])
  const result = analyzeContainerPagination(node, 0)
  assert.equal(result.containers.length, 64)
  assert.equal(result.leaves.length, 1)
  assert.equal(result.leaves[0].kind, "block")
  assert.equal(result.leaves[0].node.textContent, "最深内容")
  assert.equal(result.leaves[0].ancestors.length, 64)
})

test("代码行范围保持 LF/CRLF/CR 和 Unicode 原长度，尾空行并入前组", () => {
  assert.deepEqual(analyzeCodeBlockPagination(code("a\nb\n"), 10), { lineCount: 3, groups: [
    { firstLine: 0, lastLine: 0, pos: 11, nodeSize: 2 }, { firstLine: 1, lastLine: 2, pos: 13, nodeSize: 2 }
  ] })
  assert.deepEqual(analyzeCodeBlockPagination(code("😀\r\nx\ry"), 100), { lineCount: 3, groups: [
    { firstLine: 0, lastLine: 0, pos: 101, nodeSize: 4 }, { firstLine: 1, lastLine: 1, pos: 105, nodeSize: 2 }, { firstLine: 2, lastLine: 2, pos: 107, nodeSize: 1 }
  ] })
  assert.deepEqual(analyzeCodeBlockPagination(code("\n\n"), 0), { lineCount: 3, groups: [
    { firstLine: 0, lastLine: 0, pos: 1, nodeSize: 1 }, { firstLine: 1, lastLine: 2, pos: 2, nodeSize: 1 }
  ] })
  assert.deepEqual(analyzeCodeBlockPagination(code(""), 0), { lineCount: 1, groups: [{ firstLine: 0, lastLine: 0, pos: 1, nodeSize: 1 }] })
})

test("结构与代码输入校验拒绝无效位置/非目标节点，分析不修改节点或共享输出数组", () => {
  const node = shell("textBox", [p("正文"), code("x\ny")])
  const before = node.toJSON()
  for (const pos of [-1, 1.5, Infinity, NaN, "1", Number.MAX_SAFE_INTEGER]) {
    assert.equal(analyzeContainerPagination(node, pos), null)
    assert.equal(analyzeCodeBlockPagination(code("x"), pos), null)
  }
  assert.equal(analyzeContainerPagination(p("正文"), 0), null)
  assert.equal(analyzeContainerPagination(node, 0, { isDetailsExpanded: true }), null)
  assert.equal(analyzeCodeBlockPagination(p("正文"), 0), null)
  const marked = schema.nodes.codeBlock.create(null, schema.text("bad", [schema.marks.bold.create()]))
  assert.equal(analyzeCodeBlockPagination(marked, 0), null)
  const first = analyzeContainerPagination(node, 0)
  first.leaves[0].ancestors.length = 0
  first.containers[0].firstLeaf = 9
  const second = analyzeContainerPagination(node, 0)
  assert.equal(second.leaves[0].ancestors.length, 1)
  assert.equal(second.containers[0].firstLeaf, 0)
  assert.deepEqual(node.toJSON(), before)
  assert.equal(Object.isFrozen(PAGINATION_CONTAINER_TYPES), true)
})

test("真实任务/详情 NodeView 只读挂载点保留原复选框与按钮实例，闭合状态不会写回 JSON", () => {
  const host = document.body.appendChild(document.createElement("div"))
  const editor = new Editor({ element: host, extensions, content: { type: "doc", content: [
    list("bulletList", [item([p("普通")])]).toJSON(), list("orderedList", [item([p("编号")])], { start: 4 }).toJSON(),
    list("taskList", [item([p("待办")], true, true)]).toJSON(), shell("blockquote", [p("引用")]).toJSON(),
    shell("textBox", [shell("details", [p("详情正文")], { summary: "原始摘要" })]).toJSON(), code("a\nb").toJSON()
  ] } })
  try {
    const records = []
    editor.state.doc.descendants((node, pos) => { if (PAGINATION_CONTAINER_TYPES.includes(node.type.name) || node.type.name === "codeBlock") records.push({ node, pos }) })
    const original = editor.getJSON()
    for (const record of records) {
      const result = getContainerPaginationDOM(editor.view, record.node, record.pos)
      assert.equal(result.dom, editor.view.nodeDOM(record.pos))
      assert.equal(result.expanded, true)
      assert.ok(result.dom.contains(result.contentDOM))
      assert.equal(getContainerPaginationDOM(editor.view, record.node, record.pos).contentDOM, result.contentDOM)
    }
    const task = records.find(record => record.node.type.name === "taskItem")
    const details = records.find(record => record.node.type.name === "details")
    const checkbox = editor.view.nodeDOM(task.pos).querySelector("input")
    const toggle = editor.view.nodeDOM(details.pos).querySelector("[data-details-toggle]")
    assert.equal(getContainerPaginationDOM(editor.view, task.node, task.pos).contentDOM.tagName, "DIV")
    assert.equal(checkbox.checked, true)
    toggle.click()
    assert.equal(getContainerPaginationDOM(editor.view, details.node, details.pos).expanded, false)
    assert.equal(getContainerPaginationDOM(editor.view, details.node, details.pos).contentDOM.hidden, true)
    assert.equal(editor.view.nodeDOM(task.pos).querySelector("input"), checkbox)
    assert.equal(editor.view.nodeDOM(details.pos).querySelector("[data-details-toggle]"), toggle)
    assert.deepEqual(editor.getJSON(), original)
    const box = records.find(record => record.node.type.name === "textBox")
    const result = analyzeContainerPagination(box.node, box.pos, { isDetailsExpanded: (node, pos) => getContainerPaginationDOM(editor.view, node, pos)?.expanded })
    assert.equal(result.leaves.length, 1)
    assert.equal(result.leaves[0].node.type.name, "details")
  } finally { editor.destroy(); host.remove() }
})

test("静态 DETAILS/合法列表挂载点可读取，失配或多个正文包装不误取嵌套子树", () => {
  const root = document.createElement("div")
  const details = shell("details", [p("body")])
  root.innerHTML = "<details open><summary>标题</summary><div data-details-content><p>正文</p></div></details>"
  const view = { dom: root, nodeDOM: () => root.firstElementChild }
  assert.equal(getContainerPaginationDOM(view, details, 0).expanded, true)
  root.firstElementChild.open = false
  assert.equal(getContainerPaginationDOM(view, details, 0).expanded, false)
  root.firstElementChild.appendChild(document.createElement("div")).dataset.detailsContent = "true"
  assert.equal(getContainerPaginationDOM(view, details, 0), null)
  root.innerHTML = "<ul><li><p>x</p></li></ul>"
  assert.equal(getContainerPaginationDOM(view, list("orderedList", [item([p("x")])]), 0), null)
  assert.equal(getContainerPaginationDOM(view, list("bulletList", [item([p("x")])]), 0).contentDOM.tagName, "UL")
  assert.equal(getContainerPaginationDOM({ dom: root, nodeDOM: () => document.createElement("ul") }, list("bulletList", [item([p("x")])]), 0), null)
})
