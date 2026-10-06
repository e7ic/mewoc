/**
 * 定义 Mewoc 文档对象的创建与统一校验边界，以及正文资源引用的容量计算。
 * 文档 JSON 先满足产品允许的属性、资源和预算，再满足实际编辑 schema；此模块不修复输入。
 */
import { getSchema } from "@tiptap/core"
import { createId } from "./create-id.js"
import { createExtensions } from "./create-extensions.js"
import { FORMULA_TYPES, getFormulaSourceError, MAX_FORMULA_TOTAL } from "./formula.js"
import { validateAttachmentMetadata } from "./attachment-assets.js"
import { validateMediaMetadata } from "./media-assets.js"
import { validateCommentThreads } from "./document-comments.js"
import { BLOCK_CONTAINER_TYPES, validateBlockContainerAttrs } from "./block-containers.js"
import { isNavigationId, isSafeDocumentLink, validateNavigationBlockAttrs, validateTableOfContentsAttrs } from "./document-navigation.js"
import { validatePageSettings } from "./page-settings.js"
import { DEFAULT_PAGE, FONT_FAMILIES, FONT_SIZES, FONT_WEIGHTS, LINE_HEIGHTS, FIRST_LINE_INDENTS, LEFT_INDENTS, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_ASSET_BYTES } from "../constants/editor-constants.js"

// 校验与编辑使用同一组扩展，新增节点/属性需同时更新下方业务白名单。
const SCHEMA = getSchema(createExtensions())
const NODE_KEYS = ["type", "attrs", "content", "marks", "text"]
const ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/

// 新文档获得独立 ID、时间和纸张对象；普通空文档保留一个段落以满足可编辑正文结构。
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

// 直接使用 schema JSON 构建可编辑引导内容，不经 HTML 转换，保证首次打开与普通正文结构一致。
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
      paragraph("文档自动保存在此浏览器中。在「导出」中下载包含图片的 Mewoc 文档，就能在另一处继续编辑。打印时，也可以选择另存为 PDF。"),
      { type: "blockquote", content: [paragraph("写作的第一步，是让第一句话出现。")] },
      paragraph("")
    ].filter(node => node.type !== "paragraph" || node.content[0].text !== "")
  }
}

// 文档、历史和模板沿用原入口，纸型、边距与水印由共享页面契约统一校验，旧文件不改写。
export function validatePage(page) {
  return validatePageSettings(page)
}

// 链接必须是可解析的绝对 URL 且协议在白名单内；空白和控制字符提前拒绝，避免解释歧义。
export function isSafeLink(value) {
  return isSafeDocumentLink(value)
}

/**
 * 文档进入编辑器、保存或文件交换前的统一契约校验，失败直接抛出可展示的错误。
 * 先检查业务白名单、容量及资源引用，再由 ProseMirror 检查父子节点组合是否合法。
 * 返回原对象，不迁移未知字段，也不静默删除不支持的内容。
 */
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
  const threads = record.content?.attrs?.commentThreads ?? null
  validateCommentThreads(threads)
  const commentIds = new Set((threads || []).map(thread => thread.id))
  // 全树共用预算，避免深层嵌套或大量小节点绕过单节点限制。
  const budget = { nodes: 0, characters: 0, formulaCharacters: 0, commentIds, navigationIds: new Set() }
  validateNode(record.content, "content", assetKinds, budget, 0)
  if (record.content.type !== "doc") throw new Error("content 必须是 doc 节点")
  SCHEMA.nodeFromJSON(record.content).check()
  return record
}

// 资源清单先校验种类、重复 ID、单资源声明与总字节预算，再供正文节点检查引用。
// 此处只检查元数据，实际 Blob 类型/字节和图像头部由读取、保存或导出流程核对。
function validateAssets(assets) {
  if (!Array.isArray(assets)) throw new Error("文档缺少资源清单")
  const ids = new Set()
  let bytes = 0
  assets.forEach(asset => {
    if (!asset || !ID_PATTERN.test(asset.id) || ids.has(asset.id)) throw new Error("资源 ID 无效或重复")
    // 首批文件没有 kind，仅在字段缺省时继续按图片解释。
    if (asset.kind !== undefined && !["image", "attachment", "audio", "video"].includes(asset.kind)) throw new Error("资源种类无效")
    if (asset.kind === "attachment") validateAttachmentMetadata(asset)
    else if (["audio", "video"].includes(asset.kind)) validateMediaMetadata(asset)
    else if (!IMAGE_TYPES.includes(asset.mimeType) || !Number.isInteger(asset.byteLength) || asset.byteLength <= 0 || asset.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("图片资源类型或大小无效")
    }
    if (typeof asset.fileName !== "string" || asset.fileName.length > 255) throw new Error("资源文件名无效")
    ids.add(asset.id)
    bytes += asset.byteLength
  })
  if (bytes > MAX_ASSET_BYTES) throw new Error("图片、附件与音视频资源总量超过 20 MiB")
}

