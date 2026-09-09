import * as sdk from "docx"
import { createDocxTable } from "./docx-table.js"
import { createDocxFormula } from "./docx-formula.js"
import { validateImageBlob } from "./image-assets.js"
import { highlightCode, MAX_CODE_HIGHLIGHT_LENGTH, MAX_CODE_HIGHLIGHT_TOTAL } from "./code-highlight.js"
import { getCodeLanguage } from "../constants/code-languages.js"

const CODE_COLORS = [
  [["hljs-keyword", "hljs-literal", "hljs-selector-tag"], "6942A3"],
  [["hljs-string", "hljs-regexp"], "2E693A"],
  [["hljs-number", "hljs-symbol"], "8C4E16"],
  [["hljs-comment", "hljs-quote"], "626777"],
  [["hljs-title", "hljs-attr", "hljs-attribute"], "235C98"],
  [["hljs-name", "hljs-tag"], "993F50"],
  [["hljs-built_in", "hljs-type", "hljs-meta"], "756014"]
]
const NUMBER_FORMATS = { "1": "decimal", a: "lowerLetter", A: "upperLetter", i: "lowerRoman", I: "upperRoman" }

export async function createDocumentDocx(document, assets, signal) {
  const margins = document.page.marginsMm
  const landscape = document.page.orientation === "landscape"
  const warnings = new Set()
  const numbering = []
  const context = {
    assets, signal, warnings, numbering, imageBytes: new Map(),
    budget: { nodes: 0, code: 0 }, indent: 0, listDepth: 0,
    widthPx: ((landscape ? 297 : 210) - margins.left - margins.right) * 96 / 25.4,
    heightPx: ((landscape ? 210 : 297) - margins.top - margins.bottom) * 96 / 25.4
  }
  const children = await createBlocks(document.content.content, context)
  signal?.throwIfAborted()
  const file = new sdk.Document({
    creator: "Mewoc", title: document.title,
    styles: { default: { document: {
      run: { font: { ascii: "Arial", hAnsi: "Arial", eastAsia: "PingFang SC" }, size: 24, color: "252837" },
      paragraph: { spacing: { after: 240, line: 420 }, widowControl: true }
    } } },
    numbering: { config: numbering },
    sections: [{
      properties: { page: {
        // SDK 根据 orientation 交换宽高，因此这里始终提供 A4 竖版的基准值。
        size: { width: mmToTwips(210), height: mmToTwips(297), orientation: document.page.orientation },
        margin: Object.fromEntries(Object.entries(margins).map(([name, value]) => [name, mmToTwips(value)]))
      } }, children
    }]
  })
  const blob = await sdk.Packer.toBlob(file)
  // 压缩库不支持中途终止，压缩完成后仍检查取消，旧会话不能弹窗或触发下载。
  signal?.throwIfAborted()
  return { title: document.title, blob, warnings: [...warnings] }
}

async function createBlocks(nodes, parent) {
  const children = []
  let pageBreakBefore = !!parent.pageBreakBefore
  for (const node of nodes) {
    const context = { ...parent, pageBreakBefore }
    context.signal?.throwIfAborted()
    context.budget.nodes += 1
    // 大文档定期让出主线程，让取消/文档切换事件有机会执行；不保留后台循环或计时器。
    if (context.budget.nodes % 64 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0))
      context.signal?.throwIfAborted()
    }
    if (node.type === "pageBreak") {
      if (context.inTable) context.warnings.add("表格内的分页符已保留，具体跨页位置由 Word 的表格排版决定")
      // 普通分页附到下一段，避免独立分页符本身先溢出到新页，再制造一张额外空白页。
      // 连续分页仍输出空段，保留用户明确插入的空白页。
      if (pageBreakBefore) children.push(new sdk.Paragraph({ pageBreakBefore: true, spacing: { after: 0, line: 1, lineRule: "exact" }, run: { size: 2 } }))
      pageBreakBefore = true
      continue
    }
    pageBreakBefore = false
    if (node.type === "paragraph" || node.type === "heading") children.push(await createParagraph(node, context))
    else if (node.type === "table") {
      if (context.pageBreakBefore) children.push(new sdk.Paragraph({ pageBreakBefore: true, keepNext: true, spacing: { after: 0, line: 1, lineRule: "exact" }, run: { size: 2 } }))
      children.push(await createDocxTable(node, { ...context, pageBreakBefore: false }, createBlocks))
    }
    else if (node.type === "bulletList" || node.type === "orderedList") children.push(...await createList(node, context))
    else if (node.type === "blockquote") children.push(...await createBlocks(node.content, { ...context, indent: context.indent + 300, quote: true }))
    else if (node.type === "image") children.push(await createImage(node, context))
    else if (node.type === "codeBlock") children.push(await createCode(node, context))
    else if (node.type === "blockMath") children.push(new sdk.Paragraph({
      children: [await createDocxFormula(node.attrs.latex, true, context.warnings)], alignment: "center", indent: { left: context.indent }, pageBreakBefore: context.pageBreakBefore
    }))
    else if (node.type === "horizontalRule") children.push(new sdk.Paragraph({
      border: { bottom: { style: "single", size: 6, color: "EAEAF0" } }, spacing: { before: 180, after: 180 }, indent: { left: context.indent }, pageBreakBefore: context.pageBreakBefore
    }))
    else if (node.type === "attachment") {
      const asset = context.assets.get(node.attrs.assetId)
      context.warnings.add("附件保留文件名和大小，不在 Word 文档中嵌入文件；完整备份请使用 Mewoc 文件")
      children.push(new sdk.Paragraph({ text: `附件：${asset.fileName}（${asset.byteLength} B）`, indent: { left: context.indent }, pageBreakBefore: context.pageBreakBefore }))
    } else throw new Error(`Word 导出暂不支持节点 ${node.type}`)
  }
  if (pageBreakBefore) children.push(new sdk.Paragraph({ pageBreakBefore: true, spacing: { after: 0, line: 1, lineRule: "exact" }, run: { size: 2 } }))
  return children
}

