/** 独立可见性探针，不加载 React、编辑器或测试夹具，也不修改浏览器调度行为。 */
const startedAt = performance.now()
const events = []
const samples = []
let frames = 0
let lastFrames = 0
let frame
let timer = null

const readState = () => ({
  elapsedMs: Math.round(performance.now() - startedAt),
  visibility: document.visibilityState,
  hidden: document.hidden,
  focused: document.hasFocus(),
  topLevel: window.top === window,
  frames,
  viewport: {
    width: window.innerWidth,
    height: window.innerHeight
  }
})

const recordEvent = event => {
  events.push({
    type: event.type,
    ...readState()
  })
  if (events.length > 30) events.shift()
}

const measureFrame = () => {
  frames += 1
  frame = requestAnimationFrame(measureFrame)
}

const render = () => {
  const state = readState()
  samples.push({
    ...state,
    framesSincePreviousSample: frames - lastFrames
  })
  lastFrames = frames
  if (samples.length > 10) samples.shift()
  document.querySelector("#probe-status").textContent =
    `${state.visibility} · 焦点 ${state.focused} · 动画帧 ${frames}`
  document.querySelector("#probe-result").textContent = JSON.stringify({
    userAgent: navigator.userAgent,
    url: location.href,
    state,
    events,
    samples
  }, null, 2)
}

const start = () => {
  if (timer !== null) return
  frame = requestAnimationFrame(measureFrame)
  timer = setInterval(render, 1000)
  render()
}

// 定时器只展示证据；帧数仅由原生 requestAnimationFrame 回调递增。
document.addEventListener("visibilitychange", recordEvent)
window.addEventListener("focus", recordEvent)
window.addEventListener("blur", recordEvent)
window.addEventListener("pageshow", event => {
  recordEvent(event)
  start()
})
window.addEventListener("pagehide", () => {
  clearInterval(timer)
  cancelAnimationFrame(frame)
  timer = null
})
document.querySelector("#export-probe").addEventListener("click", () => {
  const blob = new Blob([document.querySelector("#probe-result").textContent], {
    type: "application/json"
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = "mewoc-browser-visibility.json"
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})
start()
