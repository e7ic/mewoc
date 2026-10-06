/**
 * Markdown 的轻量文件/字符串入口：读取 UTF-8、限制字节与字符数量，按需加载转换依赖。
 * 不处理编辑器会话替换或下载动作，只返回待确认的转换数据。
 */
import { validateDocument } from "./document-schema.js"

// 文件字节数与解析后源码长度分别限额；UTF-8 中文的字节数不等于 JS 字符串长度。
export const MAX_MARKDOWN_BYTES = 1024 * 1024
export const MAX_MARKDOWN_LENGTH = 200000

/** 从 .md/.markdown File 读取源码并提取最长 100 字符标题；编码错误和空/超限源码直接拒绝。 */
export async function readMarkdownSource(file) {
  if (!/\.(md|markdown)$/i.test(file.name)) throw new Error("请选择 .md 或 .markdown 文件")
  if (file.size > MAX_MARKDOWN_BYTES) throw new Error("Markdown 文件不能超过 1 MiB")
  let source
  try {
    // 遇到错误编码直接报错，避免以替代字符继续导入而破坏原文。
    source = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())
  } catch {
    throw new Error("无法读取文件，请使用 UTF-8 编码的 Markdown")
  }
  validateMarkdownSource(source)
  return { source, title: file.name.replace(/\.(md|markdown)$/i, "").slice(0, 100) || "Markdown 文档" }
}

// 输入检查通过后再加载转换器，普通编辑无需提前加载 remark/unified。
export async function readMarkdownDocument(source, title = "Markdown 文档") {
  validateMarkdownSource(source)
  const converter = await import("./markdown-converter.js")
  return converter.readMarkdownDocument(source, title)
}

/** 校验业务文档后导出；生成文本超出本轮可回导范围时给 warning，仍保留完整导出结果。 */
export async function createDocumentMarkdown(document) {
  validateDocument(document)
  const converter = await import("./markdown-converter.js")
  const result = converter.createDocumentMarkdown(document)
  if (result.source.length > MAX_MARKDOWN_LENGTH) result.warnings.push("生成的 Markdown 超过 200000 字符，超出本轮 Markdown 导入范围")
  return result
}

/** 字符串入口共用检查，拒绝空白文档、超限长度及通常表示二进制输入的 NUL 字符。 */
function validateMarkdownSource(source) {
  if (typeof source !== "string" || !source.trim()) throw new Error("请输入 Markdown 源码")
  if (source.length > MAX_MARKDOWN_LENGTH) throw new Error("Markdown 源码不能超过 200000 个字符")
  if (source.includes("\u0000")) throw new Error("文件包含无效空字符，请选择文字格式的 Markdown")
}
