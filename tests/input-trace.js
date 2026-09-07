// 只观测编辑正文中的真实输入，不记录地址栏或其他页面的数据。
const panel = document.createElement("pre")
panel.setAttribute("aria-label", "输入法事件记录")
panel.style.cssText = "position:fixed;right:8px;bottom:48px;width:440px;max-height:240px;overflow:auto;background:white;border:1px solid #ddd;font-size:11px;z-index:1000;pointer-events:none"
document.body.append(panel)
const events = []
const TYPES = ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "keydown"]
const handleInput = event => {
  if (!event.target.closest?.(".ProseMirror")) return
  events.push({
    type: event.type, data: event.data, key: event.key, inputType: event.inputType,
    composing: event.isComposing, trusted: event.isTrusted
  })
  if (events.length > 80) events.shift()
  panel.textContent = JSON.stringify(events, null, 2)
}
for (const type of TYPES) window.addEventListener(type, handleInput, true)
window.addEventListener("pagehide", () => {
  for (const type of TYPES) window.removeEventListener(type, handleInput, true)
  panel.remove()
}, { once: true })
