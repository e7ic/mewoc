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
  const content = groupStaticTableHeaders(await renderCodeHtml(formulaHtml))
  // 输出只依赖快照，不读取编辑 NodeView 的控件、缩放或焦点装饰；实际分页由浏览器打印处理。
  const { styles: pageStyle, watermark, furniture, furnitureHint } = createPageExportLayout(document.page)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapePageText(document.title)}</title><style>${contentStyles}\n${pageStyle}</style></head><body>${furnitureHint}<main class="mewoc-export-page">${watermark}${furniture}<article class="mewoc-content">${content}${createCommentAppendixHtml(portable.document)}</article></main></body></html>`
}

/**
 * 静态表格把可重复的真实起始表头提到 thead，供浏览器打印按页重复。
 * 规则与 Word 相同：前缀连续全 th 且无纵向合并；只移动原行，不复制正文。
 * 每次只读取当前 table 的直属行，避免把嵌套表格的表头并入外表。
 */
function groupStaticTableHeaders(source) {
  const parsed = new DOMParser().parseFromString(source, "text/html")
  for (const table of parsed.querySelectorAll("table")) {
    const body = [...table.children].find(element => element.tagName === "TBODY")
    if (!body) continue
    const headers = []
    for (const row of body.children) {
      const cells = [...row.children]
      if (row.tagName !== "TR" || !cells.length || cells.some(cell => cell.tagName !== "TH" || cell.rowSpan !== 1)) break
      headers.push(row)
    }
    if (!headers.length) continue
    const head = parsed.createElement("thead")
    table.insertBefore(head, body)
    headers.forEach(row => head.append(row))
  }
  return parsed.body.innerHTML
}
