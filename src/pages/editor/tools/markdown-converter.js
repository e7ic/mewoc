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

export function createDocumentMarkdown(document) {
  const { tree, warnings } = createMarkdownTree(document)
  return { source: MARKDOWN.stringify(tree), warnings, title: document.title }
}
