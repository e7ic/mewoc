/**
 * 保存浏览器级工具栏布局偏好，支持极简与完整模式的读取和写入。
 * 文档数据不承担界面布局；存储不可访问或值未知时使用完整模式，用户仍可在当前会话切换。
 */
// 共享持久键和模式枚举，读取与写入都按同一白名单验证，避免任意字符串影响工具栏布局。
export const TOOLBAR_MODE_KEY = "mewoc.toolbar-mode"
export const TOOLBAR_MODES = [
  { key: "compact", label: "极简模式" },
  { key: "ribbon", label: "完整模式" }
]

const isMode = value => TOOLBAR_MODES.some(mode => mode.key === value)

// 初始布局读取容错，隐私模式或存储限制不会阻断编辑器启动。
export function readToolbarMode(browser = window) {
  try {
    const value = browser.localStorage.getItem(TOOLBAR_MODE_KEY)
    return isMode(value) ? value : "ribbon"
  } catch {
    return "ribbon"
  }
}

// 布局是浏览器偏好，不写入文档或撤销栈；存储受限时仍可在当前会话切换。
export function saveToolbarMode(value, browser = window) {
  if (!isMode(value)) return false
  try {
    browser.localStorage.setItem(TOOLBAR_MODE_KEY, value)
    return true
  } catch {
    return false
  }
}
