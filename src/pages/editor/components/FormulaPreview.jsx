/**
 * 以短延迟预览 LaTeX，输入或公式显示方式改变后只展示最新一次渲染结果。
 * 本组件不写入正文，语法错误仅作为预览提示，最终提交还会再次渲染校验。
 */
import { useEffect, useState } from "react"
import { renderFormula } from "../tools/formula.js"
import styles from "../sass/formula.module.scss"

export function FormulaPreview({ latex, type }) {
  // 加载、成功 HTML 与错误集中为互斥预览状态，防止新输入期间继续展示旧表达式。
  const [preview, setPreview] = useState({ html: "", error: "", loading: true })
  // 防抖减少连续输入的渲染次数；依赖变化后取消旧回写，但不声称已取消正在运行的渲染。
  useEffect(() => {
    let cancelled = false
    setPreview({ html: "", error: "", loading: true })
    const timer = setTimeout(() => {
      renderFormula(latex, type === "blockMath").then(html => {
        if (!cancelled) setPreview({ html, error: "", loading: false })
      }).catch(error => {
        if (!cancelled) setPreview({ html: "", error: error.message, loading: false })
      })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [latex, type])

  // 仅插入公式渲染器返回的 HTML；live 区域播报加载或错误，让异步预览状态可被感知。
  return <div className={styles.preview} aria-label="公式预览" aria-live="polite">
    {preview.loading && <span>正在生成预览…</span>}
    {preview.error && <span className={styles.error}>{preview.error}</span>}
    {preview.html && <div dangerouslySetInnerHTML={{ __html: preview.html }} />}
  </div>
}
