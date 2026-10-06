/**
 * 统一处理编辑器外部输入：文件入口、应用快捷键和 HTML 剪贴板清理。
 * 文件读取交给资源 hook，普通文字与清理后的文档结构仍由 Tiptap 接管。
 */
import { IconInfoCircle } from "@tabler/icons-react"
import { createElement, useEffect } from "react"
import { message } from "antd"
import { isSafeLink } from "../tools/document-schema.js"
import { FONT_FAMILIES, FONT_SIZES, FONT_WEIGHTS, LINE_HEIGHTS, FIRST_LINE_INDENTS, LEFT_INDENTS } from "../constants/editor-constants.js"
import { parseParagraphIndent } from "../extensions/paragraph-indent.js"
import { getFormulaSourceError } from "../tools/formula.js"
import { getPastedCodeLanguage } from "../tools/code-highlight.js"
import { getTableBorderStyle, normalizeTableCellAppearance, normalizeTableRowAppearance } from "../extensions/table-appearance.js"
import { parseParagraphLayout } from "../extensions/paragraph-layout.js"
import { cleanPastedBlockContainers } from "../tools/pasted-block-containers.js"
import { cleanPastedNavigation } from "../tools/pasted-navigation.js"

// 在当前编辑器 DOM 上接管文件粘贴/拖入与保存、查找快捷键，解绑也限定同一实例。
export function useEditorInput(editor, store, insertImages, saveDocument) {
  useEffect(() => {
    if (!editor) return
    // 代码块优先保留源码粘贴语义；其他位置只拦截含图片文件的剪贴板事件。
    const handlePaste = event => {
      if (!editor.isEditable || editor.isActive("codeBlock")) return
      const files = [...event.clipboardData.files].filter(file => file.type.startsWith("image/"))
      if (!files.length) return
      event.preventDefault()
      event.stopImmediatePropagation()
      insertImages(files)
    }
    // 把屏幕坐标转换为正文位置，让资源异步读取完成后仍能在原拖入目标插入。
    const handleDrop = event => {
      if (!editor.isEditable || !event.dataTransfer.files.length) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
      insertImages([...event.dataTransfer.files], position)
    }
    // 支持 macOS 和其他平台的修饰键；组合输入期间不抢占候选词确认相关事件。
    const handleKeyDown = event => {
      if (!(event.metaKey || event.ctrlKey) || event.isComposing) return
      if (event.key.toLowerCase() === "s") {
        event.preventDefault()
        saveDocument()
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault()
        store.getState().updateView({ searchOpen: true, commentsOpen: false })
      }
    }
    const dom = editor.view.dom
    // 捕获阶段先拦截图片文件，避免编辑器默认粘贴流程再插入一次；普通文字继续交给 Tiptap。
    dom.addEventListener("paste", handlePaste, true)
    dom.addEventListener("drop", handleDrop, true)
    dom.addEventListener("keydown", handleKeyDown)
    return () => {
      dom.removeEventListener("paste", handlePaste, true)
      dom.removeEventListener("drop", handleDrop, true)
      dom.removeEventListener("keydown", handleKeyDown)
    }
  }, [editor, store, insertImages, saveDocument])
}

/**
 * 外部 HTML 先做属性白名单清理，再交给 Tiptap 解析文档结构。
 * 自定义节点只恢复本会话可解析的资源 ID 或经过校验的源码，不信任剪贴板 URL。
 * 样式重新从允许值生成，不能把任意 style、事件属性带入编辑内容。
 */
