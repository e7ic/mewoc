/**
 * 已校验文档快照到 DOCX 的正式转换器：递归生成段落、列表、表格、图片、公式和附录。
 * context 传递排版环境，warnings/numbering/缓存/预算在子树间共享，取消在异步与长循环边界检查。
 * 无法表达的内容会明确报错或保留完整文字并提示，返回 Blob 后才由调用方决定下载。
 */
import * as sdk from "docx"
import { createDocxTable } from "./docx-table.js"
import { createDocxFormula } from "./docx-formula.js"
import { validateImageBlob } from "./image-assets.js"
import { highlightCode, MAX_CODE_HIGHLIGHT_LENGTH, MAX_CODE_HIGHLIGHT_TOTAL } from "./code-highlight.js"
import { getCodeLanguage } from "../constants/code-languages.js"
import { getCommentAppendix, COMMENT_APPENDIX_HEADING, COMMENT_APPENDIX_INTRO, COMMENT_WORD_WARNING } from "./comment-export.js"
import { TEXT_BOX_DEFAULTS, DETAILS_DEFAULTS } from "./block-containers.js"
import { isInternalNavigationHref } from "./document-navigation.js"
import { prepareNavigationExportContent, MISSING_NAVIGATION_WARNING } from "./navigation-export.js"
import { PAGE_SIZES, getPageContentDimensions } from "./page-settings.js"
import { createDocxWatermarkHeader } from "./docx-watermark.js"

// 语法着色类到 Word 色值的固定映射，OOXML 使用不含 # 的十六进制 RGB。
const CODE_COLORS = [
  [["hljs-keyword", "hljs-literal", "hljs-selector-tag"], "6942A3"],
  [["hljs-string", "hljs-regexp"], "2E693A"],
  [["hljs-number", "hljs-symbol"], "8C4E16"],
  [["hljs-comment", "hljs-quote"], "626777"],
  [["hljs-title", "hljs-attr", "hljs-attribute"], "235C98"],
  [["hljs-name", "hljs-tag"], "993F50"],
  [["hljs-built_in", "hljs-type", "hljs-meta"], "756014"]
]
// 编辑器编号类型映射到 SDK 格式；标题字号按 pt 保存，生成文字 run 时再转为半磅。
const NUMBER_FORMATS = { "1": "decimal", a: "lowerLetter", A: "upperLetter", i: "lowerRoman", I: "upperRoman" }
const HEADING_POINTS = [0, 22.5, 15, 12.75, 11.25, 10.5, 9.75]
// SDK 已注册 Heading4–6，覆盖其默认项而不新增同 ID 的样式；避免继承 SDK 的蓝色/斜体。
const EXTENDED_HEADING_STYLES = Object.fromEntries([4, 5, 6].map(level => [`heading${level}`, {
  run: { size: Math.round(HEADING_POINTS[level] * 2), bold: true, color: "363444" },
  paragraph: { outlineLevel: level - 1, keepNext: true, spacing: { line: 372 } }
}]))

