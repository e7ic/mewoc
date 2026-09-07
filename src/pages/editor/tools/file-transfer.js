import { generateHTML } from "@tiptap/core"
import { createExtensions } from "./create-extensions.js"
import { createPortableFile } from "./portable-file.js"
import { renderFormulaHtml } from "./formula.js"
import { renderCodeHtml } from "./code-highlight.js"
import contentStyles from "../sass/content.scss?inline"

export { createPortableFile, readPortableFile } from "./portable-file.js"

export async function createDocumentHtml(document, assets) {
  const portable = await createPortableFile(document, assets)
  const formulaHtml = await renderFormulaHtml(generateHTML(document.content, createExtensions(id => portable.assetData[id])))
  const content = await renderCodeHtml(formulaHtml)
  const margins = document.page.marginsMm
  const pageStyle = `@page { size: A4 ${document.page.orientation}; margin: ${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm; }`
  const title = document.title.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${title}</title><style>${contentStyles}\n${pageStyle}</style></head><body><article class="mewoc-content">${content}</article></body></html>`
}

export function downloadDocument(blob, title, extension) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `${title.replace(/[\\/:*?"<>|]/g, "_") || "未命名文档"}.${extension}`
  link.click()
  // 浏览器下载读取 object URL 是异步的，留出读取时间再释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
