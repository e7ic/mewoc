/** 格式标记是浏览器视图偏好，不进入文档快照、正文修改序号或撤销历史。 */
export const FORMATTING_MARKS_KEY = "mewoc.formatting-marks"

// 使用严格布尔文本，旧值/未知值和被限制的存储都回退为默认隐藏。
export function readFormattingMarks(browser = globalThis.window) {
  try { return browser.localStorage.getItem(FORMATTING_MARKS_KEY) === "true" }
  catch { return false }
}

export function saveFormattingMarks(visible, browser = globalThis.window) {
  if (typeof visible !== "boolean") return false
  try {
    browser.localStorage.setItem(FORMATTING_MARKS_KEY, String(visible))
    return true
  } catch { return false }
}

// 外部标签页修改偏好时只更新当前视图；卸载移除监听，避免旧会话继续接收消息。
export function startFormattingMarksSync(store, browser = globalThis.window) {
  if (!browser?.addEventListener) return () => {}
  const handleStorage = event => {
    try {
      if (event.storageArea !== browser.localStorage || event.key !== null && event.key !== FORMATTING_MARKS_KEY) return
      store.getState().updateView({ formattingMarks: readFormattingMarks(browser) })
    } catch { /* 存储权限在运行中被收回时，保留本次会话已经选定的视图。 */ }
  }
  browser.addEventListener("storage", handleStorage)
  return () => browser.removeEventListener("storage", handleStorage)
}