/** 输入独立文档快照和含 Blob 的资源 Map；输出标题、DOCX Blob 与去重后的转换说明。 */
export async function createDocumentDocx(document, assets, signal) {
  // 正式门面已固定快照；转换器独立调用时也须在首次异步前复制页面和正文。
  // 否则边距/基准纸张先读取，方向与页眉稍后读取，会把两次编辑拼成同一份文件。
  document = structuredClone(document)
  const navigation = prepareNavigationExportContent(document.content)
  document = { ...document, content: navigation.content }
  const margins = document.page.marginsMm
  const pageSize = PAGE_SIZES[document.page.size]
  const contentSize = getPageContentDimensions(document.page)
  const warnings = new Set(navigation.warnings)
  // 导出使用原生 VML 水印，但现有导入器仍拒绝这类旧式形状；确认下载时明确完整备份出口。
  if (document.page.watermark) warnings.add("文字水印已保留；当前 Word 导入暂不支持这种水印，重新编辑请保留 Mewoc 文件")
  const numbering = []
  // Word 名称限定为以字母开头的 ASCII 字母/数字/下划线且不超过 40 字符。
  // nav-UUIDv4 映射为 nav_UUID，名字稳定；每份文件另分配唯一整数，配对 start/end，避免 SDK 每实例重置编号。
  const wordNavigation = new Map([...navigation.targets.keys()].map((id, index) => [id, { name: id.replace(/-/g, "_"), numericId: index + 1 }]))
  // 可用尺寸按纸张、方向与边距统一计算为 px；子列表和单元格继续收窄宽度，共享资源与总预算。
  const context = {
    assets, signal, warnings, numbering, wordNavigation, imageBytes: new Map(),
    budget: { nodes: 0, code: 0 }, indent: 0, listDepth: 0,
    widthPx: contentSize.widthMm * 96 / 25.4,
    heightPx: contentSize.heightMm * 96 / 25.4
  }
  const children = await createBlocks(document.content.content, context)
  // 编辑器批注在 Word 中以静态附录保留，包括引用与多行说明，不生成原生 Word 批注关系。
  const appendix = getCommentAppendix(document)
  if (appendix.length) {
    warnings.add(COMMENT_WORD_WARNING)
    children.push(new sdk.Paragraph({ text: COMMENT_APPENDIX_HEADING, heading: "Heading2" }), createCommentParagraph(COMMENT_APPENDIX_INTRO))
    appendix.forEach(entry => {
      signal?.throwIfAborted()
      children.push(new sdk.Paragraph({ text: entry.heading, heading: "Heading3" }), ...entry.paragraphs.map(createCommentParagraph))
    })
  }
  signal?.throwIfAborted()
  const watermarkHeader = createDocxWatermarkHeader(document.page)
  // 正文样式、编号定义与页面设置一起封装到一个节；设置 eastAsia 字体以稳定中文默认外观。
  const file = new sdk.Document({
    creator: "Mewoc", title: document.title,
    styles: { default: { ...EXTENDED_HEADING_STYLES, document: {
      run: { font: { ascii: "Arial", hAnsi: "Arial", eastAsia: "PingFang SC" }, size: 24, color: "252837" },
      paragraph: { spacing: { after: 240, line: 420 }, widowControl: true }
    } } },
    numbering: { config: numbering },
    sections: [{
      properties: { page: {
        // SDK 根据 orientation 交换宽高，因此提供选定纸张的竖版基准，不能先交换一次再交 SDK。
        size: { width: mmToTwips(pageSize.widthMm), height: mmToTwips(pageSize.heightMm), orientation: document.page.orientation },
        margin: Object.fromEntries(Object.entries(margins).map(([name, value]) => [name, mmToTwips(value)]))
      } }, ...(watermarkHeader && { headers: { default: watermarkHeader } }), children
    }]
  })
  const blob = await sdk.Packer.toBlob(file)
  // 压缩库不支持中途终止，压缩完成后仍检查取消，旧会话不能弹窗或触发下载。
  signal?.throwIfAborted()
  return { title: document.title, blob, warnings: [...warnings] }
}

// 批注附录保留显式换行，避免把多行说明压成 Word 的一个文本 run。
function createCommentParagraph(text) {
  return new sdk.Paragraph({ children: text.split(/\r\n?|\n/).flatMap((line, index) => [
    ...(index ? [new sdk.TextRun({ break: 1 })] : []),
    new sdk.TextRun({ text: line })
  ]) })
}

/**
 * 将同级块转换成 Word 的段落/表格序列，并递归处理列表、引用和单元格。
 * 分页状态只属于当前序列，共享预算/缓存仍来自 parent，避免子分支互相污染局部排版状态。
 */