async function createParagraph(node, context, numbering) {
  const attrs = node.attrs || {}
  const level = node.type === "heading" ? attrs.level : 0
  const size = level ? [0, 22.5, 15, 12.75][level] : 12
  const defaults = { size, bold: !!level || context.header, color: context.quote ? "797087" : "252837" }
  const children = []
  for (const child of node.content || []) {
    context.signal?.throwIfAborted()
    if (child.type === "inlineMath") children.push(await createDocxFormula(child.attrs.latex, false, context.warnings))
    else children.push(createInline(child, defaults, context))
  }
  const indent = { left: context.indent + (attrs.leftIndent || 0) * size * 20 }
  if (numbering) indent.hanging = 240
  else indent.firstLine = (attrs.firstLineIndent || 0) * size * 20
  return new sdk.Paragraph({
    children, pageBreakBefore: context.pageBreakBefore, ...(level && { heading: `Heading${level}`, keepNext: true }),
    ...(numbering && { numbering }),
    alignment: attrs.textAlign || "left", indent,
    // 行距 auto 以 240 为单倍；缩进是 em 倍数，先乘基础字号，再以每磅 20 twip 转换。
    spacing: { after: context.inTable || context.quote ? 0 : context.listDepth ? 72 : 240, line: Math.round((attrs.lineHeight || (level ? 1.5 : 1.75)) * 240) },
    ...(context.quote && { shading: { fill: "F6F4FB" }, border: { left: { style: "single", size: 18, color: "B6ABD9", space: 8 } } })
  })
}

function createInline(node, defaults, context) {
  if (node.type === "hardBreak") return new sdk.TextRun({ break: 1 })
  if (node.type !== "text") throw new Error(`Word 导出暂不支持行内节点 ${node.type}`)
  const marks = node.marks || []
  const style = marks.find(mark => mark.type === "textStyle")?.attrs || {}
  const link = marks.find(mark => mark.type === "link")
  const points = style.fontSize ? parseFloat(style.fontSize) : defaults.size
  const size = Math.round(points * 2)
  if (size !== points * 2) context.warnings.add("Word 字号以半磅为单位，部分字号已取最近的半磅")
  const types = marks.map(mark => mark.type)
  const weight = style.fontWeight ? Number(style.fontWeight) : null
  if (weight && ![400, 700].includes(weight)) context.warnings.add("数值字重已转换为 Word 的常规或加粗")
  const run = new sdk.TextRun({
    text: node.text, size, bold: weight ? weight >= 600 : !!defaults.bold || types.includes("bold"),
    italics: types.includes("italic"), strike: types.includes("strike"),
    ...((types.includes("underline") || link) && { underline: {} }),
    color: style.color ? style.color.slice(1) : link ? "6942A3" : defaults.color,
    ...(style.backgroundColor && { shading: { fill: style.backgroundColor.slice(1) } }),
    ...(style.fontFamily && { font: style.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "") }),
    ...(types.includes("code") && { font: "Menlo", shading: { fill: "F6F6F8" } })
  })
  return link ? new sdk.ExternalHyperlink({ children: [run], link: link.attrs.href }) : run
}

