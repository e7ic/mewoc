import { validateDocument } from "../../src/pages/editor/tools/document-schema.js"
import { validateImageBlob } from "../../src/pages/editor/tools/image-assets.js"

// 仅供 M7 样例验证。由脚本注入固定版本 SDK，避免实验依赖进入生产包。
// 输入仍是应用快照及资源 Map；转换只读取它们，不接触 editor、存储或临时 URL。
export async function createDocxPrototype(source, assets, sdk) {
  const document = validateDocument(structuredClone(source))
  for (const asset of document.assets) {
    const entry = assets.get(asset.id)
    if (!entry?.blob || entry.blob.size !== asset.byteLength || entry.blob.type !== asset.mimeType) throw new Error(`资源「${asset.fileName}」缺失或声明不匹配`)
  }
  const warnings = new Set()
  const margins = document.page.marginsMm
  const landscape = document.page.orientation === "landscape"
  const widthMm = landscape ? 297 : 210
  const widthPx = (widthMm - margins.left - margins.right) * 96 / 25.4
  const context = { sdk, assets, warnings, widthPx }
  const children = []
  for (const node of document.content.content) children.push(await createBlock(node, context))
  const file = new sdk.Document({
    creator: "Mewoc", title: document.title,
    styles: {
      default: {
        document: {
          run: { font: { ascii: "Arial", hAnsi: "Arial", eastAsia: "PingFang SC" }, size: 24, color: "252837" },
          paragraph: { spacing: { after: 240, line: 420 } }
        }
      }
    },
    sections: [{
      properties: { page: {
        // docx SDK 接受竖向基准宽高；横向时由 SDK 交换，不能在调用方再交换一次。
        size: { width: mmToTwips(210), height: mmToTwips(297), orientation: landscape ? "landscape" : "portrait" },
        margin: Object.fromEntries(Object.entries(margins).map(([name, value]) => [name, mmToTwips(value)]))
      } },
      children
    }]
  })
  return { file, warnings: [...warnings] }
}

async function createBlock(node, context) {
  const { sdk, warnings } = context
  if (node.type === "paragraph" || node.type === "heading") return createParagraph(node, context)
  if (node.type === "pageBreak") return new sdk.Paragraph({ children: [new sdk.PageBreak()], spacing: { before: 0, after: 0 } })
  if (node.type === "image") return createImage(node, context)
  if (node.type === "table") return createTable(node, context)
  if (node.type === "blockMath") {
    warnings.add("公式暂以 LaTeX 原文输出，不是 Word 原生公式")
    return new sdk.Paragraph({ children: [new sdk.TextRun(node.attrs.latex)], alignment: "center" })
  }
  if (node.type === "codeBlock") {
    warnings.add("代码块保留源码与换行，本样例不转换语法高亮")
    const lines = (node.content || []).map(child => child.text).join("").split("\n")
    return new sdk.Paragraph({
      children: lines.map((text, index) => new sdk.TextRun({ text, break: index ? 1 : 0, font: "Menlo", size: 22 })),
      spacing: { line: 300, after: 240 }, shading: { fill: "F6F6F8" }
    })
  }
  if (node.type === "attachment") {
    const asset = context.assets.get(node.attrs.assetId)
    if (!asset) throw new Error("附件资源缺失")
    warnings.add("附件暂保留文件名和大小，不在 DOCX 内嵌文件；完整备份请使用 Mewoc 文件")
    return new sdk.Paragraph({ text: `附件：${asset.fileName}（${asset.byteLength} B）` })
  }
  // 最小验证范围外的结构明确拒绝，不能展平后把丢失的结构描述为支持。
  throw new Error(`DOCX 样例暂不支持节点 ${node.type}`)
}

function createParagraph(node, context, header = false) {
  const { sdk } = context
  const attrs = node.attrs || {}
  const level = node.type === "heading" ? attrs.level : 0
  const size = level ? [0, 22.5, 15, 12.75][level] : 12
  const defaults = { size, bold: !!level || header, color: level ? "242633" : "252837" }
  return new sdk.Paragraph({
    children: (node.content || []).map(child => createInline(child, defaults, context)),
    ...(level && { heading: `Heading${level}`, keepNext: true }),
    alignment: attrs.textAlign || "left",
    // OOXML 行距 auto 以 240 表示单倍；段落缩进从字符 em 换算为 pt，再转 twip。
    spacing: { after: level ? 220 : 240, line: Math.round((attrs.lineHeight || (level ? 1.5 : 1.75)) * 240) },
    indent: { firstLine: (attrs.firstLineIndent || 0) * size * 20, left: (attrs.leftIndent || 0) * size * 20 }
  })
}