async function createBlocks(nodes, parent) {
  const children = []
  let pageBreakBefore = !!parent.pageBreakBefore
  for (const node of nodes) {
    // 每块复制局部环境，但 budget 等引用保持共享，使嵌套结构也计入文档级工作量。
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
      // 序列结束仍挂起的分页用最小空段落承接，保留用户在文末明确插入的分页。
  if (pageBreakBefore) children.push(new sdk.Paragraph({ pageBreakBefore: true, spacing: { after: 0, line: 1, lineRule: "exact" }, run: { size: 2 } }))
      pageBreakBefore = true
      continue
    }
    pageBreakBefore = false
    if (node.type === "paragraph" || node.type === "heading") children.push(await createParagraph(node, context))
    else if (node.type === "tableOfContents") children.push(...await createTableOfContents(node, context))
    else if (node.type === "table") {
      if (context.pageBreakBefore) children.push(new sdk.Paragraph({ pageBreakBefore: true, keepNext: true, spacing: { after: 0, line: 1, lineRule: "exact" }, run: { size: 2 } }))
      children.push(await createDocxTable(node, { ...context, pageBreakBefore: false }, createBlocks))
    }
    else if (["bulletList", "orderedList", "taskList"].includes(node.type)) children.push(...await createList(node, context))
    else if (node.type === "blockquote") children.push(...await createBlocks(node.content, { ...context, indent: context.indent + 300, quote: true }))
    else if (node.type === "textBox") {
      // 正文流内文本框使用单格表格保留富文本和外观；分页先在表格前承接，不能重复作用到格内首段。
      if (context.pageBreakBefore) children.push(new sdk.Paragraph({ pageBreakBefore: true, keepNext: true, spacing: { after: 0, line: 1, lineRule: "exact" }, run: { size: 2 } }))
      children.push(await createTextBox(node, { ...context, pageBreakBefore: false }))
    }
    else if (node.type === "details") {
      context.warnings.add("折叠详情已展开为加粗标题和完整正文，Word 不保留折叠交互")
      children.push(await createParagraph({ type: "paragraph", attrs: { keepWithNext: true }, content: [
        { type: "text", text: node.attrs?.summary ?? DETAILS_DEFAULTS.summary, marks: [{ type: "bold" }] }
      ] }, context))
      children.push(...await createBlocks(node.content, { ...context, pageBreakBefore: false }))
    }
    else if (node.type === "image") children.push(await createImage(node, context))
    else if (node.type === "codeBlock") children.push(await createCode(node, context))
    else if (node.type === "blockMath") children.push(new sdk.Paragraph({
      children: [await createDocxFormula(node.attrs.latex, true, context.warnings)], alignment: "center", indent: { left: context.indent }, pageBreakBefore: context.pageBreakBefore
    }))
    else if (node.type === "horizontalRule") children.push(new sdk.Paragraph({
      border: { bottom: { style: "single", size: 6, color: "EAEAF0" } }, spacing: { before: 180, after: 180 }, indent: { left: context.indent }, pageBreakBefore: context.pageBreakBefore
    }))
    // DOCX 不携带附件二进制；保留元数据说明并提示完整备份应使用能保存资产的文件格式。
    else if (node.type === "attachment") {
      const asset = context.assets.get(node.attrs.assetId)
      context.warnings.add("附件保留文件名和大小，不在 Word 文档中嵌入文件；完整备份请使用 Mewoc 文件")
      children.push(new sdk.Paragraph({ text: `附件：${asset.fileName}（${asset.byteLength} B）`, indent: { left: context.indent }, pageBreakBefore: context.pageBreakBefore }))
    } else throw new Error(`Word 导出暂不支持节点 ${node.type}`)
  }
  if (pageBreakBefore) children.push(new sdk.Paragraph({ pageBreakBefore: true, spacing: { after: 0, line: 1, lineRule: "exact" }, run: { size: 2 } }))
  return children
}

