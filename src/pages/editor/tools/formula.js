/**
 * 定义公式源码与总量限制，并为编辑预览和静态 HTML 提供按需渲染入口。
 * 源码是持久数据，MathML 是展示结果；渲染失败不丢弃公式节点的可恢复内容。
 */
export const MAX_FORMULA_LENGTH = 2000
export const MAX_FORMULA_TOTAL = 100000
export const FORMULA_TYPES = ["inlineMath", "blockMath"]

// 快速检查必要输入和单公式长度，成功返回空串；语法与受限指令由真正渲染器继续检查。
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

// 在独立解析文档中替换 schema 输出的公式占位，按节点类型决定行内或独立公式展示。
// 逐个公式收口失败，单个错误不会阻断整份文档导出。
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
