/**
 * 统一 AntD 的中文语言、浅深色算法和图标样式，覆盖主界面及独立静态消息容器。
 * 共享主题 store 保证多个 Provider 使用同一偏好；全局监听仅由主入口的 sync 实例承担。
 */
import { useEffect, useLayoutEffect } from "react"
import { ConfigProvider, theme } from "antd"
import { IconChevronDown, IconChevronRight, IconDots, IconFileSearch, IconLoader2, IconX } from "@tabler/icons-react"
import zhCN from "antd/es/locale/zh_CN"
import { useStore } from "zustand"
import { createThemeStore, getEffectiveTheme, startThemeSync } from "../tools/create-theme-store.js"

// 主题在当前页面共享，使独立挂载的 AntD 消息/确认框也能订阅同一个偏好。
export const editorThemeStore = createThemeStore()

// 组件库主题算法处理颜色体系，少量 token 覆盖品牌色与深色背景，和正文 CSS 主题配合。
const THEMES = {
  light: { algorithm: theme.defaultAlgorithm, token: { colorPrimary: "#6657d9" } },
  dark: { algorithm: theme.darkAlgorithm, token: { colorPrimary: "#9e91ff", colorBgContainer: "#20222c", colorBgElevated: "#292c38" } }
}

// 由组件 token 同步调整箭头、垂直居中和文字留白，避免只放大 SVG 后与选中值重叠。
const ICON_SIZES = {
  Select: { fontSizeIcon: 18 },
  InputNumber: { handleFontSize: 14 }
}

// 静态消息、弹窗与正文界面共用这组图标配置，避免 portal 再回到组件库默认图标。
const ICONS = {
  modal: { closeIcon: <IconX aria-hidden="true" /> },
  spin: { indicator: <IconLoader2 className="mewoc-icon-spin" aria-hidden="true" /> },
  empty: { image: <IconFileSearch aria-hidden="true" style={{ fontSize: 48 }} /> },
  tabs: { moreIcon: <IconDots aria-hidden="true" /> },
  collapse: { expandIcon: ({ isActive }) => isActive ? <IconChevronDown aria-hidden="true" /> : <IconChevronRight aria-hidden="true" /> }
}

// 仅主入口传 sync：负责浏览器监听及根节点属性，避免每个静态弹窗重复绑定全局副作用。
export function EditorThemeProvider({ children, sync = false }) {
  const effectiveTheme = useStore(editorThemeStore, getEffectiveTheme)

  // 仅同步实例启动浏览器主题监听；startThemeSync 返回清理函数，卸载时解除全局订阅。
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

  // 将解析后的有效主题交给组件库，用户选择“跟随系统”时也能正确展示当前浅色或深色。
  return <ConfigProvider locale={zhCN} theme={{ ...THEMES[effectiveTheme], components: ICON_SIZES }} {...ICONS}>{children}</ConfigProvider>
}
