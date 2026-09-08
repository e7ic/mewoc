import { getSchema } from "@tiptap/core"
import { createId } from "./create-id.js"
import { createExtensions } from "./create-extensions.js"
import { FORMULA_TYPES, getFormulaSourceError, MAX_FORMULA_TOTAL } from "./formula.js"
import { validateAttachmentMetadata } from "./attachment-assets.js"
import { DEFAULT_PAGE, FONT_FAMILIES, FONT_SIZES, FONT_WEIGHTS, LINE_HEIGHTS, FIRST_LINE_INDENTS, LEFT_INDENTS, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_ASSET_BYTES } from "../constants/editor-constants.js"

const SCHEMA = getSchema(createExtensions())
const NODE_KEYS = ["type", "attrs", "content", "marks", "text"]
const ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/

export function createDocument(welcome = false) {
  const time = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: createId(),
    title: welcome ? "Mewoc · 从这里开始" : "未命名文档",
    content: welcome ? createWelcomeContent() : { type: "doc", content: [{ type: "paragraph" }] },
    page: structuredClone(DEFAULT_PAGE),
    assets: [],
    createdAt: time,
    updatedAt: time
  }
}

function createWelcomeContent() {
  const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
  const heading = text => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] })
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "把想法，写成好文档。" }] },
      paragraph("欢迎来到 Mewoc。一个安静、专注的写作空间，让文字、图片和表格各就其位。你可以直接编辑这份指南，或新建一份空白文档。"),
      { type: "horizontalRule" },
      heading("01  从一段文字开始"),
      paragraph("选中文字，试试上方的字体、颜色和段落工具。用标题梳理结构，左侧大纲会跟着你的思路一起生长。"),
      heading("02  让内容更丰富"),
      paragraph("在「插入」中添加图片和表格。拖动图片右下角调整大小，或在表格中增删行列、合并单元格。"),
      heading("03  安心保存，自由带走"),
      paragraph("文档自动保存在此浏览器中。使用「导出文档」下载包含图片的 Mewoc 文件，就能在另一处继续编辑。打印时，也可以选择另存为 PDF。"),
      { type: "blockquote", content: [paragraph("写作的第一步，是让第一句话出现。")] },
      paragraph("")
    ].filter(node => node.type !== "paragraph" || node.content[0].text !== "")
  }
}

export function validatePage(page) {
  if (!page || page.size !== "A4" || !["portrait", "landscape"].includes(page.orientation)) {
    throw new Error("纸张设置无效，仅支持 A4 横版或竖版")
  }
  const margins = page.marginsMm
  if (!margins || !["top", "right", "bottom", "left"].every(key => Number.isFinite(margins[key]) && margins[key] >= 0)) {
    throw new Error("页边距必须是大于或等于 0 的数字")
  }
  const width = page.orientation === "portrait" ? 210 : 297
  const height = page.orientation === "portrait" ? 297 : 210
  if (margins.left + margins.right > width - 40 || margins.top + margins.bottom > height - 40) {
    throw new Error("页边距过大，请至少保留 40 mm 的正文区域")
  }
}

export function isSafeLink(value) {
  if (typeof value !== "string" || /[\u0000-\u0020]/.test(value)) return false
  try {
    return ["https:", "http:", "mailto:", "tel:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export function validateDocument(record) {
  if (!record || record.schemaVersion !== 1) throw new Error("不支持此文档版本，当前仅支持 schemaVersion 1")
  if (!ID_PATTERN.test(record.id) || typeof record.title !== "string" || record.title.length > 100) {
    throw new Error("文档 ID 或标题无效，标题最多 100 个字符")
  }
  if (![record.createdAt, record.updatedAt].every(value => typeof value === "string" && Number.isFinite(Date.parse(value)))) {
    throw new Error("文档时间字段无效")
  }
  validatePage(record.page)
  validateAssets(record.assets)
  const assetKinds = new Map(record.assets.map(asset => [asset.id, asset.kind || "image"]))
  const budget = { nodes: 0, characters: 0, formulaCharacters: 0 }
  validateNode(record.content, "content", assetKinds, budget, 0)
  if (record.content.type !== "doc") throw new Error("content 必须是 doc 节点")
  SCHEMA.nodeFromJSON(record.content).check()
  return record
}

function validateAssets(assets) {
  if (!Array.isArray(assets)) throw new Error("文档缺少资源清单")
  const ids = new Set()
  let bytes = 0
  assets.forEach(asset => {
    if (!asset || !ID_PATTERN.test(asset.id) || ids.has(asset.id)) throw new Error("资源 ID 无效或重复")
    // 首批文件没有 kind，仅在字段缺省时继续按图片解释。
    if (asset.kind !== undefined && !["image", "attachment"].includes(asset.kind)) throw new Error("资源种类无效")
    if (asset.kind === "attachment") validateAttachmentMetadata(asset)
    else if (!IMAGE_TYPES.includes(asset.mimeType) || !Number.isInteger(asset.byteLength) || asset.byteLength <= 0 || asset.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("图片资源类型或大小无效")
    }
    if (typeof asset.fileName !== "string" || asset.fileName.length > 255) throw new Error("资源文件名无效")
    ids.add(asset.id)
    bytes += asset.byteLength
  })
  if (bytes > MAX_ASSET_BYTES) throw new Error("图片与附件总量超过 20 MiB")
}

function validateNode(node, path, assetKinds, budget, depth) {
  if (!node || typeof node !== "object" || !SCHEMA.nodes[node.type]) throw new Error(`${path}：不支持的节点 ${node?.type}`)
  budget.nodes += 1
  if (depth > 64 || budget.nodes > 50000) throw new Error("文档结构过深或节点过多")
  if (Object.keys(node).some(key => !NODE_KEYS.includes(key))) throw new Error(`${path}：包含未知字段`)
  validateAttrs(node.type, node.attrs, SCHEMA.nodes[node.type].attrs, path)
  if (FORMULA_TYPES.includes(node.type)) {
    const error = getFormulaSourceError(node.attrs?.latex)
    if (error) throw new Error(`${path}：${error}`)
    budget.formulaCharacters += node.attrs.latex.length
    if (budget.formulaCharacters > MAX_FORMULA_TOTAL) throw new Error("文档公式源码总量超过 100000 个字符")
  }
  if (["image", "attachment"].includes(node.type) && assetKinds.get(node.attrs?.assetId) !== node.type) {
    throw new Error(`${path}：${node.type === "image" ? "图片" : "附件"}资源缺失或种类不匹配`)
  }
  if (node.text !== undefined) {
    if (typeof node.text !== "string") throw new Error(`${path}：文本必须是字符串`)
    budget.characters += node.text.length
    if (budget.characters > 2000000) throw new Error("文档文字超过首期容量限制")
  }
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) throw new Error(`${path}：marks 格式无效`)
    node.marks.forEach(mark => {
      if (!mark || !SCHEMA.marks[mark.type]) throw new Error(`${path}：不支持的文字标记 ${mark?.type}`)
      validateAttrs(mark.type, mark.attrs, SCHEMA.marks[mark.type].attrs, path)
    })
  }
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) throw new Error(`${path}：content 格式无效`)
    node.content.forEach((child, index) => validateNode(child, `${path}.${index}`, assetKinds, budget, depth + 1))
  }
}

