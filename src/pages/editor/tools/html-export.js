/** 静态 HTML 快照转换器；样式由入口注入，Node 可验证实际输出而无需模拟 Sass 加载器。 */
import { generateHTML } from "@tiptap/core"
import { createExtensions } from "./create-extensions.js"
import { createPortableFile } from "./portable-file.js"
import { renderFormulaHtml } from "./formula.js"
import { renderCodeHtml } from "./code-highlight.js"
import { createCommentAppendixHtml } from "./comment-export.js"
import { prepareNavigationExportContent } from "./navigation-export.js"
import { validateDocument } from "./document-schema.js"
import { createPageExportLayout } from "./page-export-layout.js"
import { escapePageText } from "./page-watermark.js"

export async function createDocumentHtml(document, assets, contentStyles = "") {
  validateDocument(document)
  // 第一段异步工作前固定正文与页面；水印、目录和后续资源编码不能混入导出期间的新编辑。
  document = { ...structuredClone(document), content: prepareNavigationExportContent(document.content).content }
  const portable = await createPortableFile(document, assets)
  const references = new Map(portable.document.assets.map(asset => [asset.id, asset]))
  // 附件保持原字节，下载 MIME 固定为二进制，不能把内嵌 HTML 附件当作活动页面。
  const getAssetUrl = id => {
    const source = portable.assetData[id]
    return references.get(id)?.kind === "attachment" ? source.replace(/^data:[^;]+;/, "data:application/octet-stream;") : source
  }
  const formulaHtml = await renderFormulaHtml(generateHTML(document.content, createExtensions(getAssetUrl, id => references.get(id))))
  const content = await renderCodeHtml(formulaHtml)
  // 输出只依赖快照，不读取编辑 NodeView 的控件、缩放或焦点装饰；实际分页由浏览器打印处理。
  const { styles: pageStyle, watermark } = createPageExportLayout(document.page)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapePageText(document.title)}</title><style>${contentStyles}\n${pageStyle}</style></head><body><main class="mewoc-export-page">${watermark}<article class="mewoc-content">${content}${createCommentAppendixHtml(portable.document)}</article></main></body></html>`
}