/** 目录使用当前标题快照和原生内部超链接，不写 Word 自动目录域，也不根据连续编辑容器猜页码。 */
async function createTableOfContents(node, context) {
  context.warnings.add("目录导出为当前标题的可点击快照，不生成 Word 自动目录或页码；修改正文后请重新导出")
  const children = [await createParagraph({ type: "paragraph", attrs: { keepWithNext: true }, content: [
    { type: "text", text: node.attrs.title, marks: [{ type: "bold" }] }
  ] }, context)]
  for (const entry of node.attrs.entries) {
    context.signal?.throwIfAborted()
    context.budget.nodes += 1
    if (context.budget.nodes % 64 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0))
      context.signal?.throwIfAborted()
    }
    children.push(await createParagraph({ type: "paragraph", attrs: { leftIndent: entry.level - 1, lineHeight: 1.5 }, content: [
      { type: "text", text: entry.text || "未命名标题", marks: [{ type: "link", attrs: { href: `#${entry.id}` } }] }
    ] }, { ...context, pageBreakBefore: false }))
  }
  return children
}

/** 单格表格沿用已有网格、尺寸与格内递归规则，内嵌表格和资源仍走同一转换链。 */
async function createTextBox(node, context) {
  context.warnings.add("正文文本框已转换为单格表格，保留边框、底色和内边距；不生成浮动文本框")
  const attrs = { ...TEXT_BOX_DEFAULTS, ...node.attrs }
  return createDocxTable({ type: "table", content: [{ type: "tableRow", content: [{
    type: "tableCell", attrs: {
      colspan: 1, rowspan: 1, colwidth: null, backgroundColor: attrs.backgroundColor,
      borderColor: attrs.borderColor, borderWidth: attrs.borderWidth, borderStyle: "solid",
      paddingX: attrs.padding, paddingY: attrs.padding, verticalAlign: "top"
    }, content: node.content
  }] }] }, context, createBlocks)
}

/**
 * 将段落/标题的行内节点与段落属性映射为 SDK Paragraph，可附加列表编号配置。
 * 默认样式取标题/表格/引用上下文，显式属性优先，缩进使用基础字号而非每个文字片段的字号。
 */
async function createParagraph(node, context, numbering, taskPrefix) {
  const attrs = node.attrs || {}
  const level = node.type === "heading" ? attrs.level : 0
  const size = level ? HEADING_POINTS[level] : 12
  const defaults = { size, bold: !!level || context.header, color: context.quote ? "797087" : level >= 4 ? "363444" : "252837" }
  // 任务状态作为普通文字标记写入文件，导入 Word 时仍可读，不伪装成可交互的内容控件。
  const children = taskPrefix ? [new sdk.TextRun({ text: taskPrefix, size: size * 2 })] : []
  // 公式需要异步转换，普通文字同步生成 run；逐项检查取消以覆盖长段落。
  for (const child of node.content || []) {
    context.signal?.throwIfAborted()
    if (child.type === "inlineMath") children.push(await createDocxFormula(child.attrs.latex, false, context.warnings))
    else children.push(createInline(child, defaults, context))
  }
  const bookmark = context.wordNavigation.get(attrs.navigationId)
  if (bookmark) {
    // SDK 公开的配对 XML 节点允许我们维护文档级编号；书签围住整段，含空段、公式及已有超链接。
    children.unshift(new sdk.BookmarkStart(bookmark.name, bookmark.numericId))
    children.push(new sdk.BookmarkEnd(bookmark.numericId))
  }
  const indent = { left: context.indent + (attrs.leftIndent || 0) * size * 20 }
  if (numbering || taskPrefix) indent.hanging = taskPrefix ? 360 : 240
  else indent.firstLine = (attrs.firstLineIndent || 0) * size * 20
  return new sdk.Paragraph({
    children, pageBreakBefore: context.pageBreakBefore, ...(level && { heading: `Heading${level}`, keepNext: true }),
    // 标题默认与下段同页；显式 false 必须覆盖该默认，null 才沿用原规则。
    ...(typeof attrs.keepWithNext === "boolean" && { keepNext: attrs.keepWithNext }),
    ...(typeof attrs.keepTogether === "boolean" && { keepLines: attrs.keepTogether }),
    ...(numbering && { numbering }),
    alignment: attrs.textAlign || "left", indent,
    // 行距 auto 以 240 为单倍；缩进是 em 倍数，先乘基础字号，再以每磅 20 twip 转换。
    spacing: {
      // pt 转为 twip（1 pt = 20 twip）；保留显式零值，未设置时沿用列表/表格等上下文间距。
      after: typeof attrs.spaceAfter === "number" ? attrs.spaceAfter * 20 : context.inTable || context.quote ? 0 : context.listDepth ? 72 : 240,
      ...(typeof attrs.spaceBefore === "number" && { before: attrs.spaceBefore * 20 }),
      line: Math.round((attrs.lineHeight || (level >= 4 ? 1.55 : level ? 1.5 : 1.75)) * 240)
    },
    ...(context.quote && { shading: { fill: "F6F4FB" }, border: { left: { style: "single", size: 18, color: "B6ABD9", space: 8 } } })
  })
}

