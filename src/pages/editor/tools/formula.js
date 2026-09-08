export const MAX_FORMULA_LENGTH = 2000
export const MAX_FORMULA_TOTAL = 100000
export const FORMULA_TYPES = ["inlineMath", "blockMath"]

export function getFormulaSourceError(latex) {
  if (typeof latex !== "string" || !latex.trim()) return "请输入公式 LaTeX 源码"
  if (latex.length > MAX_FORMULA_LENGTH) return `公式最多 ${MAX_FORMULA_LENGTH} 字符`
  return ""
}

// 入口先校验源码长度再按需加载 KaTeX，普通文档无需承担公式渲染器加载成本。
export async function renderFormula(latex, displayMode = false) {
  const error = getFormulaSourceError(latex)
  if (error) throw new Error(error)
  const renderer = await import("./formula-renderer.js")
  return renderer.renderFormulaMathml(latex, displayMode)
}

export async function renderFormulaHtml(html) {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  const formulas = parsed.querySelectorAll('[data-type="inline-math"], [data-type="block-math"]')
  for (const formula of formulas) {
    const latex = formula.getAttribute("data-latex")
    try {
      formula.innerHTML = await renderFormula(latex, formula.getAttribute("data-type") === "block-math")
    } catch {
      // 错误公式仍携带可恢复源码，导出不静默删除内容。
      formula.textContent = `公式未能渲染：${latex}`
      formula.setAttribute("data-formula-error", "true")
    }
  }
  return parsed.body.innerHTML
}
