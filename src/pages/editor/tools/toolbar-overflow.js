/**
 * 用纯数值计算工具栏溢出箭头状态与分页滚动目标，避免组件内重复处理浏览器尺寸差异。
 * 输入先规范化，滚动位置被限制到可用范围；一像素容差吸收布局舍入误差。
 */
const SCROLL_TOLERANCE = 1

// 尺寸和滚动量只接受有限非负数，NaN/无穷值用 0 回退，避免传播到箭头禁用状态或滚动 API。
function nonNegative(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

// 分别使用完整可用宽度判断是否溢出、当前可见宽度判断能向哪里滚动，防止箭头占位造成循环误判。
export function getToolbarOverflowState({ scrollLeft, scrollWidth, clientWidth, availableWidth = clientWidth }) {
  const width = nonNegative(scrollWidth)
  const visible = nonNegative(clientWidth)
  const available = nonNegative(availableWidth)
  const maximum = Math.max(0, width - visible)
  const left = Math.min(maximum, nonNegative(scrollLeft))
  // 用完整容器宽度判断是否需要箭头，否则箭头自己的占位会在窗口变宽后制造持续的假溢出。
  const hasOverflow = available > 0 && width > available + SCROLL_TOLERANCE
  return {
    hasOverflow,
    canScrollLeft: hasOverflow && left > SCROLL_TOLERANCE,
    canScrollRight: hasOverflow && maximum - left > SCROLL_TOLERANCE
  }
}

// 每次按一个当前可见宽度移动并钳制到两端；未知方向返回当前位置，不触发意外反向滚动。
export function getToolbarPageScroll({ scrollLeft, scrollWidth, clientWidth }, direction) {
  const maximum = Math.max(0, nonNegative(scrollWidth) - nonNegative(clientWidth))
  const left = Math.min(maximum, nonNegative(scrollLeft))
  const page = nonNegative(clientWidth)
  const step = direction === "left" ? -page : direction === "right" ? page : 0
  return Math.max(0, Math.min(maximum, left + step))
}
