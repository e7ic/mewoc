/** 原生 Word 页眉水印：VML 文字路径位于正文之后，不把水印伪装为正文段落或图片。 */
import * as sdk from "docx"
import { createId } from "./create-id.js"
import { getWatermarkGeometry } from "./page-watermark.js"

// SDK BuilderElement 使用自己的 XML 序列化器转义属性；文案不拼接进原始 XML。
const element = (name, attributes = {}, children = []) => new sdk.BuilderElement({
  name, attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, { key, value }])), children
})

export function createDocxWatermarkHeader(page) {
  const paragraph = createDocxWatermarkParagraph(page)
  return paragraph ? new sdk.Header({ children: [paragraph] }) : null
}

// 页眉文字和水印必须共享同一关系部件；返回段落供页面装饰导出器组合，原单水印入口不变。
export function createDocxWatermarkParagraph(page) {
  if (!page.watermark) return null
  const { text, color, opacity, angle } = page.watermark
  const geometry = getWatermarkGeometry(page)
  const points = millimeters => millimeters * 72 / 25.4
  // 与将来的正文形状、其他节页眉区分；SDK 为 Header 分配文档级唯一关系 ID，无需手写 r:id。
  const suffix = createId().replace(/-/g, "")
  const typeId = `MewocWatermarkType_${suffix}`
  const shapeId = `MewocWatermarkShape_${suffix}`
  // TextPath、Fill opacity 与 Shape style 是 OOXML 的原生 VML 契约，Office 2007 起可表示：
  // https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.vml.textpath
  // https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.vml.fill.opacity
  // 直线文字路径不需要导入外部 Word 模板中的公式表；page-relative center 避免受页眉边距影响。
  const shapeType = element("v:shapetype", { id: typeId, coordsize: "21600,21600", "o:spt": "136", path: "m0,10800l21600,10800e" }, [
    element("v:path", { textpathok: "t" }), element("v:textpath", { on: "t" })
  ])
  const style = ["position:absolute", "margin-left:0", "margin-top:0", `width:${points(geometry.textWidthMm)}pt`,
    `height:${points(geometry.textHeightMm)}pt`, `rotation:${angle}`, "z-index:-251654144", "mso-wrap-edited:f",
    "mso-position-horizontal:center", "mso-position-horizontal-relative:page", "mso-position-vertical:center",
    "mso-position-vertical-relative:page", "mso-wrap-style:none"].join(";")
  const shape = element("v:shape", { id: shapeId, type: `#${typeId}`, style, fillcolor: color, stroked: "f", "o:allowincell": "f", "o:allowoverlap": "t" }, [
    element("v:fill", { opacity }),
    // 不使用 fitshape 拉伸字形；字号与 SVG 同源，中文字体由宿主 Office 的字体回退解析。
    element("v:textpath", { on: "t", fitshape: "f", xscale: "f", style: `font-family:Arial;font-size:${geometry.fontSizePt}pt;v-text-align:center`, string: text.trim() }),
    element("w10:wrap", { type: "none", anchorx: "page", anchory: "page" })
  ])
  const run = new sdk.Run({})
  run.addChildElement(element("w:pict", {}, [shapeType, shape]))
  // 页眉中只放无占位文字的浮动路径；极小空段不挤占正文，也不产生可搜索的水印正文 run。
  return new sdk.Paragraph({ children: [run], spacing: { before: 0, after: 0, line: 1, lineRule: "exact" } })
}
