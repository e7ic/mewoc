import { validateDocument } from "./document-schema.js"

export const MAX_MARKDOWN_BYTES = 1024 * 1024
export const MAX_MARKDOWN_LENGTH = 200000

export async function readMarkdownSource(file) {
  if (!/\.(md|markdown)$/i.test(file.name)) throw new Error("请选择 .md 或 .markdown 文件")
  if (file.size > MAX_MARKDOWN_BYTES) throw new Error("Markdown 文件不能超过 1 MiB")
  let source
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())
  } catch {
    throw new Error("无法读取文件，请使用 UTF-8 编码的 Markdown")
  }
  validateMarkdownSource(source)
  return { source, title: file.name.replace(/\.(md|markdown)$/i, "").slice(0, 100) || "Markdown 文档" }
}

export async function readMarkdownDocument(source, title = "Markdown 文档") {
  validateMarkdownSource(source)
  const converter = await import("./markdown-converter.js")
  return converter.readMarkdownDocument(source, title)
}

export async function createDocumentMarkdown(document) {
  validateDocument(document)
  const converter = await import("./markdown-converter.js")
  const result = converter.createDocumentMarkdown(document)
  if (result.source.length > MAX_MARKDOWN_LENGTH) result.warnings.push("生成的 Markdown 超过 200000 字符，超出本轮 Markdown 导入范围")
  return result
}

function validateMarkdownSource(source) {
  if (typeof source !== "string" || !source.trim()) throw new Error("请输入 Markdown 源码")
  if (source.length > MAX_MARKDOWN_LENGTH) throw new Error("Markdown 源码不能超过 200000 个字符")
  if (source.includes("\u0000")) throw new Error("文件包含无效空字符，请选择文字格式的 Markdown")
}
