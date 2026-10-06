/**
 * 把 Word 兼容表示、旧式 VML 文本框/图片和可读图表转换为普通正文块。
 * 按锚点顺序保留语义内容，舍弃浮动外观时提示 warning；无法说明的形状/文字直接拒绝。
 */
import { getXmlChildren, WORD_XML } from "./docx-import-xml.js"

const VML_XML = "urn:schemas-microsoft-com:vml"
const MC_XML = "http://schemas.openxmlformats.org/markup-compatibility/2006"
const REL_XML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const SHAPES = new Set(["shape", "rect", "roundrect", "oval"])
// 这些部件只描述外观；文字路径、图表等有独立语义的内容不能随外观一起丢弃。
const APPEARANCE = new Set(["shapetype", "stroke", "fill", "shadow", "path", "formulas", "handles"])
const OFFICE_XML = "urn:schemas-microsoft-com:office:office"

// 必须早于段落编号及公式读取执行：Choice/Fallback 是同一对象的两份表示，不能重复计数。
export function normalizeDocxLegacyContent(xml, warnings, readChart) {
  // AlternateContent 的 Choice 与 Fallback 是替代表示，只保留唯一且非空的兼容分支。
  const collapse = node => {
    for (const child of getXmlChildren(node)) {
      if (child.namespaceURI === MC_XML && child.localName === "AlternateContent") {
        const fallback = getXmlChildren(child).filter(item => item.namespaceURI === MC_XML && item.localName === "Fallback")
        if (fallback.length !== 1 || !getXmlChildren(fallback[0]).length) throw new Error("文档包含没有兼容表示的图形内容，请在 Word 中将其转换为图片后重试，并保留原 DOCX")
        collapse(fallback[0])
        for (const item of Array.from(fallback[0].childNodes)) node.insertBefore(item, child)
        node.removeChild(child)
      } else collapse(child)
    }
  }
  collapse(xml.documentElement)
  // 从内向外处理，先把嵌套文本框展开到所属文本框，再移动到正文或表格单元格。
  // 同一段落中的多个锚点也按反序插入 nextSibling，最终仍保持源 XML 顺序。
  const objects = Array.from(xml.getElementsByTagNameNS(WORD_XML, "*")).filter(node => node.localName === "pict" || (node.localName === "drawing" && node.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/chart", "chart").length))
  for (const picture of objects.reverse()) {
    // 图形必须能归属到正文、单元格或外层文本框中的段落，才有可靠的位置可展开。
    let anchor = picture.parentNode
    while (anchor && !(anchor.namespaceURI === WORD_XML && anchor.localName === "p")) anchor = anchor.parentNode
    const parent = anchor?.parentNode
    if (parent?.namespaceURI !== WORD_XML || !["body", "tc", "txbxContent"].includes(parent.localName)) throw new Error("旧式图形的位置无法可靠转换，请保留原 DOCX")
    const isChart = picture.localName === "drawing"
    if (isChart && !readChart) throw new Error("原生图表暂不能转换，请保留原 DOCX")
    // 图表交给缓存数据读取器；旧图形递归提取文字/图片，两者都输出可进入编号/公式流程的块。
    const blocks = isChart ? readChart(picture) : readLegacyBlocks(picture, xml)
    if (!blocks.length) throw new Error("暂不支持纯矢量图形，请在 Word 中将图形转换为图片后重试，并保留原 DOCX")
    // 以原段落之后为插入点，锚点段落中的普通文字保留，图形本身仅删除一次。
    const next = anchor.nextSibling
    blocks.forEach(block => parent.insertBefore(block, next))
    picture.parentNode.removeChild(picture)
    if (!isChart) warnings.add("旧式文本框和图片已按锚点顺序放在所属段落之后；浮动位置、环绕、边框、背景及图形外观不保留")
  }
  // DrawingML 文本框或不在已识别 VML 容器中的文本不能直接交给 Mammoth，否则可能静默丢失。
  if (xml.getElementsByTagNameNS(WORD_XML, "txbxContent").length) throw new Error("此文本框结构暂不能可靠转换，请在 Word 中将文字移到正文后重试，并保留原 DOCX")
}

/**
 * 深度遍历 VML 容器：只提取支持的文本框块与内嵌图片引用，并检查外观子树。
 * 返回的节点属于原 XML，可直接移动到正文；没有语义块的纯矢量形状不能静默略过。
 */
function readLegacyBlocks(node, xml) {
  const blocks = []
  for (const child of getXmlChildren(node)) {
    // 分组和形状可以嵌套，但每个容器都必须最终含可保留正文或图片。
    if (child.namespaceURI === VML_XML && (SHAPES.has(child.localName) || child.localName === "group")) {
      const content = readLegacyBlocks(child, xml)
      if (!content.length) throw new Error("暂不支持纯矢量图形，请在 Word 中将图形转换为图片后重试，并保留原 DOCX")
      blocks.push(...content)
    // 文本框仅接受单个 txbxContent，且其内容须由 Word 段落/表格构成，避免混合未知结构。
    } else if (child.namespaceURI === VML_XML && child.localName === "textbox") {
      const contents = getXmlChildren(child)
      if (contents.length !== 1 || contents[0].namespaceURI !== WORD_XML || contents[0].localName !== "txbxContent") throw new Error("旧式文本框内容无法可靠读取，请保留原 DOCX")
      const paragraphs = getXmlChildren(contents[0])
      if (!paragraphs.length || paragraphs.some(item => item.namespaceURI !== WORD_XML || !["p", "tbl"].includes(item.localName))) throw new Error("旧式文本框包含暂不支持的内容，请保留原 DOCX")
      blocks.push(...paragraphs)
    } else if (child.namespaceURI === VML_XML && child.localName === "imagedata") {
      if (!child.getAttributeNS(REL_XML, "id") || getXmlChildren(child).length) throw new Error("旧式图片缺少有效的内嵌资源引用，请在 Word 中重新插入图片后重试")
      // 只保留可审计的内嵌图片引用；不复制 VML 的几何路径或 o:gfxdata 等冗余表示。
      const paragraph = xml.createElementNS(WORD_XML, "w:p")
      const run = xml.createElementNS(WORD_XML, "w:r")
      const picture = xml.createElementNS(WORD_XML, "w:pict")
      const shape = xml.createElementNS(VML_XML, "v:shape")
      const image = xml.createElementNS(VML_XML, "v:imagedata")
      image.setAttributeNS(REL_XML, "r:id", child.getAttributeNS(REL_XML, "id"))
      if (child.hasAttributeNS(OFFICE_XML, "title")) image.setAttributeNS(OFFICE_XML, "o:title", child.getAttributeNS(OFFICE_XML, "title"))
      shape.appendChild(image)
      picture.appendChild(shape)
      run.appendChild(picture)
      paragraph.appendChild(run)
      blocks.push(paragraph)
    } else if (child.namespaceURI === VML_XML && APPEARANCE.has(child.localName)) {
      // 限定外观子树也只能包含 VML 外观属性，避免借外观容器跳过正文或艺术字。
      const descendants = [child, ...Array.from(child.getElementsByTagNameNS("*", "*"))]
      if (descendants.some(item => item.namespaceURI !== VML_XML || ![...APPEARANCE, "f", "h"].includes(item.localName))) throw new Error("旧式图形包含暂不支持的外观内容，请保留原 DOCX")
    } else if (child.namespaceURI === OFFICE_XML && child.localName === "lock" && !getXmlChildren(child).length) {
      // 对象锁定属于源文档的编辑设置，展开为普通正文后不再适用。
    } else if (child.namespaceURI === "urn:schemas-microsoft-com:office:word" && ["wrap", "anchorlock"].includes(child.localName) && !getXmlChildren(child).length) {
      // Word 旧式环绕和锚点锁定只影响浮动排版；已通过转换说明告知其不保留。
    } else throw new Error("旧式图形包含暂不支持的内容（如艺术字），请在 Word 中转换为图片后重试，并保留原 DOCX")
  }
  return blocks
}