/** 普通文本与 hardBreak 的 Word 映射；解析文字样式并用超链接包装 run，未知行内类型直接拒绝。 */
function createInline(node, defaults, context) {
  if (node.type === "hardBreak") return new sdk.TextRun({ break: 1 })
  if (node.type !== "text") throw new Error(`Word 导出暂不支持行内节点 ${node.type}`)
  const marks = node.marks || []
  const style = marks.find(mark => mark.type === "textStyle")?.attrs || {}
  const link = marks.find(mark => mark.type === "link")
  // SDK 字号单位为半磅；按最近半磅取整，并在精度损失时只提示一次。
  const points = style.fontSize ? parseFloat(style.fontSize) : defaults.size
  const size = Math.round(points * 2)
  if (size !== points * 2) context.warnings.add("Word 字号以半磅为单位，部分字号已取最近的半磅")
  const types = marks.map(mark => mark.type)
  // Word run 只有常规/加粗，数值字重按阈值折算；明确数值字重优先于默认标题粗体。
  const weight = style.fontWeight ? Number(style.fontWeight) : null
  if (weight && ![400, 700].includes(weight)) context.warnings.add("数值字重已转换为 Word 的常规或加粗")
  const run = new sdk.TextRun({
    text: node.text, size, bold: weight ? weight >= 600 : !!defaults.bold || types.includes("bold"),
    italics: types.includes("italic"), strike: types.includes("strike"),
    superScript: types.includes("superscript"), subScript: types.includes("subscript"),
    ...((types.includes("underline") || link) && { underline: {} }),
    color: style.color ? style.color.slice(1) : link ? "6942A3" : defaults.color,
    ...(style.backgroundColor && { shading: { fill: style.backgroundColor.slice(1) } }),
    ...(style.fontFamily && { font: style.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "") }),
    ...(types.includes("code") && { font: "Menlo", shading: { fill: "F6F6F8" } })
  })
  if (!link) return run
  if (isInternalNavigationHref(link.attrs.href)) {
    const target = context.wordNavigation.get(link.attrs.href.slice(1))
    if (!target) { context.warnings.add(MISSING_NAVIGATION_WARNING); return run }
    return new sdk.InternalHyperlink({ children: [run], anchor: target.name })
  }
  return new sdk.ExternalHyperlink({ children: [run], link: link.attrs.href })
}

/**
 * 每个列表创建独立编号 reference，保留起点与编号类型；首段编号，其余块作为同项后续内容。
 * Word 编号最多九级，更深嵌套继续保留缩进并降到末级编号，同时记录兼容说明。
 */
