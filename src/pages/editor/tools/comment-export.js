/**
 * 把文档批注转换成 HTML、纯文本或 Markdown 的文末说明。
 * 不同格式共用快照中的引用和线程内容；交互定位由原生 Mewoc 文件保留，静态输出用文字说明承接。
 */
import { getCommentEntries } from "./document-comments.js"

// 统一各输出格式的标题、说明和降级提示，确保用户了解导出后批注仍能阅读但交互形式改变。
export const COMMENT_APPENDIX_HEADING = "批注说明"
export const COMMENT_APPENDIX_INTRO = "以下保留批注内容与引用文字。批注定位和交互请在 Mewoc 文件中查看。"
export const COMMENT_WORD_WARNING = "批注已转换为文末说明，Word 原生批注定位和交互不保留；完整备份请使用 Mewoc 文件"
export const COMMENT_MARKDOWN_WARNING = "批注已转换为文末说明，Markdown 不保留批注定位和交互；完整备份请使用 Mewoc 文件"

// 只读取快照中的批注与正文，不依赖侧栏状态、DOM 或当前选区。
// 原始引用保留创建时上下文，当前引用反映编辑后的文字；失去引用的批注仍完整导出。
export function getCommentAppendix(document) {
  return getCommentEntries(document.content).map((entry, index) => ({
    heading: `批注 ${index + 1} · ${entry.resolved ? "已解决" : "未解决"}${entry.orphaned ? " · 引用文字已不在正文中" : ""}`,
    paragraphs: [
      `原始引用：${entry.quote}`,
      ...(!entry.orphaned ? [`当前引用：${entry.anchorText}`] : []),
      `批注内容：${entry.text}`,
      `创建时间：${entry.createdAt}`,
      `更新时间：${entry.updatedAt}`
    ]
  }))
}

// 所有批注与引用都是用户文本，进入 HTML 时必须转义，避免被解释为标签或属性。
const escapeHtml = value => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

// 生成独立、可访问的批注章节；无批注时返回空串，避免给普通文档添加多余尾部。
export function createCommentAppendixHtml(document) {
  const entries = getCommentAppendix(document)
  if (!entries.length) return ""
  const rows = entries.map(entry => `<li><h3>${escapeHtml(entry.heading)}</h3>${entry.paragraphs.map(text => `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(text)}</p>`).join("")}</li>`).join("")
  return `<section class="mewoc-comment-appendix" aria-label="${COMMENT_APPENDIX_HEADING}"><h2>${COMMENT_APPENDIX_HEADING}</h2><p>${COMMENT_APPENDIX_INTRO}</p><ol>${rows}</ol></section>`
}

// 把同一份结构化批注说明拼到已有纯文本之后，以空行区分正文、批注和字段。
export function appendCommentText(document, text) {
  const entries = getCommentAppendix(document)
  if (!entries.length) return text
  const appendix = [COMMENT_APPENDIX_HEADING, COMMENT_APPENDIX_INTRO, ...entries.map(entry => [entry.heading, ...entry.paragraphs].join("\n"))].join("\n\n")
  return `${text}\n\n${appendix}`
}

// 将用户文字作为 AST 文本处理，交给 Markdown stringify 转义；不解析成标题、链接或 HTML。
const markdownParagraph = value => ({
  type: "paragraph",
  children: value.split(/\r\n?|\n/).flatMap((text, index) => [
    ...(index ? [{ type: "break" }] : []),
    { type: "text", value: text }
  ])
})

// 返回可追加到 Markdown root 的节点数组；有序列表保留批注顺序，每个字段作为独立段落。
export function createCommentAppendixMarkdown(document) {
  const entries = getCommentAppendix(document)
  if (!entries.length) return []
  return [
    { type: "heading", depth: 2, children: [{ type: "text", value: COMMENT_APPENDIX_HEADING }] },
    markdownParagraph(COMMENT_APPENDIX_INTRO),
    {
      type: "list", ordered: true, start: 1, spread: true,
      children: entries.map(entry => ({
        type: "listItem", spread: true,
        children: [markdownParagraph(entry.heading), ...entry.paragraphs.map(markdownParagraph)]
      }))
    }
  ]
}
