/** 将文档快照导出为可读纯文本，复用公式、附件及批注的既有序列化规则。 */
import { generateText } from "@tiptap/core"
import { createExtensions } from "./create-extensions.js"
import { appendCommentText } from "./comment-export.js"
import { DETAILS_DEFAULTS } from "./block-containers.js"
import { prepareNavigationExportContent } from "./navigation-export.js"
import { DEFAULT_PAGE } from "../constants/editor-constants.js"
import { isPageFurnitureActive } from "./page-furniture.js"
import { hasDocumentMedia } from "./media-export.js"

/** 转换说明交给下载入口呈现，不能把页面装饰文字或说明追加进正文文件。 */
export function getDocumentTextWarnings(document) {
  const page = document.page
  const warnings = []
  if (page.size !== DEFAULT_PAGE.size || page.orientation !== DEFAULT_PAGE.orientation ||
    Object.keys(DEFAULT_PAGE.marginsMm).some(key => page.marginsMm[key] !== DEFAULT_PAGE.marginsMm[key])) warnings.push("纯文本不保留纸张大小、方向和页边距")
  if (page.watermark) warnings.push("纯文本不保留页面水印，正文文字保持原内容")
  if ([page.header, page.footer].some(isPageFurnitureActive)) warnings.push("纯文本不保留页眉、页脚和页码，正文文字保持原内容")
  if (hasDocumentMedia(document.content)) warnings.push("纯文本只保留音频和视频的文件说明；完整资源请使用 Mewoc 文件或 HTML")
  return warnings
}

export function createDocumentText(document) {
  const content = prepareNavigationExportContent(document.content).content
  const visit = node => {
    if (node.type === "tableOfContents") {
      // 纯文本保留实际标题快照，不输出锚点 ID 或虚构页码；层级仅以空白缩进表达。
      node.content = [node.attrs.title, ...node.attrs.entries.map(entry => `${"  ".repeat(entry.level - 1)}${entry.text || "未命名标题"}`)]
        .map(value => ({ type: "paragraph", content: value ? [{ type: "text", text: value }] : [] }))
      node.type = "blockquote"
      delete node.attrs
    }
    // 纯文本没有容器外观或折叠交互；改成普通块容器，保留分段并补入不在 content 内的详情标题。
    // 只处理快照副本，不让导出改写原稿、展开状态或正文撤销历史。
    if (node.type === "textBox" || node.type === "details") {
      if (node.type === "details") node.content = [{ type: "paragraph", content: [{ type: "text", text: node.attrs?.summary ?? DETAILS_DEFAULTS.summary }] }, ...(node.content || [])]
      node.type = "blockquote"
      delete node.attrs
    }
    if (node.type === "taskList") node.type = "bulletList"
    if (node.type === "taskItem") {
      const first = node.content?.[0]
      if (first?.type !== "paragraph") throw new Error("待办清单缺少首段内容")
      // 仅在副本中把任务转成含状态前缀的普通项；嵌套段落的分隔仍交给 Tiptap。
      first.content = [{ type: "text", text: node.attrs?.checked ? "[x] " : "[ ] " }, ...(first.content || [])]
      node.type = "listItem"
      delete node.attrs
    }
    node.content?.forEach(visit)
  }
  visit(content)
  const references = new Map(document.assets.map(asset => [asset.id, asset]))
  const text = generateText(content, createExtensions(() => "", id => references.get(id)))
  return appendCommentText(document, text)
}
