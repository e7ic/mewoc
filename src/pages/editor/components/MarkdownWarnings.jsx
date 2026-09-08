import { Alert } from "antd"
import styles from "../sass/markdown.module.scss"

// warnings 已由转换器去重；空列表只表示支持范围内未报告转换损失，不代表完整格式无损。
export function MarkdownWarnings({ warnings }) {
  return warnings.length ? <Alert type="warning" showIcon message="以下内容已转换"
    description={<ul className={styles.warnings}>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>} />
    : <Alert type="success" showIcon message="支持的内容已完成转换" />
}
