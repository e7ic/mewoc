/**
 * 为代码节点提供语言识别、受限着色和静态 HTML 重建。
 * 对单块与整份输出设计算预算；无法着色的块仍保留可读源码，渲染器只在实际需要时加载。
 */
import { getCodeLanguage } from "../constants/code-languages.js"

// 编辑视图与静态输出共用着色预算，限制计算量而不限制代码正文的存储长度。
export const MAX_CODE_HIGHLIGHT_LENGTH = 20000
export const MAX_CODE_HIGHLIGHT_TOTAL = 100000

// 规范化语言仅用于选渲染器；空文本、纯文本和超预算代码返回无样式片段，避免无收益解析。
export async function highlightCode(text, language) {
  const value = getCodeLanguage(language)
  if (!text || value === "plaintext" || text.length > MAX_CODE_HIGHLIGHT_LENGTH) return [{ text, classes: [] }]
  const renderer = await import("./code-highlight-renderer.js")
  return renderer.getCodeTokens(text, value)
}

// 优先读取本应用序列化字段，再兼容常见 code.language-* 标记；只做识别，不回写原属性。
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
  // 累计预算只计入实际尝试着色的块，超额时跳过该块，后续较短块仍可尝试。
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
    // 解析器失败时撤回部分样式并标记错误，避免单个代码块阻断整个文档的导出。
    } catch {
      code.textContent = source
      pre.setAttribute("data-code-highlight", "error")
    }
  }
  return parsed.body.innerHTML
}
