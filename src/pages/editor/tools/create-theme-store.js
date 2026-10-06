/**
 * 管理浏览器主题偏好以及系统主题、其他标签页修改带来的同步。
 * 偏好值和生效主题分开计算；存储不可用时界面仍可选择主题，并通过 error 给出保存状态。
 */
import { createStore } from "zustand/vanilla"

// 持久键和枚举组成主题偏好契约，未知值统一回退到跟随系统，避免异常字符串进入界面。
export const THEME_KEY = "mewoc.theme"
export const THEME_OPTIONS = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" }
]

const isTheme = value => THEME_OPTIONS.some(option => option.value === value)

// 读取偏好同时返回错误状态，启动和 storage 事件复用同一回退策略。
function getThemePreference(browser) {
  try {
    const value = browser.localStorage.getItem(THEME_KEY)
    return { preference: isTheme(value) ? value : "system", error: "" }
  } catch {
    return { preference: "system", error: "未能读取主题偏好，当前跟随系统" }
  }
}

// 把三态用户偏好解析为两态实际主题；显式浅/深色不会被系统颜色变化覆盖。
export function getEffectiveTheme({ preference, systemDark }) {
  if (preference === "system") return systemDark ? "dark" : "light"
  return preference
}

// 主题属于浏览器界面偏好，与文档 revision 无关；偏好写入失败仍应用本次选择并报告错误。
export function createThemeStore(browser = window) {
  return createStore(set => ({
    ...getThemePreference(browser),
    systemDark: browser.matchMedia("(prefers-color-scheme: dark)").matches,
    // 校验后先尝试持久化再更新仓库，写入失败只影响下次启动，不撤回本次界面选择。
    setTheme: preference => {
      if (!isTheme(preference)) return false
      let error = ""
      try {
        browser.localStorage.setItem(THEME_KEY, preference)
      } catch {
        error = "主题已应用，但未能保存偏好；重新选择可重试"
      }
      set({ preference, error })
      return true
    }
  }))
}

// 系统主题和其他标签页的存储变化分别监听；返回清理函数供 Provider 卸载时调用。
export function startThemeSync(store, browser = window) {
  const media = browser.matchMedia("(prefers-color-scheme: dark)")
  const handleSystemTheme = event => store.setState({ systemDark: event.matches })
  // 同名键或整库清空才可能影响主题；重新读取存储而不信任事件携带的未校验值。
  const handleStorage = event => {
    if (event.key !== THEME_KEY && event.key !== null) return
    // 忽略 sessionStorage 的同名键，不把其他偏好当成当前界面主题。
    try {
      if (event.storageArea !== browser.localStorage) return
    } catch {
      return
    }
    store.setState(getThemePreference(browser))
  }
  media.addEventListener("change", handleSystemTheme)
  browser.addEventListener("storage", handleStorage)
  // 注册监听后补读一次当前值，缩小创建 store 到启动同步之间系统主题变化的遗漏窗口。
  store.setState({ systemDark: media.matches })
  return () => {
    media.removeEventListener("change", handleSystemTheme)
    browser.removeEventListener("storage", handleStorage)
  }
}
