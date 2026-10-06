/** 原生指针验收诊断入口：展示有限事件记录，并导出文档文字、输入事件和图表尺寸。 */
// 专用验收入口：记录真实事件坐标，普通产品入口不加载此文件。
// 记录面板禁止指针命中，不遮挡待验收编辑器交互。
const panel = document.createElement("pre")
panel.setAttribute("aria-label", "指针事件记录")
panel.style.cssText = "position:fixed;left:8px;bottom:48px;width:420px;max-height:240px;overflow:auto;background:white;border:1px solid #ddd;font-size:11px;z-index:1000;pointer-events:none"
document.body.append(panel)
const events = []
// 保留可信标志和捕获边界，连续悬停合并，队列长度限制避免诊断输出无限增长。
const handleMouse = event => {
  const record = {
    type: event.type, x: event.clientX, y: event.clientY, buttons: event.buttons,
    pointerId: event.pointerId, trusted: event.isTrusted, sizes: getSizes()
  }
  // 连续移动只保留最后位置，避免悬停挤掉按下、释放和捕获边界。
  const previous = events.at(-1)
  if (event.type === "mousemove" && previous?.type === "mousemove" && previous.buttons === event.buttons) events[events.length - 1] = record
  else events.push(record)
  if (events.length > 120) events.shift()
  panel.textContent = JSON.stringify(events, null, 2)
}
// 捕获阶段观察事件，包括窗口失焦与指针取消，不替代编辑器自身处理器。
const TYPES = ["mousedown", "mousemove", "mouseup", "pointerdown", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture", "blur", "focus"]
for (const type of TYPES) window.addEventListener(type, handleMouse, true)
const button = document.createElement("button")
button.type = "button"
button.textContent = "导出原生验收记录"
button.style.cssText = "position:fixed;left:8px;bottom:294px;z-index:1001"
// 将当前编辑内容与另一个输入法记录面板一起导出，方便对照原生事件证据。
const handleExport = () => {
  const input = document.querySelector('[aria-label="输入法事件记录"]')?.textContent
  const result = {
    title: document.querySelector('[aria-label="文档标题"]')?.value,
    body: document.querySelector(".ProseMirror")?.textContent,
    pointerEvents: events, inputEvents: input ? JSON.parse(input) : [], sizes: getSizes()
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = "mewoc-native-verification.json"
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
button.addEventListener("click", handleExport)
document.body.append(button)
// 离开页面时移除本诊断入口的监听与 DOM，避免测试浮层残留。
window.addEventListener("pagehide", () => {
  for (const type of TYPES) window.removeEventListener(type, handleMouse, true)
  button.removeEventListener("click", handleExport)
  button.remove()
  panel.remove()
}, { once: true })

// 同时记录视图样式和单元格持久化列宽，用于核对预览尺寸与最终文档属性。
function getSizes() {
  return {
    images: [...document.querySelectorAll(".ProseMirror img")].map(image => ({ width: image.style.width, height: image.style.height })),
    tables: [...document.querySelectorAll(".ProseMirror table")].map(table => ({
      width: table.style.width,
      columns: [...table.querySelectorAll("col")].map(column => column.style.width),
      cells: [...table.querySelectorAll("th, td")].map(cell => cell.getAttribute("colwidth"))
    }))
  }
}