function validateAttrs(type, attrs, allowed, path) {
  if (attrs === undefined) return
  if (!attrs || Array.isArray(attrs) || typeof attrs !== "object") throw new Error(`${path}：属性格式无效`)
  Object.entries(attrs).forEach(([key, value]) => {
    if (!Object.hasOwn(allowed, key)) throw new Error(`${path}：未知属性 ${key}`)
    if (value === null) return
    if (!isValidAttribute(type, key, value)) throw new Error(`${path}：属性 ${key} 无效`)
  })
}

function isValidAttribute(type, key, value) {
  if (key === "latex" && FORMULA_TYPES.includes(type)) return !getFormulaSourceError(value)
  // Tiptap 的 HTML 解析器以空字符串表示未设置的文字样式，命令则使用 null。
  if (type === "textStyle" && ["color", "backgroundColor", "fontFamily", "fontSize"].includes(key) && value === "") return true
  if (["textAlign", "align"].includes(key)) return ["left", "center", "right", "justify"].includes(value)
  if (key === "lineHeight") return LINE_HEIGHTS.includes(value)
  if (key === "firstLineIndent") return FIRST_LINE_INDENTS.includes(value)
  if (key === "leftIndent") return LEFT_INDENTS.includes(value)
  if (key === "level") return [1, 2, 3].includes(value)
  if (key === "fontFamily") return FONT_FAMILIES.some(font => font.value === value)
  if (key === "fontSize") return FONT_SIZES.includes(value)
  if (key === "fontWeight") return FONT_WEIGHTS.includes(value)
  if (["color", "backgroundColor"].includes(key)) return /^#[0-9a-f]{6}$/i.test(value)
  if (key === "href") return isSafeLink(value)
  if (key === "target") return value === "_blank" || value === "_self"
  if (key === "rel") return value === "noopener noreferrer" || value === "noopener noreferrer nofollow"
  if (key === "assetId") return ID_PATTERN.test(value)
  if (["width", "height"].includes(key)) return Number.isFinite(value) && value > 0 && value <= 20000
  if (["colspan", "rowspan"].includes(key)) return Number.isInteger(value) && value >= 1 && value <= 1000
  if (key === "colwidth") return Array.isArray(value) && value.length <= 1000 && value.every(width => Number.isInteger(width) && width >= 0 && width <= 4000)
  if (type === "orderedList" && key === "start") return Number.isInteger(value) && value > 0
  if (key === "type" && type === "orderedList") return ["1", "a", "A", "i", "I"].includes(value)
  if (["alt", "title", "language", "class"].includes(key)) return typeof value === "string" && value.length <= 1000
  return false
}

export function getReferencedAssetIds(content) {
  const ids = new Set()
  const visit = node => {
    if (["image", "attachment"].includes(node.type)) ids.add(node.attrs.assetId)
    node.content?.forEach(visit)
  }
  visit(content)
  return [...ids]
}

export function checkAssetCapacity(content, assets, incomingBytes = 0) {
  let bytes = incomingBytes
  for (const id of getReferencedAssetIds(content)) {
    const asset = assets.get(id)
    if (!asset) throw new Error("部分资源缺失，请重新打开文档后重试")
    bytes += asset.byteLength
  }
  if (bytes > MAX_ASSET_BYTES) throw new Error("当前文档图片与附件总量不能超过 20 MiB")
}
