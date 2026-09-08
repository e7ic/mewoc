import { generateHTML } from "@tiptap/core"
import { createExtensions } from "./create-extensions.js"
import { createPortableFile } from "./portable-file.js"
import { renderFormulaHtml } from "./formula.js"
import { renderCodeHtml } from "./code-highlight.js"
import contentStyles from "../sass/content.scss?inline"

export { createPortableFile, readPortableFile } from "./portable-file.js"

/**
 * 从最新文档快照生成独立 HTML：先内嵌资源，再通过 schema 输出正文并补公式/代码渲染。
 * 不读取编辑器 NodeView 的 DOM，因此缩放手柄、选区和工具栏不会进入导出或打印。
 */
export async function createDocumentHtml(document, assets) {
  const portable = await createPortableFile(document, assets)
  const references = new Map(portable.document.assets.map(asset => [asset.id, asset]))
  const getAssetUrl = id => {
    const source = portable.assetData[id]
    return references.get(id)?.kind === "attachment" ? source.replace(/^data:[^;]+;/, "data:application/octet-stream;") : source
  }
  const formulaHtml = await renderFormulaHtml(generateHTML(document.content, createExtensions(getAssetUrl, id => references.get(id))))
  const content = await renderCodeHtml(formulaHtml)
  const margins = document.page.marginsMm
  // 纸张保持物理 mm 单位，编辑界面的 zoom 不参与输出；实际分页仍由浏览器打印控制。
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
