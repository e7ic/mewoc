/**
 * 将转换器的警告列表统一展示在 Markdown 导入与导出弹窗中。
 * 警告说明支持范围内的转换差异，空列表只显示当前转换完成状态。
 */
import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react"
import { Alert } from "antd"
import styles from "../sass/markdown.module.scss"

// warnings 已由转换器去重；空列表只表示支持范围内未报告转换损失，不代表完整格式无损。
export function MarkdownWarnings({ warnings }) {
  return warnings.length ? <Alert type="warning" icon={<IconAlertTriangle aria-hidden="true" />} showIcon message="以下内容已转换"
    description={<ul className={styles.warnings}>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>} />
    : <Alert type="success" icon={<IconCircleCheck aria-hidden="true" />} showIcon message="支持的内容已完成转换" />
}
