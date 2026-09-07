import { useEffect, useState } from "react"
import { renderFormula } from "../tools/formula.js"
import styles from "../sass/formula.module.scss"

export function FormulaPreview({ latex, type }) {
  const [preview, setPreview] = useState({ html: "", error: "", loading: true })
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

  return <div className={styles.preview} aria-label="公式预览" aria-live="polite">
    {preview.loading && <span>正在生成预览…</span>}
    {preview.error && <span className={styles.error}>{preview.error}</span>}
    {preview.html && <div dangerouslySetInnerHTML={{ __html: preview.html }} />}
  </div>
}