export function cleanPastedHtml(html, hasAsset = () => false, currentContent) {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  // 先删除主动内容与外部嵌入，再恢复经过本项目验证的代码、附件及公式节点。
  parsed.querySelectorAll("script, style, iframe, object, embed, svg, math, link, meta").forEach(node => node.remove())
  const codes = cleanPastedCode(parsed)
  const attachments = cleanPastedAttachments(parsed, hasAsset)
  const media = cleanPastedMedia(parsed, hasAsset)
  const blockContainers = cleanPastedBlockContainers(parsed)
  const navigation = cleanPastedNavigation(parsed, currentContent)
  const taskLists = new Set(parsed.querySelectorAll('ul[data-type="taskList"]'))
  const taskItems = new Set(parsed.querySelectorAll('li[data-type="taskItem"]'))
  taskItems.forEach(item => {
    // 只恢复布尔完成状态，不复制剪贴板里的可交互表单或辅助标签；编辑器会重建自己的复选框。
    item.setAttribute("data-checked", String(item.getAttribute("data-checked") === "true"))
    item.querySelectorAll(":scope > label").forEach(label => label.remove())
  })
  // 集合只记录通过源码校验的元素，后续属性过滤据此决定能否保留自定义节点标记。
  const formulas = new Set()
  parsed.querySelectorAll('span[data-type="inline-math"], div[data-type="block-math"]').forEach(element => {
    const latex = element.getAttribute("data-latex")
    if (getFormulaSourceError(latex)) return
    element.textContent = latex
    formulas.add(element)
  })
  // 图片引用必须能在当前资源表找到，外部 src 不参与恢复，也不触发自动下载。
  let hasExternalImages = false
  parsed.querySelectorAll("img").forEach(image => {
    if (!hasAsset(image.getAttribute("data-mewoc-asset-id"), "image")) {
      hasExternalImages = true
      image.remove()
    }
  })
  // 清理前读取允许的外观，清理后重新写回；事件属性、任意 CSS 与未知 data 属性全部移除。
  parsed.body.querySelectorAll("*").forEach(element => {
    const container = blockContainers.get(element)
    const textStyle = container ? "" : getPastedTextStyle(element)
    const tableStyle = getPastedTableStyle(element)
    for (const attr of [...element.attributes]) {
      const isLink = element.tagName === "A" && attr.name === "href" && isSafeLink(attr.value)
      // 编号是列表结构属性；限制起始号与原生编号枚举，内部粘贴无需退回默认十进制。
      const isListNumbering = element.tagName === "OL" && ((attr.name === "start" && /^[1-9]\d{0,8}$/.test(attr.value))
        || (attr.name === "type" && ["1", "a", "A", "i", "I"].includes(attr.value)))
      // 合并跨度与列宽是表格结构信息，列宽项数必须与 colspan 对齐，避免形成无效布局。
      const isTableSpan = ["TD", "TH"].includes(element.tagName) && ["colspan", "rowspan"].includes(attr.name) && /^[1-9]\d{0,2}$/.test(attr.value)
      const isColumnWidth = ["TD", "TH"].includes(element.tagName) && attr.name === "colwidth"
        && attr.value.split(",").length === Number(element.getAttribute("colspan") || 1)
        && attr.value.split(",").every(value => /^\d+$/.test(value) && Number(value) <= 4000)
      const isImageId = element.tagName === "IMG" && attr.name === "data-mewoc-asset-id"
      const isImageText = element.tagName === "IMG" && ["alt", "title"].includes(attr.name) && attr.value.length <= 1000
      const isImageSize = element.tagName === "IMG" && ["width", "height"].includes(attr.name) && Number(attr.value) > 0 && Number(attr.value) <= 20000
      const isImageAlignment = element.tagName === "IMG" && attr.name === "data-mewoc-image-align" && ["left", "center", "right"].includes(attr.value)
      const isImageLock = element.tagName === "IMG" && attr.name === "data-mewoc-lock-aspect-ratio" && ["true", "false"].includes(attr.value)
      const isFormula = formulas.has(element) && ["data-type", "data-latex"].includes(attr.name)
      const isCode = codes.has(element) && attr.name === "data-code-language"
      const isAttachment = attachments.has(element) && ["data-type", "data-mewoc-asset-id"].includes(attr.name)
      const isMedia = media.has(element) && ["data-type", "data-mewoc-asset-id", "data-media-kind"].includes(attr.name)
      const isTask = (taskLists.has(element) && attr.name === "data-type")
        || (taskItems.has(element) && ["data-type", "data-checked"].includes(attr.name))
      const isBlockContainer = container?.attributes.has(attr.name)
      const isNavigation = navigation.get(element)?.has(attr.name)
      if (!isLink && !isListNumbering && !isTableSpan && !isColumnWidth && !isImageId && !isImageText && !isImageSize && !isImageAlignment && !isImageLock && !isFormula && !isCode && !isAttachment && !isMedia && !isTask && !isBlockContainer && !isNavigation) element.removeAttribute(attr.name)
    }
    const style = [textStyle, tableStyle, container?.style].filter(Boolean).join("; ")
    if (style) element.setAttribute("style", style)
  })
  if (hasExternalImages) message.info({ content: "已粘贴文字。网页图片请保存后通过「图片」插入", icon: createElement(IconInfoCircle, { "aria-hidden": true }) })
  return parsed.body.innerHTML
}