async function createList(node, context) {
  const level = Math.min(context.listDepth, 8)
  if (context.listDepth > 8) context.warnings.add("超过九层的列表保留缩进，Word 编号层级按第九层输出")
  const reference = `mewoc-list-${context.numbering.length + 1}`
  const ordered = node.type === "orderedList"
  const indent = context.indent + 480
  context.numbering.push({ reference, levels: [{
    level, format: ordered ? NUMBER_FORMATS[node.attrs?.type || "1"] : "bullet",
    text: ordered ? `%${level + 1}.` : ["•", "◦", "▪"][context.listDepth % 3],
    start: ordered ? node.attrs?.start || 1 : 1, alignment: "left",
    style: { paragraph: { indent: { left: indent, hanging: 240 } }, run: { font: "Arial", size: 24 } }
  }] })
  const children = []
  const itemContext = { ...context, indent, listDepth: context.listDepth + 1 }
  for (const item of node.content) {
    context.signal?.throwIfAborted()
    context.budget.nodes += 1
    if (context.budget.nodes % 64 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0))
      context.signal?.throwIfAborted()
    }
    children.push(await createParagraph(item.content[0], itemContext, { reference, level }))
    itemContext.pageBreakBefore = false
    children.push(...await createBlocks(item.content.slice(1), itemContext))
  }
  return children
}

async function createImage(node, context) {
  const asset = context.assets.get(node.attrs.assetId)
  if (!context.imageBytes.has(asset.id)) {
    await validateImageBlob(asset.blob)
    const blob = asset.mimeType === "image/webp" ? await convertWebp(asset.blob, context) : asset.blob
    context.imageBytes.set(asset.id, { type: blob.type === "image/png" ? "png" : "jpg", data: new Uint8Array(await blob.arrayBuffer()) })
  }
  context.signal?.throwIfAborted()
  const available = context.widthPx - context.indent / 15
  if (available < 1) throw new Error("图片可用宽度过小，请减少缩进后导出")
  const ratio = Math.min(1, available / node.attrs.width, Math.max(1, context.heightPx - 32) / node.attrs.height)
  if (ratio < 1) context.warnings.add("超出正文、单元格宽度或单页高度的图片已等比缩小")
  return new sdk.Paragraph({
    indent: { left: context.indent }, pageBreakBefore: context.pageBreakBefore, children: [new sdk.ImageRun({
      ...context.imageBytes.get(asset.id), transformation: { width: node.attrs.width * ratio, height: node.attrs.height * ratio },
      altText: { name: asset.fileName, title: node.attrs.title || asset.fileName, description: node.attrs.alt || "" }
    })]
  })
}

async function convertWebp(blob, context) {
  const image = await createImageBitmap(blob)
  const canvas = document.createElement("canvas")
  try {
    context.signal?.throwIfAborted()
    if (image.width * image.height > 40000000) throw new Error("WebP 图片像素过多，请缩小后导出")
    // 限制临时 Canvas 为四百万像素，透明背景继续保留；不复制编辑视图中的缩放尺寸。
    const ratio = Math.min(1, Math.sqrt(4000000 / (image.width * image.height)))
    canvas.width = Math.max(1, Math.round(image.width * ratio))
    canvas.height = Math.max(1, Math.round(image.height * ratio))
    const painter = canvas.getContext("2d")
    if (!painter) throw new Error("浏览器无法转换 WebP 图片，请改用 PNG 后重试")
    painter.drawImage(image, 0, 0, canvas.width, canvas.height)
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
    if (!png) throw new Error("WebP 转 PNG 失败，请重试导出")
    context.warnings.add("WebP 图片已转换为 PNG，动画图片仅保留静态画面")
    if (ratio < 1) context.warnings.add("大尺寸 WebP 已缩小至四百万像素以内")
    return png
  } finally {
    image.close()
    canvas.width = 0
    canvas.height = 0
  }
}

async function createCode(node, context) {
  const source = (node.content || []).map(child => child.text).join("")
  const language = getCodeLanguage(node.attrs?.language)
  let tokens = [{ text: source, classes: [] }]
  if (language !== "plaintext") {
    if (source.length > MAX_CODE_HIGHLIGHT_LENGTH || context.budget.code + source.length > MAX_CODE_HIGHLIGHT_TOTAL) {
      context.warnings.add("部分代码超过着色限额，已保留完整源码与换行")
    } else {
      context.budget.code += source.length
      try { tokens = await highlightCode(source, language) }
      catch { context.warnings.add("部分代码着色失败，已保留完整源码与换行") }
    }
  } else if (node.attrs?.language && node.attrs.language !== "plaintext") context.warnings.add("未支持的代码语言已按纯文本保留")
  const children = []
  for (const token of tokens) {
    const color = CODE_COLORS.find(([classes]) => classes.some(name => token.classes.includes(name)))?.[1] || "252837"
    token.text.split("\n").forEach((text, index) => children.push(new sdk.TextRun({ text, break: index ? 1 : 0, font: "Menlo", size: 22, color })))
  }
  return new sdk.Paragraph({
    children, indent: { left: context.indent }, pageBreakBefore: context.pageBreakBefore, spacing: { line: 300, after: 240 },
    shading: { fill: "F6F6F8" }, wordWrap: true, widowControl: false
  })
}

function mmToTwips(value) {
  return Math.round(value * 1440 / 25.4)
}
