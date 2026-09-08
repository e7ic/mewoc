import { useEffect, useLayoutEffect } from "react"
import { ConfigProvider, theme } from "antd"
import zhCN from "antd/es/locale/zh_CN"
import { useStore } from "zustand"
import { createThemeStore, getEffectiveTheme, startThemeSync } from "../tools/create-theme-store.js"

// 主题在当前页面共享，使独立挂载的 AntD 消息/确认框也能订阅同一个偏好。
export const editorThemeStore = createThemeStore()

const THEMES = {
  light: { algorithm: theme.defaultAlgorithm, token: { colorPrimary: "#6657d9" } },
  dark: { algorithm: theme.darkAlgorithm, token: { colorPrimary: "#9e91ff", colorBgContainer: "#20222c", colorBgElevated: "#292c38" } }
}

// 仅主入口传 sync：负责浏览器监听及根节点属性，避免每个静态弹窗重复绑定全局副作用。
export function EditorThemeProvider({ children, sync = false }) {
  const effectiveTheme = useStore(editorThemeStore, getEffectiveTheme)

  useEffect(() => {
    if (sync) return startThemeSync(editorThemeStore)
  }, [sync])

  // 在绘制前同步 CSS 变量入口；卸载恢复先前属性，不假定宿主原本没有主题标记。
  useLayoutEffect(() => {
    if (!sync) return
    const root = document.documentElement
    const previous = root.getAttribute("data-mewoc-theme")
    root.setAttribute("data-mewoc-theme", effectiveTheme)
    return () => {
      if (previous === null) root.removeAttribute("data-mewoc-theme")
      else root.setAttribute("data-mewoc-theme", previous)
    }
  }, [sync, effectiveTheme])

  return <ConfigProvider locale={zhCN} theme={THEMES[effectiveTheme]}>{children}</ConfigProvider>
}