async function createList(node, context) {
  const task = node.type === "taskList"
  if (task) context.warnings.add("待办清单以 [x] / [ ] 文字标记保留勾选状态，不生成 Word 交互式复选框")
  const level = Math.min(context.listDepth, 8)
  if (!task && context.listDepth > 8) context.warnings.add("超过九层的列表保留缩进，Word 编号层级按第九层输出")
  const reference = `mewoc-list-${context.numbering.length + 1}`
  const ordered = node.type === "orderedList"
  const indent = context.indent + 480
  // reference 在整个文档中唯一，避免不同列表意外续编；项目符号随真实嵌套深度轮换。
  if (!task) context.numbering.push({ reference, levels: [{
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
    children.push(await createParagraph(item.content[0], itemContext, task ? null : { reference, level }, task ? item.attrs?.checked ? "[x] " : "[ ] " : null))
    // 继承的分页仅作用于列表第一项首段，后续同项块和下一项不能重复制造分页。
    itemContext.pageBreakBefore = false
    children.push(...await createBlocks(item.content.slice(1), itemContext))
  }
  return children
}

/** 校验并缓存资源字节，按当前正文/单元格可用尺寸等比缩小显示；原节点尺寸和 Blob 不被修改。 */
async function createImage(node, context) {
  const asset = context.assets.get(node.attrs.assetId)
  // 同一资源在文档中出现多次时只读取/转换一次；WebP 转 PNG 后的字节也缓存复用。
  if (!context.imageBytes.has(asset.id)) {
    await validateImageBlob(asset.blob)
    const blob = asset.mimeType === "image/webp" ? await convertWebp(asset.blob, context) : asset.blob
    context.imageBytes.set(asset.id, { type: blob.type === "image/png" ? "png" : "jpg", data: new Uint8Array(await blob.arrayBuffer()) })
  }
  context.signal?.throwIfAborted()
  // 1 px = 15 twip，减去当前缩进后再按宽与单页高约束，避免图片越界或失去比例。
  const available = context.widthPx - context.indent / 15
  if (available < 1) throw new Error("图片可用宽度过小，请减少缩进后导出")
  const ratio = Math.min(1, available / node.attrs.width, Math.max(1, context.heightPx - 32) / node.attrs.height)
  if (ratio < 1) context.warnings.add("超出正文、单元格宽度或单页高度的图片已等比缩小")
  return new sdk.Paragraph({
    alignment: node.attrs.align || "left",
    indent: { left: context.indent }, pageBreakBefore: context.pageBreakBefore, children: [new sdk.ImageRun({
      ...context.imageBytes.get(asset.id), transformation: { width: node.attrs.width * ratio, height: node.attrs.height * ratio },
      altText: { name: asset.fileName, title: node.attrs.title || asset.fileName, description: node.attrs.alt || "" }
    })]
  })
}

/** 浏览器解码 WebP 并生成 Word 可用的 PNG，限制临时像素规模，finally 释放 bitmap 与 canvas。 */
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

/**
 * 代码按 token 映射固定字体和色值；着色不可用/超预算时仍完整保留源码及换行。
 * 预算按文档累计，避免很多小代码块绕过单块限制拖慢导出。
 */
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
  // 每个 token 内的换行显式生成 Word break，着色分片不会改变源码行边界。
  for (const token of tokens) {
    const color = CODE_COLORS.find(([classes]) => classes.some(name => token.classes.includes(name)))?.[1] || "252837"
    token.text.split("\n").forEach((text, index) => children.push(new sdk.TextRun({ text, break: index ? 1 : 0, font: "Menlo", size: 22, color })))
  }
  return new sdk.Paragraph({
    children, indent: { left: context.indent }, pageBreakBefore: context.pageBreakBefore, spacing: { line: 300, after: 240 },
    shading: { fill: "F6F6F8" }, wordWrap: true, widowControl: false
  })
}

/** 页面长度从毫米转为 twip（每英寸 1440 twip），取整满足 OOXML 整数尺寸要求。 */
function mmToTwips(value) {
  return Math.round(value * 1440 / 25.4)
}
