/**
 * 验证真实 Tiptap 表格 schema 的纯结构分析：逻辑列、表头边界、不可拆 rowspan 组与绝对位置。
 * 不依赖浏览器估算高度；行组几何、重复表头外观和真实选格交互由分页浏览器验收覆盖。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { getSchema } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { TableMap } from "@tiptap/pm/tables"
import { analyzeTablePagination } from "../src/pages/editor/tools/table-pagination.js"

// 直接创建 schema 节点，保留错误网格供失败场景验证，避免 TableKit 的修复事务先替测试改好输入。
const schema = getSchema([StarterKit.configure({ trailingNode: false }), TableKit])
const paragraph = text => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
const cell = (text = "格", attrs = {}, header = false, content = null) =>
  schema.nodes[header ? "tableHeader" : "tableCell"].create(attrs, content || paragraph(text))
const row = cells => schema.nodes.tableRow.create(null, cells)
const table = rows => schema.nodes.table.create(null, rows)
const ranges = result => result.groups.map(group => [group.firstRow, group.lastRow])

test("普通表格按独立行分页，逻辑列、行 token 位置和 nodeSize 都来自真实节点", () => {
  const node = table([row([cell("a"), cell("正文更长")]), row([cell("b"), cell("c")]), row([cell(), cell()])])
  const result = analyzeTablePagination(node, 19)
  assert.equal(result.columns, 2)
  assert.deepEqual(result.headerRows, [])
  assert.deepEqual(ranges(result), [[0, 0], [1, 1], [2, 2]])
  let pos = 20
  result.groups.forEach((group, index) => {
    assert.equal(group.pos, pos)
    assert.equal(group.nodeSize, node.child(index).nodeSize)
    pos += node.child(index).nodeSize
  })
  assert.equal(pos, 19 + node.nodeSize - 1)
})

test("横向合并按逻辑列计数，整行 colspan 表头仍可重复", () => {
  const node = table([row([cell("标题", { colspan: 3 }, true)]), row([cell("a"), cell("b"), cell("c")])])
  const result = analyzeTablePagination(node, 0)
  assert.equal(node.firstChild.childCount, 1)
  assert.equal(result.columns, 3)
  assert.deepEqual(result.headerRows, [0])
  assert.deepEqual(ranges(result), [[0, 0], [1, 1]])
})

test("开头连续多行纯表头都重复，正文后出现的表头行不加入重复区", () => {
  const node = table([
    row([cell("一级", { colspan: 2 }, true)]),
    row([cell("项目", {}, true), cell("值", {}, true)]),
    row([cell("正文"), cell("1")]),
    row([cell("中部标题", { colspan: 2 }, true)])
  ])
  assert.deepEqual(analyzeTablePagination(node, 7).headerRows, [0, 1])
})

test("混合表头终止连续表头识别，不将左侧表头列或后续纯表头重复", () => {
  for (const firstHeader of [false, true]) {
    const rows = [
      ...(firstHeader ? [row([cell("顶", {}, true), cell("顶", {}, true)])] : []),
      row([cell("行标题", {}, true), cell("正文")]),
      row([cell("中部", {}, true), cell("中部", {}, true)])
    ]
    assert.deepEqual(analyzeTablePagination(table(rows), 0).headerRows, firstHeader ? [0] : [])
  }
})

test("纵向合并表头不重复，被覆盖的纯表头行不能单独作为重复表头", () => {
  const node = table([
    row([cell("两行标题", { rowspan: 2 }, true), cell("另一列", {}, true)]),
    row([cell("第二行", {}, true)]), row([cell("a"), cell("b")])
  ])
  const result = analyzeTablePagination(node, 11)
  assert.deepEqual(result.headerRows, [])
  assert.deepEqual(ranges(result), [[0, 1], [2, 2]])
})

test("普通纯表头之后的纵向合并终止表头区，保留前面已确认的表头", () => {
  const node = table([
    row([cell("标题", {}, true), cell("标题", {}, true)]),
    row([cell("两行标题", { rowspan: 2 }, true), cell("第二组", {}, true)]),
    row([cell("尾格", {}, true)]), row([cell("a"), cell("b")])
  ])
  const result = analyzeTablePagination(node, 0)
  assert.deepEqual(result.headerRows, [0])
  assert.deepEqual(ranges(result), [[0, 0], [1, 2], [3, 3]])
})

test("rowspan 重叠和连锁合并为完整行组，后续无关行仍能独立分页", () => {
  const node = table([
    row([cell("A", { rowspan: 3 }), cell("b"), cell("c")]),
    row([cell("B", { rowspan: 3 }), cell("d")]),
    row([cell("C", { rowspan: 3 })]),
    row([cell("e")]), row([cell("f"), cell("g")]),
    row([cell("h"), cell("i"), cell("j")])
  ])
  assert.equal(TableMap.get(node).problems, null)
  const result = analyzeTablePagination(node, 23)
  assert.deepEqual(ranges(result), [[0, 4], [5, 5]])
  assert.equal(result.groups[0].nodeSize, Array.from({ length: 5 }, (_value, index) => node.child(index).nodeSize).reduce((sum, size) => sum + size, 0))
  assert.equal(result.groups[1].pos, 24 + result.groups[0].nodeSize)
})

test("互不重叠的相邻 rowspan 形成两个行组，完全被上行覆盖的空行仍包含在组内", () => {
  const node = table([
    row([cell("A", { rowspan: 2, colspan: 2 })]), row([]),
    row([cell("B", { rowspan: 2, colspan: 2 })]), row([]),
    row([cell("c"), cell("d")])
  ])
  const result = analyzeTablePagination(node, 0)
  assert.equal(result.columns, 2)
  assert.deepEqual(ranges(result), [[0, 1], [2, 3], [4, 4]])
  assert.deepEqual(result.headerRows, [])
})

test("超出表格的 rowspan、缺格、覆盖碰撞与空表都回退整表展开", () => {
  const invalid = [
    table([row([cell("越界", { rowspan: 3 }), cell()]), row([cell()])]),
    table([row([cell(), cell()]), row([cell()])]),
    table([row([cell(), cell("跨行", { rowspan: 2 }), cell()]), row([cell("冲突", { colspan: 2 })])]),
    table([row([])]), table([])
  ]
  for (const node of invalid) {
    assert.ok(TableMap.get(node).problems?.length)
    const before = node.toJSON()
    assert.equal(analyzeTablePagination(node, 0), null)
    assert.deepEqual(node.toJSON(), before)
  }
})

test("列宽不一致的 TableMap 等待结构修复，不能静默拆成可分页行", () => {
  const node = table([row([cell("a", { colwidth: [100] })]), row([cell("b", { colwidth: [140] })])])
  assert.ok(TableMap.get(node).problems.some(problem => problem.type === "colwidth mismatch"))
  assert.equal(analyzeTablePagination(node, 0), null)
})

test("非法跨度和非表格或无效绝对位置不进入 TableMap，也不抛出到编辑视图", () => {
  for (const attrs of [{ rowspan: 0 }, { rowspan: -1 }, { rowspan: 1.5 }, { rowspan: Infinity },
    { colspan: 0 }, { colspan: -1 }, { colspan: 1.5 }, { colspan: Infinity }]) {
    assert.equal(analyzeTablePagination(table([row([cell("bad", attrs)])]), 0), null)
  }
  const node = table([row([cell()])])
  for (const pos of [-1, 1.5, Infinity, NaN, "1", Number.MAX_SAFE_INTEGER]) assert.equal(analyzeTablePagination(node, pos), null)
  for (const other of [null, undefined, paragraph("正文"), {}, { type: { spec: {} } }]) assert.equal(analyzeTablePagination(other, 0), null)
})

test("单元格的长文本、多个段落和嵌套表格只影响 nodeSize，不影响外层行组或表头", () => {
  const nested = table([row([cell("内层", { rowspan: 2 })]), row([])])
  const node = table([
    row([cell("", {}, true, [paragraph("前段"), nested, paragraph("后段".repeat(20))]), cell("外层列", {}, true)]),
    row([cell("正文", {}, false, [paragraph("第一段"), paragraph("第二段")]), cell("尾格")])
  ])
  const result = analyzeTablePagination(node, 101)
  assert.equal(result.columns, 2)
  assert.deepEqual(result.headerRows, [0])
  assert.deepEqual(ranges(result), [[0, 0], [1, 1]])
  assert.equal(result.groups[0].pos, 102)
  assert.equal(result.groups[1].pos, 102 + node.firstChild.nodeSize)
  assert.equal(result.groups[0].nodeSize + result.groups[1].nodeSize, node.content.size)
})

test("只读分析不修改节点属性或序列化内容，返回结果也不共享输入的属性数组", () => {
  const node = table([row([cell("头", { colspan: 2, colwidth: [90, 110] }, true)]),
    row([cell("a", { colwidth: [90] }), cell("b", { colwidth: [110] })])])
  const before = node.toJSON()
  node.descendants(child => { if (child.attrs.colwidth) Object.freeze(child.attrs.colwidth); Object.freeze(child.attrs) })
  const first = analyzeTablePagination(node, 8)
  first.headerRows.push(9)
  first.groups[0].pos = 999
  const second = analyzeTablePagination(node, 8)
  assert.deepEqual(second.headerRows, [0])
  assert.equal(second.groups[0].pos, 9)
  assert.deepEqual(node.toJSON(), before)
})