function createInline(node, defaults, context) {
  const { sdk, warnings } = context
  if (node.type === "hardBreak") return new sdk.TextRun({ break: 1 })
  if (node.type === "inlineMath") {
    warnings.add("公式暂以 LaTeX 原文输出，不是 Word 原生公式")
    return new sdk.TextRun(node.attrs.latex)
  }
  if (node.type !== "text") throw new Error(`DOCX 样例暂不支持行内节点 ${node.type}`)
  const marks = node.marks || []
  const style = marks.find(mark => mark.type === "textStyle")?.attrs || {}
  const points = style.fontSize ? parseFloat(style.fontSize) : defaults.size
  const size = Math.round(points * 2)
  if (size !== points * 2) warnings.add("Word 字号以半磅为单位，部分字号已取最近的半磅")
  const markTypes = marks.map(mark => mark.type)
  const weight = style.fontWeight ? Number(style.fontWeight) : null
  if (weight && ![400, 700].includes(weight)) warnings.add("Word 本样例将数值字重转换为常规或加粗")
  const run = new sdk.TextRun({
    text: node.text, size,
    bold: weight ? weight >= 600 : defaults.bold || markTypes.includes("bold"),
    italics: markTypes.includes("italic"), strike: markTypes.includes("strike"),
    ...(markTypes.includes("underline") && { underline: {} }),
    color: style.color ? toColor(style.color) : defaults.color,
    ...(style.backgroundColor && { shading: { fill: toColor(style.backgroundColor) } }),
    ...(style.fontFamily && { font: style.fontFamily.split(",")[0].trim() }),
    ...(markTypes.includes("code") && { font: "Menlo" })
  })
  const link = marks.find(mark => mark.type === "link")
  return link ? new sdk.ExternalHyperlink({ children: [run], link: link.attrs.href }) : run
}

async function createImage(node, context) {
  const { sdk, assets, warnings, widthPx } = context
  const asset = assets.get(node.attrs.assetId)
  if (!asset?.blob || asset.blob.size !== asset.byteLength || asset.blob.type !== asset.mimeType) throw new Error("图片资源缺失或声明不匹配")
  await validateImageBlob(asset.blob)
  if (asset.mimeType === "image/webp") throw new Error("DOCX 样例尚未实现 WebP 转 PNG")
  const ratio = Math.min(1, widthPx / node.attrs.width)
  if (ratio < 1) warnings.add("超出正文宽度的图片已等比缩小")
  return new sdk.Paragraph({ children: [new sdk.ImageRun({
    type: asset.mimeType === "image/png" ? "png" : "jpg",
    data: new Uint8Array(await asset.blob.arrayBuffer()),
    transformation: { width: node.attrs.width * ratio, height: node.attrs.height * ratio },
    altText: { name: asset.fileName, title: node.attrs.title || asset.fileName, description: node.attrs.alt || "" }
  })] })
}

function createTable(node, context) {
  const { sdk, widthPx } = context
  const first = node.content[0].content
  if (node.content.some(row => row.content.length !== first.length || row.content.some(cell => (cell.attrs?.colspan || 1) !== 1 || (cell.attrs?.rowspan || 1) !== 1))) {
    throw new Error("DOCX 样例尚未实现合并单元格")
  }
  const columns = first.map(cell => cell.attrs?.colwidth?.[0] || widthPx / first.length)
  let total = 0
  columns.forEach(width => { total += width })
  if (total > widthPx + 1) throw new Error("表格超出纸张正文宽度，请调整列宽或使用横版")
  const border = { style: "single", size: 4, color: "D9DBE5" }
  return new sdk.Table({
    layout: "fixed", width: { size: Math.round(total * 15), type: "dxa" }, columnWidths: columns.map(width => Math.round(width * 15)),
    rows: node.content.map(row => new sdk.TableRow({
      tableHeader: row.content.every(cell => cell.type === "tableHeader"),
      children: row.content.map((cell, index) => new sdk.TableCell({
        width: { size: Math.round(columns[index] * 15), type: "dxa" },
        borders: { top: border, bottom: border, left: border, right: border },
        ...(cell.type === "tableHeader" && { shading: { fill: "F2F1F8" } }),
        children: cell.content.map(child => {
          if (child.type !== "paragraph") throw new Error("DOCX 样例表格仅支持段落内容")
          return createParagraph(child, context, cell.type === "tableHeader")
        })
      }))
    }))
  })
}

function mmToTwips(value) {
  return Math.round(value * 1440 / 25.4)
}

function toColor(value) {
  const hex = value.slice(1)
  return hex.length === 3 ? [...hex].map(character => character.repeat(2)).join("") : hex
}
