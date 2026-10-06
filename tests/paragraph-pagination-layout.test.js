/**
 * 段内分页的纯几何合同：每行来自真实浏览器测量，不凭文字长度猜行数。
 * 行断点只属于编辑视图；首末段距、保护约束和超高行退化必须保留原文的自然坐标。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { planPagePagination } from "../src/pages/editor/tools/page-pagination.js"

const settings = { enabled: true, pageHeightPx: 500, marginTopPx: 50, marginBottomPx: 50, gapPx: 24 }
const block = (pos, height, extra = {}) => ({ pos, nodeSize: 5, height, type: "paragraph", marginTop: 0, marginBottom: 0, ...extra })
const manual = pos => block(pos, 0, { nodeSize: 1, type: "pageBreak" })
const lines = (pos, heights, { marginTop = 0, marginBottom = 0, keepWithNext = false, type = "paragraph", start } = {}) => {
  let cursor = start
  return heights.map((height, index) => {
    const top = index === 0 ? marginTop : 0
    const bottom = index === heights.length - 1 ? marginBottom : 0
    const naturalStart = cursor === undefined ? undefined : cursor + top
    if (naturalStart !== undefined) cursor = naturalStart + height + bottom
    return block(index === 0 ? pos : pos + 1 + index * 10, height, {
      nodeSize: 10, type, marginTop: top, marginBottom: bottom,
      ...(naturalStart !== undefined && { start: naturalStart }),
      keepWithNext: index === heights.length - 1 && keepWithNext,
      paragraph: { pos, firstLine: index, lastLine: index, lineCount: heights.length }
    })
  })
}
const pageIndexes = layout => layout.placements.map(placement => placement.pageIndex)
const tops = layout => layout.placements.map(placement => placement.top)

test("同一段的续行跨页保留原段身份，断点只在当前行字符位置", () => {
  const input = lines(0, [160, 160, 160])
  const snapshot = structuredClone(input)
  const layout = planPagePagination(input, settings)
  assert.deepEqual(pageIndexes(layout), [0, 0, 1])
  assert.deepEqual(tops(layout), [50, 210, 574])
  assert.deepEqual(layout.breaks, [{ pos: 21, height: 204, pageIndex: 1, reason: "automatic", paragraphPos: 0, paragraphLine: 2 }])
  assert.equal(layout.overflowCount, 0)
  assert.deepEqual(input, snapshot, "分页不能将原段拆成持久节点或改写行元数据")
})

test("段落首行放不下时在段前换页，使用顶层断点而非段内空隙", () => {
  const layout = planPagePagination([block(0, 360), ...lines(5, [80, 80])], settings)
  assert.deepEqual(pageIndexes(layout), [0, 1, 1])
  assert.deepEqual(tops(layout), [50, 574, 654])
  assert.deepEqual(layout.breaks, [{ pos: 5, height: 164, pageIndex: 1, reason: "automatic" }])
})

test("段前距只用于首行，段后距只用于末行，续页不能重复首行缩进预算", () => {
  const layout = planPagePagination(lines(0, [120, 120, 120, 120], { marginTop: 20, marginBottom: 15 }), settings)
  assert.deepEqual(tops(layout), [70, 190, 310, 574])
  assert.equal(layout.breaks[0].height, 144)
  assert.equal(layout.breaks[0].paragraphLine, 3)
  assert.equal(layout.contentHeight, 659)
  assert.equal(layout.placements.at(-1).top + 120 + 15, 709)
})

test("末行段后距参与页底预算，不能把正文后的有效空白挤进页脚", () => {
  const layout = planPagePagination(lines(0, [100, 100, 170], { marginBottom: 40 }), settings)
  assert.deepEqual(pageIndexes(layout), [0, 0, 1])
  assert.equal(layout.placements.at(-1).top, 574)
  assert.equal(layout.breaks[0].paragraphLine, 2)
})

test("段后普通块继续使用自然起点，已有段内装饰高度只增加一次", () => {
  const layout = planPagePagination([...lines(0, [160, 160, 160], { marginBottom: 18 }), block(32, 80, { marginTop: 12 })], settings)
  assert.deepEqual(pageIndexes(layout), [0, 0, 1, 1])
  assert.equal(layout.placements.at(-1).top, 574 + 160 + 18 + 12)
  assert.equal(layout.breaks.length, 1)
  assert.equal(layout.contentHeight, 794)
})

test("超高单行或行内原子内容独占展开页，前后普通行恢复正常页高", () => {
  const layout = planPagePagination(lines(0, [120, 650, 90]), settings)
  assert.deepEqual(pageIndexes(layout), [0, 1, 2])
  assert.deepEqual(layout.pages.map(page => page.height), [500, 750, 500])
  assert.deepEqual(tops(layout), [50, 574, 1348])
  assert.deepEqual(layout.breaks.map(gap => [gap.reason, gap.paragraphPos, gap.paragraphLine]), [["overflow", 0, 1], ["automatic", 0, 2]])
  assert.equal(layout.overflowCount, 1)
  assert.equal(layout.placements[1].top + 650, layout.pages[1].top + layout.pages[1].height - 50)
})

test("首行超高时原段从首张纸完整展开，后续行仍能独立回到标准纸面", () => {
  const layout = planPagePagination(lines(0, [650, 80], { marginTop: 20 }), settings)
  assert.deepEqual(layout.pages.map(page => page.height), [770, 500])
  assert.equal(layout.pages[0].overflow, true)
  assert.equal(layout.placements[0].top, 70)
  assert.equal(layout.breaks[0].paragraphLine, 1)
  assert.equal(layout.breaks[0].paragraphPos, 0)
})

test("keepWithNext 只由末行连接下一段首行，不强迫长段全部进入一页", () => {
  const layout = planPagePagination([...lines(0, [170, 170], { keepWithNext: true }), ...lines(22, [100, 100])], settings)
  assert.deepEqual(pageIndexes(layout), [0, 1, 1, 1])
  assert.deepEqual(tops(layout), [50, 574, 744, 844])
  assert.equal(layout.breaks[0].paragraphPos, 0)
  assert.equal(layout.breaks[0].paragraphLine, 1)
  assert.equal(layout.constraintCount, 0)
})

test("标题末行同下段的明确保护仍可跨段内断点，首行身份保持标题", () => {
  const input = [...lines(0, [170, 170], { type: "heading", keepWithNext: true }), ...lines(22, [100, 100])]
  const layout = planPagePagination(input, settings)
  assert.deepEqual(pageIndexes(layout), [0, 1, 1, 1])
  assert.deepEqual(layout.placements.map(item => item.type), ["heading", "heading", "paragraph", "paragraph"])
  assert.equal(layout.breaks[0].paragraphPos, 0)
})

test("无法满足的末行同页链有限退化，不凭保护约束生成空白页", () => {
  const layout = planPagePagination([...lines(0, [100, 250], { keepWithNext: true }), ...lines(22, [250])], settings)
  assert.equal(layout.constraintCount, 1)
  assert.deepEqual(pageIndexes(layout), [0, 0, 1])
  assert.equal(layout.pageCount, 2)
  assert.equal("paragraphPos" in layout.breaks[0], false, "下一段首行移动应使用段前断点")
})

test("段内分页与手动页衔接不吞首尾空页，也不携带上一段的续行身份", () => {
  const layout = planPagePagination([manual(0), ...lines(1, [160, 160, 160]), manual(33), block(34, 80)], settings)
  assert.deepEqual(layout.breaks.map(gap => gap.reason), ["manual", "automatic", "manual"])
  assert.equal(layout.breaks[1].paragraphPos, 1)
  assert.equal("paragraphPos" in layout.breaks[0], false)
  assert.equal("paragraphPos" in layout.breaks[2], false)
  assert.equal(layout.placements.at(-1).pageIndex, 3)
})

test("首尾显式小数自然坐标优先，不把声明段距重新累加到续行", () => {
  const input = lines(0, [160.0625, 160.0625, 160.0625], { marginTop: 0.666667, marginBottom: 0.666667, start: 0 })
  input[0].start = 0.625
  input[1].start = 160.6875
  input[2].start = 320.75
  const layout = planPagePagination(input, settings)
  assert.equal(layout.placements[0].top, 50.625)
  assert.equal(layout.placements[1].top, 210.6875)
  assert.equal(layout.placements[2].top, 574)
})

test("段内间隙的真实小数高度保留校准，并在used-height一致后收敛", () => {
  const geometry = { ...settings, pageHeightPx: 500.125, gapPx: 24.0625 }
  const input = lines(0, [160.0625, 160.0625, 160.0625])
  const initial = planPagePagination(input, geometry)
  const target = initial.breaks[0].height
  const corrected = planPagePagination(input, geometry, [{ ...initial.breaks[0], actualHeight: target - 0.1875 }])
  assert.equal(corrected.breaks[0].height, target + 0.1875)
  assert.equal(corrected.breaks[0].paragraphPos, 0)
  assert.equal(corrected.breaks[0].paragraphLine, 2)
  const stable = planPagePagination(input, geometry, [{ ...corrected.breaks[0], actualHeight: target }])
  assert.deepEqual(stable, corrected)
  assert.equal(stable.placements[2].top, stable.pages[1].top + 50)
})

test("空文本行仍按实测行高占位，规划器不因没有字符内容吞掉空行", () => {
  const layout = planPagePagination(lines(0, Array(15).fill(28)), settings)
  assert.equal(layout.placements.length, 15)
  assert.equal(layout.pageCount, 2)
  assert.equal(layout.breaks[0].paragraphLine, 14)
  assert.equal(layout.placements.at(-1).top, 574)
})

test("小页间距为段内空行保留父级 strut 高度，续页额外留白可稳定收敛", () => {
  for (const gapPx of [0, 24]) {
    const geometry = { ...settings, pageHeightPx: 200, marginTopPx: 0, marginBottomPx: 0, gapPx }
    const input = lines(0, [100, 100, 100]).map(line => ({ ...line, minimumGap: 100 }))
    const layout = planPagePagination(input, geometry)
    assert.deepEqual(pageIndexes(layout), [0, 0, 1])
    assert.equal(layout.breaks[0].height, 100)
    assert.equal(layout.placements[2].top, 300)
    assert.equal(layout.pages[1].top, 200 + gapPx)
    assert.equal(layout.placements[2].top - layout.pages[1].top, 100 - gapPx)
    assert.deepEqual(planPagePagination(input, geometry, [{ ...layout.breaks[0], actualHeight: 100 }]), layout,
      "浏览器已经实现父级最小行高时，不能每次重排继续追逐更小的不可实现空隙")
  }
})

test("minimumGap 必须为非负有限尺寸，首行顶层断点不受段内 strut 约束", () => {
  const original = lines(0, [120, 120])[1]
  for (const minimumGap of [NaN, Infinity, -1, "28", null]) {
    assert.throws(() => planPagePagination([{ ...original, minimumGap }], settings), /分页块尺寸/)
  }
  assert.doesNotThrow(() => planPagePagination([{ ...original, minimumGap: 0 }], settings))
  const input = [block(0, 360), ...lines(5, [80, 80]).map(line => ({ ...line, minimumGap: 1000 }))]
  const layout = planPagePagination(input, settings)
  assert.equal(layout.breaks[0].height, 164)
  assert.equal("paragraphPos" in layout.breaks[0], false)
})

test("段内最小 strut 的额外留白挤出续页预算时展开当前页，后续普通行恢复标准纸高", () => {
  const geometry = { ...settings, marginTopPx: 0, marginBottomPx: 0, gapPx: 24 }
  const input = lines(0, [490, 490, 80]).map((line, index) => ({ ...line, minimumGap: index < 2 ? 490 : 80 }))
  const layout = planPagePagination(input, geometry)
  assert.deepEqual(layout.pages.map(page => ({ top: page.top, height: page.height, overflow: page.overflow })), [
    { top: 0, height: 500, overflow: false },
    { top: 524, height: 946, overflow: true },
    { top: 1494, height: 500, overflow: false }
  ])
  assert.deepEqual(pageIndexes(layout), [0, 1, 2])
  assert.deepEqual(tops(layout), [0, 980, 1550])
  assert.equal(layout.breaks[0].height, 490)
  assert.equal(layout.breaks[1].height, 80)
  assert.equal(layout.placements[1].top + layout.placements[1].height, layout.pages[1].top + layout.pages[1].height,
    "不能仅夹住空隙最小行高却仍让实际续行越过声明的纸面底边")
  assert.equal(layout.overflowCount, 1)
  assert.equal(layout.status, "expanded")
  assert.equal(layout.contentHeight, 1630)
})

test("最小 strut 留白使原本可放下的 keepWithNext 链超预算时报告有限退化", () => {
  const geometry = { ...settings, marginTopPx: 0, marginBottomPx: 0, gapPx: 24 }
  const input = [...lines(0, [490, 90], { keepWithNext: true }).map(line => ({ ...line, minimumGap: 90 })), block(22, 410)]
  const layout = planPagePagination(input, geometry)
  assert.equal(layout.constraintCount, 1, "声明链预算通过后新增的续页留白也必须计入可满足性")
  assert.deepEqual(pageIndexes(layout), [0, 1, 2])
  assert.equal(layout.overflowCount, 0, "不可满足的保护链不能强制扩大整条链所在页")
  assert.ok(layout.pages.every(page => page.height === 500 && !page.overflow))
  for (const placement of layout.placements) {
    const page = layout.pages[placement.pageIndex]
    assert.ok(placement.top >= page.top && placement.top + placement.height <= page.top + page.height,
      "退化到逐块排版后仍必须把每块真实内容留在声明的纸面范围内")
  }
  assert.equal(layout.breaks[0].paragraphPos, 0)
  assert.equal(layout.breaks[0].paragraphLine, 1)
  assert.equal("paragraphPos" in layout.breaks[1], false, "保护链的后块按自己的顶层边界换页")
})

test("损坏的段落身份、行索引与总行数拒绝，不能装饰未知正文位置", () => {
  const original = lines(0, [120, 120])[1]
  for (const paragraph of [null, [], { ...original.paragraph, pos: -1 }, { ...original.paragraph, firstLine: -1 },
    { ...original.paragraph, lastLine: 0 }, { ...original.paragraph, firstLine: 0.5 }, { ...original.paragraph, lineCount: 0 },
    { ...original.paragraph, lastLine: 2 }, { ...original.paragraph, lineCount: Infinity }]) {
    assert.throws(() => planPagePagination([{ ...original, paragraph }], settings), /段落|行尺寸|行组/)
  }
})
