import { Select } from "antd"
import { useStore } from "zustand"
import { editorThemeStore } from "./EditorThemeProvider.jsx"
import { THEME_OPTIONS } from "../tools/create-theme-store.js"
import styles from "../sass/toolbar.module.scss"

// 展示用户偏好而非解析后的浅/深色；使用 onSelect 让重复选择也能重试失败的偏好保存。
export function ThemeControls() {
  const preference = useStore(editorThemeStore, state => state.preference)
  const error = useStore(editorThemeStore, state => state.error)

  return (
    <div className={styles.theme}>
      <span>界面主题</span>
      <Select
        aria-label="界面主题" className={styles.themeSelect} size="small"
        value={preference} options={THEME_OPTIONS}
        onSelect={value => editorThemeStore.getState().setTheme(value)}
      />
      {error && <span className={styles.themeError} role="status">{error}</span>}
    </div>
  )
}
