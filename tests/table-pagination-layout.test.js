/**
 * 表格跨页的纯几何合同：原始行始终只排一次，重复表头仅占视图装饰高度。
 * 这些夹具明确给出行组的自然尺寸，真实列宽、字体与 rowspan 结构由浏览器和结构专项验收。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { planPagePagination } from "../src/pages/editor/tools/page-pagination.js"

const settings = { enabled: true, pageHeightPx: 500, marginTopPx: 50, marginBottomPx: 50, gapPx: 24 }
const block = (pos, height, extra = {}) => ({ pos, nodeSize: 5, height, type: "paragraph", marginTop: 0, marginBottom: 0, ...extra })
const manual = pos => block(pos, 0, { nodeSize: 1, type: "pageBreak" })
const rows = (pos, heights, { headerCount = 0, columns = 3, marginTop = 0, marginBottom = 0, keepHeader = false } = {}) => {
  const headerRows = Array.from({ length: headerCount }, (_, index) => pos + 1 + index * 10)
  const headerHeight = heights.slice(0, headerCount).reduce((sum, height) => sum + height, 0)
  return heights.map((height, index) => block(pos + 1 + index * 10, height, {
    nodeSize: 10, type: "tableRow", marginTop: index === 0 ? marginTop : 0, marginBottom: index === heights.length - 1 ? marginBottom : 0,
    keepWithNext: keepHeader && index < headerCount,
    table: { pos, firstRow: index, columns, headerRows, headerHeight }
  }))
}
const pagesFor = layout => layout.placements.map(item => item.pageIndex)
const topsFor = layout => layout.placements.map(item => item.top)

test("无表头的多行表格按完整行换页，表内断点保留逻辑列数和空表头合同", () => {
  const input = rows(0, [150, 150, 150], { marginTop: 18, marginBottom: 18 })
  const snapshot = structuredClone(input)
  const layout = planPagePagination(input, settings)
  assert.deepEqual(pagesFor(layout), [0, 0, 1])
  assert.deepEqual(topsFor(layout), [68, 218, 574])
  assert.deepEqual(layout.breaks, [{ pos: 21, height: 206, pageIndex: 1, reason: "automatic", tablePos: 0, columns: 3, headerRows: [], headerHeight: 0 }])
  assert.equal(layout.overflowCount, 0)
  assert.deepEqual(input, snapshot, "规划不能更改资源合同或原始表头数组")
})

test("首行装不下时整体表格在顶层换页，原始表头不重复", () => {
  const layout = planPagePagination([block(0, 360), ...rows(5, [100, 120], { headerCount: 1, marginTop: 18 })], settings)
  assert.deepEqual(pagesFor(layout), [0, 1, 1])
  assert.deepEqual(layout.breaks, [{ pos: 5, height: 164, pageIndex: 1, reason: "automatic" }])
  assert.deepEqual(topsFor(layout), [50, 592, 692])
})

test("表内跨页重复连续表头，总空隙与正文行坐标均包含表头高度", () => {
  const layout = planPagePagination(rows(0, [40, 160, 160, 160], { headerCount: 1 }), settings)
  assert.deepEqual(pagesFor(layout), [0, 0, 0, 1])
  assert.deepEqual(topsFor(layout), [50, 90, 250, 614])
  assert.deepEqual(layout.breaks, [{ pos: 31, height: 204, pageIndex: 1, reason: "automatic", tablePos: 0, columns: 3, headerRows: [1], headerHeight: 40 }])
  assert.equal(layout.contentHeight, 724)
})

test("多行表头整链及首条正文移到下一页时使用表格顶层断点，之后全部表头重复", () => {
  const input = [block(0, 310), ...rows(5, [30, 40, 80, 220, 220], { headerCount: 2, keepHeader: true })]
  const layout = planPagePagination(input, settings)
  assert.deepEqual(pagesFor(layout), [0, 1, 1, 1, 1, 2])
  assert.equal(layout.breaks[0].pos, 5)
  assert.equal("tablePos" in layout.breaks[0], false)
  assert.deepEqual(layout.breaks[1].headerRows, [6, 16])
  assert.equal(layout.breaks[1].headerHeight, 70)
  assert.equal(layout.placements.at(-1).top, layout.pages[2].top + 50 + 70)
  assert.equal(layout.constraintCount, 0)
})

test("表头自身换页不能重复尚未完整排出的表头，完整正文续页才重复", () => {
  const layout = planPagePagination(rows(0, [220, 220, 160, 160], { headerCount: 2 }), settings)
  assert.equal(layout.breaks[0].pos, 11)
  assert.equal(layout.breaks[0].headerHeight, 0)
  assert.equal(layout.breaks.at(-1).headerHeight, 0, "440px 表头装不进标准正文区时不能覆盖正文")
  assert.equal(layout.overflowCount, 0)
})

test("正文行组能装下但加表头装不下时只省略本页重复表头，最后段后距也参与预算", () => {
  const layout = planPagePagination(rows(0, [80, 300, 320], { headerCount: 1, marginBottom: 5 }), settings)
  assert.deepEqual(pagesFor(layout), [0, 0, 1])
  assert.equal(layout.breaks[0].headerHeight, 0)
  assert.deepEqual(layout.breaks[0].headerRows, [1])
  assert.equal(layout.placements[2].top, layout.pages[1].top + 50)
  assert.equal(layout.pages[1].height, 500)
})

test("超高 rowspan 行组保持完整且独占展开页，不再堆叠重复头部", () => {
  const input = rows(0, [40, 100, 700, 100], { headerCount: 1 })
  input[2].nodeSize = 30
  input[2].table.firstRow = 2
  input[3].pos = 51
  input[3].table.firstRow = 5
  const layout = planPagePagination(input, settings)
  assert.deepEqual(pagesFor(layout), [0, 0, 1, 2])
  assert.deepEqual(layout.pages.map(page => page.height), [500, 800, 500])
  assert.equal(layout.breaks[0].reason, "overflow")
  assert.equal(layout.breaks[0].headerHeight, 0)
  assert.equal(layout.breaks[1].headerHeight, 40)
  assert.equal(layout.overflowCount, 1)
  assert.equal(layout.placements[2].top + 700, layout.pages[1].top + 800 - 50)
})

test("整表首行超高时顶层断点不含表内元数据，随后普通段落恢复标准纸面", () => {
  const layout = planPagePagination([block(0, 80), ...rows(5, [710], { headerCount: 1, marginTop: 18, marginBottom: 18 }), block(16, 70)], settings)
  assert.deepEqual(pagesFor(layout), [0, 1, 2])
  assert.equal(layout.breaks[0].pos, 5)
  assert.equal("tablePos" in layout.breaks[0], false)
  assert.equal(layout.pages[1].height, 846)
  assert.equal("tablePos" in layout.breaks[1], false)
  assert.equal(layout.pages[2].height, 500)
})

test("表后段落采用原自然流坐标，已有重复头部只计一次", () => {
  const layout = planPagePagination([...rows(0, [50, 180, 180, 180], { headerCount: 1, marginBottom: 18 }), block(42, 50, { marginTop: 12 })], settings)
  assert.deepEqual(pagesFor(layout), [0, 0, 1, 2, 2])
  assert.equal(layout.breaks.filter(gap => gap.tablePos !== undefined).length, 2)
  assert.equal(layout.placements.at(-1).top, layout.placements.at(-2).top + 180 + 18 + 12)
})

test("手动分页连接跨页表格时不吞边界、不重复原始表头，也不携带旧表的续页元数据", () => {
  const layout = planPagePagination([manual(0), ...rows(1, [40, 190, 190], { headerCount: 1 }), manual(33), block(34, 80)], settings)
  assert.deepEqual(layout.breaks.map(gap => gap.reason), ["manual", "automatic", "manual"])
  assert.equal(layout.breaks[0].pos, 1)
  assert.equal("tablePos" in layout.breaks[0], false)
  assert.equal(layout.breaks[1].headerHeight, 40)
  assert.equal("tablePos" in layout.breaks[2], false)
  assert.equal(layout.placements.at(-1).pageIndex, 3)
})

test("续表头装饰的小数实测高度保留校准，并在相同 used-height 下收敛", () => {
  const fractional = { ...settings, pageHeightPx: 500.125, gapPx: 24.0625 }
  const input = rows(0, [40.03125, 160.0625, 160.0625, 160.0625], { headerCount: 1 })
  const initial = planPagePagination(input, fractional)
  const target = initial.breaks[0].height
  const observed = [{ ...initial.breaks[0], actualHeight: target - 0.1875 }]
  const corrected = planPagePagination(input, fractional, observed)
  assert.equal(corrected.breaks[0].height, target + 0.1875)
  assert.equal(corrected.breaks[0].headerHeight, 40.03125)
  const stable = planPagePagination(input, fractional, [{ ...corrected.breaks[0], actualHeight: target }])
  assert.deepEqual(stable, corrected)
  assert.equal(stable.placements.at(-1).top, stable.pages[1].top + 50 + 40.03125)
})

test("非法表格行组合同拒绝，不让未知列数或损坏表头尺寸进入装饰", () => {
  const original = rows(0, [40, 160], { headerCount: 1 })[1]
  for (const table of [null, [], { ...original.table, pos: -1 }, { ...original.table, firstRow: 0.5 },
    { ...original.table, columns: 0 }, { ...original.table, headerRows: [1, "11"] }, { ...original.table, headerHeight: Infinity }]) {
    assert.throws(() => planPagePagination([{ ...original, table }], settings), /表格行组/)
  }
})
