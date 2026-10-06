/**
 * Markdown 双向转换的共享配置层：统一 GFM 与数学语法，导入/导出都经过 AST。
 * 此模块按需加载，文档创建与 Schema 规范化集中在这里，文件 IO 与 UI 状态交给调用方。
 */
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkStringify from "remark-stringify"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import { generateText, getSchema } from "@tiptap/core"
import { createDocument, validateDocument } from "./document-schema.js"
import { createExtensions } from "./create-extensions.js"
import { createMarkdownContent } from "./markdown-import.js"
import { createMarkdownTree } from "./markdown-export.js"

// 导入与导出共享 GFM/公式语法配置；先在 AST 层转换，再由 stringify 处理 Markdown 转义。
const MARKDOWN = unified().use(remarkParse).use(remarkStringify, { bullet: "-", emphasis: "_", strong: "*", fences: true, incrementListMarker: false })
  .use(remarkGfm, { singleTilde: false }).use(remarkMath)
// 与实际编辑器使用相同扩展构造 Schema，复用默认属性、标记顺序和内容约束。
const SCHEMA = getSchema(createExtensions())

// 转换只构造待确认的新文档，不修改当前会话；warnings 与纯文本预览交给导入弹窗展示。
export function readMarkdownDocument(source, title) {
  const tree = MARKDOWN.parse(source)
  const { content, warnings } = createMarkdownContent(tree)
  const document = { ...createDocument(), title: title.trim() || "Markdown 文档", content }
  validateDocument(document)
  // 与编辑器载入时使用同一 mark 排序、默认属性和相邻文本合并规则。
  document.content = SCHEMA.nodeFromJSON(content).toJSON()
  const preview = generateText(document.content, createExtensions())
  return { record: { document, storageVersion: 0, assets: new Map() }, warnings, preview }
}

/** 先生成语义 AST，再让 remark 处理围栏/转义/分隔符，返回文本与无法保留内容的说明。 */
export function createDocumentMarkdown(document) {
  const { tree, warnings } = createMarkdownTree(document)
  return { source: MARKDOWN.stringify(tree), warnings, title: document.title }
}