// 递归验证节点和 marks，path 定位具体损坏位置；全树共享预算避免深度或碎片节点放大处理成本。
function validateNode(node, path, assetKinds, budget, depth) {
  if (!node || typeof node !== "object" || !SCHEMA.nodes[node.type]) throw new Error(`${path}：不支持的节点 ${node?.type}`)
  budget.nodes += 1
  if (depth > 64 || budget.nodes > 50000) throw new Error("文档结构过深或节点过多")
  if (Object.keys(node).some(key => !NODE_KEYS.includes(key))) throw new Error(`${path}：包含未知字段`)
  validateAttrs(node.type, node.attrs, SCHEMA.nodes[node.type].attrs, path)
  if (["paragraph", "heading"].includes(node.type)) {
    const error = validateNavigationBlockAttrs(node.attrs || {})
    if (error) throw new Error(`${path}：${error}`)
    const id = node.attrs?.navigationId
    if (isNavigationId(id)) {
      if (budget.navigationIds.has(id)) throw new Error(`${path}：导航 ID 重复`)
      budget.navigationIds.add(id)
    }
  }
  if (node.type === "tableOfContents") {
    const error = validateTableOfContentsAttrs(node.attrs || {})
    if (error) throw new Error(`${path}：${error}`)
    // 目录的快照在 attrs 中，不是子节点；同样计入全树预算，不能用大量目录绕过正文容量上限。
    const entries = node.attrs?.entries || []
    budget.nodes += entries.length
    budget.characters += (node.attrs?.title || "目录").length + entries.reduce((sum, entry) => sum + entry.text.length, 0)
    if (budget.nodes > 50000) throw new Error("文档结构过深或节点过多")
    if (budget.characters > 2000000) throw new Error("文档文字超过首期容量限制")
  }
  // 容器中的正常富文本继续使用既有预算；导入的合法嵌套保留，但插入命令不再创建新的容器嵌套。
  if (BLOCK_CONTAINER_TYPES.includes(node.type)) {
    const error = validateBlockContainerAttrs(node.type, node.attrs || {})
    if (error) throw new Error(`${path}：${error}`)
  }
  if (FORMULA_TYPES.includes(node.type)) {
    const error = getFormulaSourceError(node.attrs?.latex)
    if (error) throw new Error(`${path}：${error}`)
    budget.formulaCharacters += node.attrs.latex.length
    if (budget.formulaCharacters > MAX_FORMULA_TOTAL) throw new Error("文档公式源码总量超过 100000 个字符")
  }
  if (["image", "attachment"].includes(node.type) && assetKinds.get(node.attrs?.assetId) !== node.type) {
    throw new Error(`${path}：${node.type === "image" ? "图片" : "附件"}资源缺失或种类不匹配`)
  }
  if (node.type === "media" && !["audio", "video"].includes(assetKinds.get(node.attrs?.assetId))) {
    throw new Error(`${path}：音视频资源缺失或种类不匹配`)
  }
  // 只累计真实文本字段；公式源码单独计入公式预算，资源数据单独计入资源预算。
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
      if (mark.type === "commentAnchor") {
        // 删除全部原文后允许保留孤立线程；反过来，正文锚点必须有真实线程。
        if (node.type !== "text" || !budget.commentIds.has(mark.attrs?.id)) throw new Error(`${path}：批注锚点缺少对应批注或不在文字上`)
        if (node.marks.filter(item => item.type === "commentAnchor").length !== 1) throw new Error(`${path}：批注锚点重复`)
      }
    })
    if (node.marks.some(mark => mark.type === "superscript") && node.marks.some(mark => mark.type === "subscript")) {
      throw new Error(`${path}：同一段文字不能同时设置上标和下标`)
    }
  }
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) throw new Error(`${path}：content 格式无效`)
    node.content.forEach((child, index) => validateNode(child, `${path}.${index}`, assetKinds, budget, depth + 1))
  }
}

