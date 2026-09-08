import { getCodeLanguage } from "../constants/code-languages.js"

// 编辑视图与静态输出共用着色预算，限制计算量而不限制代码正文的存储长度。
export const MAX_CODE_HIGHLIGHT_LENGTH = 20000
export const MAX_CODE_HIGHLIGHT_TOTAL = 100000

export async function highlightCode(text, language) {
  const value = getCodeLanguage(language)
  if (!text || value === "plaintext" || text.length > MAX_CODE_HIGHLIGHT_LENGTH) return [{ text, classes: [] }]
  const renderer = await import("./code-highlight-renderer.js")
  return renderer.getCodeTokens(text, value)
}

export function getPastedCodeLanguage(element) {
  const stored = element.getAttribute("data-code-language")
  if (stored !== null && stored.length <= 1000) return stored
  const code = element.querySelector("code")
  const language = [...(code?.classList || [])].find(value => /^language-[a-z0-9#+._-]{1,40}$/i.test(value))
  return language ? language.slice(9) : null
}

// 从序列化后的源码重建高亮；只使用文本节点和 span，源码里的 HTML 不作为标签执行。
export async function renderCodeHtml(html) {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  let characters = 0
  for (const pre of parsed.querySelectorAll("pre")) {
    const code = pre.querySelector("code")
    if (!code) continue
    const source = code.textContent
    const language = getPastedCodeLanguage(pre)
    if (getCodeLanguage(language) === "plaintext" || source.length > MAX_CODE_HIGHLIGHT_LENGTH) continue
    if (characters + source.length > MAX_CODE_HIGHLIGHT_TOTAL) continue
    characters += source.length
    try {
      const tokens = await highlightCode(source, language)
      code.replaceChildren(...tokens.map(token => {
        if (!token.classes.length) return parsed.createTextNode(token.text)
        const span = parsed.createElement("span")
        span.className = token.classes.join(" ")
        span.textContent = token.text
        return span
      }))
    } catch {
      code.textContent = source
      pre.setAttribute("data-code-highlight", "error")
    }
  }
  return parsed.body.innerHTML
}
