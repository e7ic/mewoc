/**
 * 界面主题偏好的选择入口，订阅全局主题 store 以同步主界面与独立消息容器。
 * 用户偏好与最终有效主题分开保存，跟随系统时仍回显该偏好选项。
 */
import { IconChevronDown } from "@tabler/icons-react"
import { Select } from "antd"
import { useStore } from "zustand"
import { editorThemeStore } from "./EditorThemeProvider.jsx"
import { THEME_OPTIONS } from "../tools/create-theme-store.js"
import styles from "../sass/toolbar.module.scss"

// 展示用户偏好而非解析后的浅/深色；使用 onSelect 让重复选择也能重试失败的偏好保存。
export function ThemeControls({ active = true }) {
  // 下拉开关是局部视图状态；偏好与保存错误来自共享 store，切换文档也沿用同一主题选择。
  const [open, setOpen] = useState(false)
  const preference = useStore(editorThemeStore, state => state.preference)
  const error = useStore(editorThemeStore, state => state.error)
  // 视图标签失活就收起下拉，避免隐藏面板的主题菜单仍漂浮在其他工具上。
  useEffect(() => { if (!active) setOpen(false) }, [active])

  // onSelect 负责立即应用并尝试持久化；保存错误显示在入口旁，让用户可重复选择重试。
  return (
    <div className={styles.theme}>
      <span>界面主题</span>
      <Select suffixIcon={<IconChevronDown aria-hidden="true" />}
        aria-label="界面主题" className={styles.themeSelect} size="small"
        value={preference} options={THEME_OPTIONS}
        open={active && open} onOpenChange={setOpen}
        onSelect={value => editorThemeStore.getState().setTheme(value)}
      />
      {error && <span className={styles.themeError} role="status">{error}</span>}
    </div>
  )
}
import { useEffect, useState } from "react"