// 精细设置经过数值、颜色和枚举校验后重建，复制内部表格不会丢样式，也不接受任意 CSS。
function getPastedTableStyle(element) {
  const css = element.style
  const pixels = value => /^\d+px$/.test(value) ? Number.parseInt(value, 10) : null
  if (element.tagName === "TR") {
    const { minHeight } = normalizeTableRowAppearance({ minHeight: pixels(css.height || css.minHeight) })
    return minHeight === null ? "" : `height: ${minHeight}px`
  }
  if (!["TD", "TH"].includes(element.tagName)) return ""
  const attrs = normalizeTableCellAppearance({
    backgroundColor: css.backgroundColor, verticalAlign: css.verticalAlign,
    paddingX: pixels(css.paddingLeft), paddingY: pixels(css.paddingTop),
    borderColor: css.borderTopColor, borderWidth: pixels(css.borderTopWidth), borderStyle: getTableBorderStyle(element)
  })
  return [
    attrs.backgroundColor && `background-color: ${attrs.backgroundColor}`,
    `vertical-align: ${attrs.verticalAlign}`,
    `padding: ${attrs.paddingY}px ${attrs.paddingX}px`,
    `border-width: ${attrs.borderWidth}px; border-style: ${attrs.borderStyle}; border-color: ${attrs.borderColor}`
  ].filter(Boolean).join("; ")
}

// 附件字节不会随 HTML 剪贴板跨会话传递；缺失引用退化为说明文字，保留可理解的文件名。
// 媒体粘贴只承接本会话已有资源，播放器地址与浏览器控件始终由节点视图重建。
// 外部 HTML/其他文档的资源引用转为说明，不访问 URL，也不让未知媒体冒充已有附件或图片。
function cleanPastedMedia(parsed, hasAsset) {
  const media = new Set()
  parsed.querySelectorAll('div[data-type="media"]').forEach(element => {
    const assetId = element.getAttribute("data-mewoc-asset-id")
    const kind = element.getAttribute("data-media-kind")
    const name = element.querySelector("[data-media-name]")?.textContent || "媒体文件"
    const available = ["audio", "video"].includes(kind) && hasAsset(assetId, kind)
    element.textContent = `${kind === "audio" ? "音频" : "视频"}：${name}${available ? "" : "（请通过本地文件重新插入）"}`
    if (available) media.add(element)
    else element.removeAttribute("data-type")
  })
  parsed.querySelectorAll("audio, video").forEach(element => {
    element.replaceWith(parsed.createTextNode(`[外部${element.tagName === "AUDIO" ? "音频" : "视频"}：请通过本地文件插入]`))
  })
  parsed.querySelectorAll("source, track").forEach(element => element.remove())
  return media
}