// 先按 schema 声明拒绝未知键，再按业务规则检查值；null 保留为继承或未设置的合法状态。
function validateAttrs(type, attrs, allowed, path) {
  if (attrs === undefined) return
  if (!attrs || Array.isArray(attrs) || typeof attrs !== "object") throw new Error(`${path}：属性格式无效`)
  Object.entries(attrs).forEach(([key, value]) => {
    if (!Object.hasOwn(allowed, key)) throw new Error(`${path}：未知属性 ${key}`)
    // checked 没有“继承”状态；显式 null 也必须拒绝，避免勾选 UI 与文件语义不一致。
    if (type === "taskItem" && key === "checked" && typeof value !== "boolean") throw new Error(`${path}：属性 checked 无效`)
    if (value === null) return
    if (!isValidAttribute(type, key, value)) throw new Error(`${path}：属性 ${key} 无效`)
  })
}

// 字号按带单位的 pt 字符串、图片/列宽按未缩放 px、缩进按 em 倍数校验。
// 属性即使存在于第三方 schema，也必须在此明确允许后才能进入持久化文档。
function isValidAttribute(type, key, value) {
  if (["paragraph", "heading"].includes(type) && key === "navigationId") return isNavigationId(value)
  if (["paragraph", "heading"].includes(type) && key === "bookmarkName") return !validateNavigationBlockAttrs({ navigationId: "nav-00000000-0000-4000-8000-000000000000", bookmarkName: value })
  if (type === "tableOfContents") return !validateTableOfContentsAttrs({ [key]: value })
  if (BLOCK_CONTAINER_TYPES.includes(type)) return !validateBlockContainerAttrs(type, { [key]: value })
  if (type === "doc" && key === "commentThreads") { validateCommentThreads(value); return true }
  if (type === "taskItem" && key === "checked") return typeof value === "boolean"
  if (type === "commentAnchor" && key === "id") return typeof value === "string" && ID_PATTERN.test(value)
  // 精细设置同样进入文件契约，限定数值和枚举，不能把任意 CSS 从外部文件写入正文。
  if (type === "image" && key === "align") return ["left", "center", "right"].includes(value)
  if (type === "image" && key === "lockAspectRatio") return typeof value === "boolean"
  if (type === "tableRow" && key === "minHeight") return Number.isInteger(value) && value >= 1 && value <= 1000
  // 段落间距使用 pt，允许半磅；null 在上层保留为沿用样式，显式 0/false 不作默认值处理。
  if (["paragraph", "heading"].includes(type)) {
    if (["spaceBefore", "spaceAfter"].includes(key)) return typeof value === "number" && Number.isInteger(value * 2) && value >= 0 && value <= 120
    if (["keepWithNext", "keepTogether"].includes(key)) return typeof value === "boolean"
  }
  if (["tableCell", "tableHeader"].includes(type)) {
    if (key === "verticalAlign") return ["top", "middle", "bottom"].includes(value)
    if (["paddingX", "paddingY"].includes(key)) return Number.isInteger(value) && value >= 0 && value <= 40
    if (key === "borderWidth") return Number.isInteger(value) && value >= 0 && value <= 6
    if (key === "borderStyle") return ["solid", "dashed", "dotted", "none"].includes(value)
    if (key === "borderColor") return /^#[0-9a-f]{6}$/i.test(value)
  }
  if (key === "latex" && FORMULA_TYPES.includes(type)) return !getFormulaSourceError(value)
  // Tiptap 的 HTML 解析器以空字符串表示未设置的文字样式，命令则使用 null。
  if (type === "textStyle" && ["color", "backgroundColor", "fontFamily", "fontSize"].includes(key) && value === "") return true
  if (["textAlign", "align"].includes(key)) return ["left", "center", "right", "justify"].includes(value)
  if (key === "lineHeight") return LINE_HEIGHTS.includes(value)
  if (key === "firstLineIndent") return FIRST_LINE_INDENTS.includes(value)
  if (key === "leftIndent") return LEFT_INDENTS.includes(value)
  if (key === "level") return [1, 2, 3, 4, 5, 6].includes(value)
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

// 遍历正文收集所有资源的去重 ID，供保存清理、备份和容量计算使用；重复引用不重复计费。
export function getReferencedAssetIds(content) {
  const ids = new Set()
  const visit = node => {
    if (["image", "attachment", "media"].includes(node.type)) ids.add(node.attrs.assetId)
    node.content?.forEach(visit)
  }
  visit(content)
  return [...ids]
}

// 只计算当前正文的去重引用，删除后留在会话里供撤销使用的资源不占当前文档额度。
export function checkAssetCapacity(content, assets, incomingBytes = 0) {
  let bytes = incomingBytes
  for (const id of getReferencedAssetIds(content)) {
    const asset = assets.get(id)
    if (!asset) throw new Error("部分资源缺失，请重新打开文档后重试")
    bytes += asset.byteLength
  }
  if (bytes > MAX_ASSET_BYTES) throw new Error("当前文档图片、附件与音视频资源总量不能超过 20 MiB")
}
