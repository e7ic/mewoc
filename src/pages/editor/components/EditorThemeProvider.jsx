import { useEffect, useLayoutEffect } from "react"
import { ConfigProvider, theme } from "antd"
import zhCN from "antd/es/locale/zh_CN"
import { useStore } from "zustand"
import { createThemeStore, getEffectiveTheme, startThemeSync } from "../tools/create-theme-store.js"

export const editorThemeStore = createThemeStore()

const THEMES = {
  light: { algorithm: theme.defaultAlgorithm, token: { colorPrimary: "#6657d9" } },
  dark: { algorithm: theme.darkAlgorithm, token: { colorPrimary: "#9e91ff", colorBgContainer: "#20222c", colorBgElevated: "#292c38" } }
}

export function EditorThemeProvider({ children, sync = false }) {
  const effectiveTheme = useStore(editorThemeStore, getEffectiveTheme)

  useEffect(() => {
    if (sync) return startThemeSync(editorThemeStore)
  }, [sync])

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
