/**
 * 验证工具栏的溢出判断、箭头边界和按可见宽度分页滚动。
 * 完整可用宽度与箭头占位后的可见宽度分开，浏览器小数/负值和旧 scrollLeft 都必须安全规范化。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { getToolbarOverflowState, getToolbarPageScroll } from "../src/pages/editor/tools/toolbar-overflow.js"

// 故意让可见宽度仍不足但完整容器已足够，检出箭头占位导致自身持续出现的反馈循环。
test("工具栏溢出按完整容器判断，箭头占位不会在窗口变宽后制造假溢出", () => {
  assert.deepEqual(getToolbarOverflowState({ scrollLeft: 0, scrollWidth: 900, clientWidth: 800, availableWidth: 830 }), {
    hasOverflow: true, canScrollLeft: false, canScrollRight: true
  })
  assert.deepEqual(getToolbarOverflowState({ scrollLeft: 30, scrollWidth: 900, clientWidth: 870, availableWidth: 930 }), {
    hasOverflow: false, canScrollLeft: false, canScrollRight: false
  })
  assert.deepEqual(getToolbarOverflowState({ scrollLeft: 0, scrollWidth: 500, clientWidth: 0, availableWidth: 0 }), {
    hasOverflow: false, canScrollLeft: false, canScrollRight: false
  })
})

// 包含负数、接近端点和超出最大值，保证一像素容差及钳制同时影响两个箭头状态。
test("滚动边界考虑小数误差、浏览器负值和内容缩小后过期的 scrollLeft", () => {
  const state = scrollLeft => getToolbarOverflowState({ scrollLeft, scrollWidth: 1400, clientWidth: 800, availableWidth: 830 })
  assert.deepEqual(state(-2), { hasOverflow: true, canScrollLeft: false, canScrollRight: true })
  assert.deepEqual(state(0.75), { hasOverflow: true, canScrollLeft: false, canScrollRight: true })
  assert.deepEqual(state(120), { hasOverflow: true, canScrollLeft: true, canScrollRight: true })
  assert.deepEqual(state(599.5), { hasOverflow: true, canScrollLeft: true, canScrollRight: false })
  assert.deepEqual(state(2000), { hasOverflow: true, canScrollLeft: true, canScrollRight: false })
})

test("翻页使用当前可见宽度且限制在真实滚动范围，不依赖固定屏幕分辨率", () => {
  const metrics = { scrollLeft: 100, scrollWidth: 2000, clientWidth: 714 }
  assert.equal(getToolbarPageScroll(metrics, "right"), 814)
  assert.equal(getToolbarPageScroll(metrics, "left"), 0)
  assert.equal(getToolbarPageScroll({ ...metrics, scrollLeft: 1000 }, "right"), 1286)
  assert.equal(getToolbarPageScroll({ ...metrics, scrollLeft: 1000 }, "left"), 286)
  assert.equal(getToolbarPageScroll({ scrollLeft: 1000, scrollWidth: 700, clientWidth: 800 }, "right"), 0)
  assert.equal(getToolbarPageScroll(metrics, "unknown"), 100)
})
