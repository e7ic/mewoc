import { createStore } from "zustand/vanilla"

export const THEME_KEY = "mewoc.theme"
export const THEME_OPTIONS = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" }
]

const isTheme = value => THEME_OPTIONS.some(option => option.value === value)

function getThemePreference(browser) {
  try {
    const value = browser.localStorage.getItem(THEME_KEY)
    return { preference: isTheme(value) ? value : "system", error: "" }
  } catch {
    return { preference: "system", error: "未能读取主题偏好，当前跟随系统" }
  }
}

export function getEffectiveTheme({ preference, systemDark }) {
  if (preference === "system") return systemDark ? "dark" : "light"
  return preference
}

export function createThemeStore(browser = window) {
  return createStore(set => ({
    ...getThemePreference(browser),
    systemDark: browser.matchMedia("(prefers-color-scheme: dark)").matches,
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

export function startThemeSync(store, browser = window) {
  const media = browser.matchMedia("(prefers-color-scheme: dark)")
  const handleSystemTheme = event => store.setState({ systemDark: event.matches })
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
  store.setState({ systemDark: media.matches })
  return () => {
    media.removeEventListener("change", handleSystemTheme)
    browser.removeEventListener("storage", handleStorage)
  }
}
