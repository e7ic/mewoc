/**
 * 把会话保存状态映射成可访问的短提示，放在工具栏中持续反馈本地保存进度。
 * 状态由保存服务更新，组件本身不触发保存，也不推断正文是否已经下载。
 */
import { IconLoader2 } from "@tabler/icons-react"
import { useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/toolbar.module.scss"

// saved 只承诺本浏览器持久化成功，不能把自动保存表现成云端同步或已下载文件。
const SAVE_LABELS = { dirty: "文档未保存", saving: "正在保存…", saved: "已保存到此浏览器", error: "保存失败" }

export function DocumentSaveStatus() {
  const status = useEditorStore(state => state.saveStatus)
  // role=status 让状态变化可被辅助技术读取；旋转图标只作视觉提示，文本给出实际状态。
  return <span className={styles.saveStatus} data-save-status={status} role="status">
    {status === "saving" ? <IconLoader2 className="mewoc-icon-spin" aria-hidden="true" /> : <span className={styles.statusDot} aria-hidden="true" />}
    {SAVE_LABELS[status]}
  </span>
}
