/**
 * 递归容器扁平测量后的分页合同：叶块保留真实模型位置，断点可提升到合法列表项或容器边界。
 * 纯几何不猜 DOM 结构；原容器的首尾 padding/title 与自然间距由测量器分配一次。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { planPagePagination } from "../src/pages/editor/tools/page-pagination.js"

const settings = { enabled: true, pageHeightPx: 500, marginTopPx: 50, marginBottomPx: 50, gapPx: 24 }
const leaf = (pos, height, extra = {}) => ({ pos, nodeSize: 10, type: "paragraph", height, marginTop: 0, marginBottom: 0, ...extra })
const indexes = layout => layout.placements.map(item => item.pageIndex)
const line = (pos, height, paragraphPos, firstLine, lineCount, extra = {}) => leaf(pos, height,
  { paragraph: { pos: paragraphPos, firstLine, lastLine: firstLine, lineCount }, ...extra })
const codeLine = (pos, height, codePos, firstLine, lineCount, extra = {}) => leaf(pos, height,
  { type: "codeBlock", code: { pos: codePos, firstLine, lastLine: firstLine, lineCount }, ...extra })

test("列表项首叶换页提升到真实 LI token，规划位置仍保留原段落身份", () => {
  const input = [leaf(0, 300), line(12, 200, 12, 0, 1, { boundary: { pos: 10, kind: "list" } })]
  const before = structuredClone(input)
  const layout = planPagePagination(input, settings)
  assert.deepEqual(layout.breaks, [{ pos: 10, height: 224, pageIndex: 1, reason: "automatic", listPagination: true }])
  assert.deepEqual(indexes(layout), [0, 1])
  assert.equal(layout.placements[1].pos, 12)
  assert.equal(layout.placements[1].top, 574)
  assert.deepEqual(input, before, "合法视图边界不能改写原列表节点或叶块位置")
})

test("文本框或详情首叶提升到外层容器，首部 padding/title 仅在初次进入时预算", () => {
  const layout = planPagePagination([leaf(0, 360), leaf(30, 80, { marginTop: 20, boundary: { pos: 8, kind: "block" } }), leaf(40, 60)], settings)
  assert.deepEqual(layout.breaks, [{ pos: 8, height: 164, pageIndex: 1, reason: "automatic", containerPagination: true }])
  assert.deepEqual(indexes(layout), [0, 1, 1])
  assert.equal(layout.placements[1].top, 594)
  assert.equal(layout.placements[2].top, 674, "后续叶块不能重复首部外壳或摘要预算")
})

test("同一列表项的长段续行保留段内 SPAN 断点，不重新制造 LI 或编号", () => {
  const layout = planPagePagination([line(12, 180, 12, 0, 3, { boundary: { pos: 10, kind: "list" } }),
    line(23, 180, 12, 1, 3), line(33, 180, 12, 2, 3)], settings)
  assert.deepEqual(indexes(layout), [0, 0, 1])
  assert.deepEqual(layout.breaks, [{ pos: 33, height: 164, pageIndex: 1, reason: "automatic", paragraphPos: 12, paragraphLine: 2 }])
  assert.equal("listPagination" in layout.breaks[0], false)
})

test("续行内部边界优先于外层 boundary，不能把当前列表项的前文一起重新移动", () => {
  const layout = planPagePagination([line(12, 300, 12, 0, 2),
    line(23, 200, 12, 1, 2, { boundary: { pos: 10, kind: "list" } })], settings)
  assert.equal(layout.breaks[0].pos, 23)
  assert.equal(layout.breaks[0].paragraphPos, 12)
  assert.equal("listPagination" in layout.breaks[0], false)
})

test("超高原子叶块在合法 DIV 边界独占展开页，后续外部段落回到标准纸型", () => {
  const layout = planPagePagination([leaf(0, 120), leaf(8, 650, { type: "media", boundary: { pos: 5, kind: "block" } }), leaf(20, 80)], settings)
  assert.deepEqual(indexes(layout), [0, 1, 2])
  assert.deepEqual(layout.pages.map(page => page.height), [500, 750, 500])
  assert.equal(layout.breaks[0].pos, 5)
  assert.equal(layout.breaks[0].containerPagination, true)
  assert.equal(layout.breaks[0].reason, "overflow")
  assert.equal(layout.overflowCount, 1)
})

test("嵌套外壳的首尾预算各分配一次，末尾 padding 不能被挤进页脚", () => {
  const layout = planPagePagination([leaf(8, 320, { marginTop: 30, boundary: { pos: 0, kind: "block" } }),
    leaf(18, 80, { marginBottom: 40, boundary: { pos: 18, kind: "block" } })], settings)
  assert.deepEqual(indexes(layout), [0, 1])
  assert.equal(layout.placements[0].top, 80)
  assert.equal(layout.placements[1].top, 574)
  assert.equal(layout.breaks[0].height, 174)
  assert.equal(layout.placements[1].top + 80 + 40, 694)
})

test("容器首叶的同下叶保护预算包含 prefix，换页后仍在同一标准页", () => {
  const layout = planPagePagination([leaf(0, 300), leaf(12, 60, { type: "heading", marginTop: 20, keepWithNext: true,
    boundary: { pos: 10, kind: "block" } }), leaf(22, 80)], settings)
  assert.deepEqual(indexes(layout), [0, 1, 1])
  assert.equal(layout.breaks[0].pos, 10)
  assert.equal(layout.breaks[0].containerPagination, true)
  assert.equal(layout.constraintCount, 0)
  assert.equal(layout.placements[2].top, layout.placements[1].top + 60)
})

test("不同层级的列表与块边界不串用 metadata，后续自然流空隙只计一次", () => {
  const layout = planPagePagination([leaf(0, 300), leaf(12, 200, { boundary: { pos: 10, kind: "list" } }),
    leaf(30, 280, { boundary: { pos: 28, kind: "block" } }), leaf(40, 80)], settings)
  assert.deepEqual(indexes(layout), [0, 1, 2, 2])
  assert.equal(layout.breaks[0].listPagination, true)
  assert.equal("containerPagination" in layout.breaks[0], false)
  assert.equal(layout.breaks[1].containerPagination, true)
  assert.equal("listPagination" in layout.breaks[1], false)
  assert.equal(layout.placements[3].top, layout.placements[2].top + 280)
})

test("提升后的 boundary 位置用于小数装饰校准键，不能误用内部叶块 token", () => {
  const input = [leaf(0, 360.25, { start: 0 }), leaf(12, 80.125, { start: 360.75, marginTop: 0.5,
    boundary: { pos: 10, kind: "list" } })]
  const initial = planPagePagination(input, settings)
  const target = initial.breaks[0].height
  const corrected = planPagePagination(input, settings, [{ ...initial.breaks[0], actualHeight: target - 0.1875 }])
  assert.equal(corrected.breaks[0].pos, 10)
  assert.equal(corrected.breaks[0].height, target + 0.1875)
  assert.deepEqual(planPagePagination(input, settings, [{ ...corrected.breaks[0], actualHeight: target }]), corrected)
})

test("容器中的表格首行可提升外层断点，续页仍使用原表内 TR 与重复表头", () => {
  const table = { pos: 12, firstRow: 0, columns: 2, headerRows: [13], headerHeight: 40 }
  const layout = planPagePagination([leaf(0, 360), leaf(13, 80, { type: "tableRow", table,
    boundary: { pos: 10, kind: "list" } }), leaf(23, 350, { type: "tableRow", table: { ...table, firstRow: 1 },
      boundary: { pos: 10, kind: "list" } })], settings)
  assert.equal(layout.breaks[0].pos, 10)
  assert.equal(layout.breaks[0].listPagination, true)
  assert.equal("tablePos" in layout.breaks[0], false)
  assert.equal(layout.breaks[1].pos, 23)
  assert.equal(layout.breaks[1].tablePos, 12)
  assert.equal(layout.breaks[1].headerHeight, 40)
  assert.equal("listPagination" in layout.breaks[1], false)
})

test("代码首行仍在原 PRE 外换页，后续显式源码行使用字符位置与 code metadata", () => {
  const layout = planPagePagination([leaf(0, 360), codeLine(12, 100, 12, 0, 3, { marginTop: 16,
    boundary: { pos: 10, kind: "block" } }), codeLine(23, 180, 12, 1, 3), codeLine(33, 180, 12, 2, 3, { marginBottom: 16 })], settings)
  assert.deepEqual(indexes(layout), [0, 1, 1, 2])
  assert.equal(layout.breaks[0].pos, 10)
  assert.equal(layout.breaks[0].containerPagination, true)
  assert.equal("codePos" in layout.breaks[0], false)
  assert.equal(layout.breaks[1].pos, 33)
  assert.equal(layout.breaks[1].codePos, 12)
  assert.equal(layout.breaks[1].codeLine, 2)
  assert.equal("containerPagination" in layout.breaks[1], false)
})

test("非法 boundary 位置和种类拒绝，不能在未知或位于叶块之后的父结构插装饰", () => {
  for (const boundary of [null, [], { pos: -1, kind: "list" }, { pos: 0.5, kind: "block" }, { pos: NaN, kind: "list" },
    { pos: "1", kind: "list" }, { pos: 1, kind: "unknown" }, { pos: 1, kind: null }, { pos: 13, kind: "list" }]) {
    assert.throws(() => planPagePagination([leaf(12, 80, { boundary })], settings), /边界|分页块/)
  }
})

test("源码行元数据严格验证且不能与段落或表格行组身份重叠", () => {
  const original = codeLine(23, 80, 12, 1, 2)
  for (const code of [null, [], { ...original.code, pos: -1 }, { ...original.code, firstLine: -1 },
    { ...original.code, lastLine: 0 }, { ...original.code, firstLine: 0.5 }, { ...original.code, lineCount: 0 },
    { ...original.code, lastLine: 2 }, { ...original.code, lineCount: Infinity }]) {
    assert.throws(() => planPagePagination([{ ...original, code }], settings), /代码|源码|分页块/)
  }
  assert.throws(() => planPagePagination([{ ...original, paragraph: { pos: 12, firstLine: 1, lastLine: 1, lineCount: 2 } }], settings), /代码|源码|段落/)
  assert.throws(() => planPagePagination([{ ...original, table: { pos: 12, firstRow: 1, columns: 1, headerRows: [], headerHeight: 0 } }], settings), /代码|源码|表格/)
})