function cleanPastedAttachments(parsed, hasAsset) {
  const attachments = new Set()
  parsed.querySelectorAll('div[data-type="attachment"]').forEach(element => {
    const assetId = element.getAttribute("data-mewoc-asset-id")
    const name = element.querySelector("[data-attachment-name]")?.textContent || "附件"
    const available = hasAsset(assetId, "attachment")
    // 复制只携带本会话资源 ID，不接受剪贴板里的下载 URL 或重复元数据。
    element.textContent = available ? name : `[附件：${name}；请通过 Mewoc 文件传递附件]`
    if (available) attachments.add(element)
  })
  return attachments
}

// 去掉外部高亮标签但保留文本和显式换行，着色由本项目高亮插件重新生成。
function cleanPastedCode(parsed) {
  const codes = new Set(parsed.querySelectorAll("pre"))
  codes.forEach(pre => {
    const language = getPastedCodeLanguage(pre)
    pre.querySelectorAll("br").forEach(lineBreak => lineBreak.replaceWith(parsed.createTextNode("\n")))
    const code = parsed.createElement("code")
    code.textContent = pre.textContent
    pre.replaceChildren(code)
    pre.removeAttribute("data-code-language")
    if (language !== null) pre.setAttribute("data-code-language", language)
  })
  return codes
}

/**
 * 从 CSSOM 读取可表达的文字外观，转换为本项目白名单样式。
 * 字体、字号、字重采用菜单允许值；段落属性只处理正文与六级标题元素。
 */
function getPastedTextStyle(element) {
  const styles = []
  const css = element.style
  for (const property of ["color", "background-color"]) {
    const value = css.getPropertyValue(property)
    const match = value.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/)
    if (match) {
      const color = match.slice(1).map(channel => Number(channel).toString(16).padStart(2, "0")).join("")
      styles.push(`${property}: #${color}`)
    }
  }
  // CSSOM 可能给字体族增加引号，先移除后与预设值精确比较，未知字体不带入正文。
  const family = css.fontFamily.replace(/["']/g, "")
  const font = FONT_FAMILIES.find(item => item.value && item.value === family)
  if (font) styles.push(`font-family: ${font.value}`)
  if (FONT_SIZES.includes(css.fontSize)) styles.push(`font-size: ${css.fontSize}`)
  if (FONT_WEIGHTS.includes(css.fontWeight)) styles.push(`font-weight: ${css.fontWeight}`)
  if (["SPAN", "SUP", "SUB"].includes(element.tagName) && ["super", "sub"].includes(css.verticalAlign)) styles.push(`vertical-align: ${css.verticalAlign}`)
  // 文字级样式可普遍恢复，缩进、行距和分页约束只属于段落，不写入任意内联元素。
  if (["P", "H1", "H2", "H3", "H4", "H5", "H6"].includes(element.tagName)) {
    if (["left", "center", "right", "justify"].includes(css.textAlign)) styles.push(`text-align: ${css.textAlign}`)
    if (LINE_HEIGHTS.includes(Number(css.lineHeight))) styles.push(`line-height: ${css.lineHeight}`)
    const firstLine = parseParagraphIndent(css.textIndent, FIRST_LINE_INDENTS)
    const left = parseParagraphIndent(css.marginLeft, LEFT_INDENTS)
    if (firstLine) styles.push(`text-indent: ${firstLine}em`)
    if (left) styles.push(`margin-left: ${left}em`)
    const layout = parseParagraphLayout(element)
    if (layout.spaceBefore !== null) styles.push(`margin-top: ${layout.spaceBefore}pt`)
    if (layout.spaceAfter !== null) styles.push(`margin-bottom: ${layout.spaceAfter}pt`)
    if (layout.keepWithNext !== null) styles.push(`break-after: ${layout.keepWithNext ? "avoid" : "auto"}`)
    if (layout.keepTogether !== null) styles.push(`break-inside: ${layout.keepTogether ? "avoid" : "auto"}`)
  }
  return styles.join("; ")
}
