/** 页面导出核验真实 OOXML/HTML 与打印生命周期；结构测试不宣称各桌面 Office 排版完全一致。 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { JSDOM } from "jsdom"
import JSZip from "jszip"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { PAGE_SIZES, getPageDimensions, getPageContentDimensions } from "../src/pages/editor/tools/page-settings.js"
import { getWatermarkGeometry, createWatermarkSvg } from "../src/pages/editor/tools/page-watermark.js"
import { createPageExportLayout } from "../src/pages/editor/tools/page-export-layout.js"
import { createDocumentHtml } from "../src/pages/editor/tools/html-export.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { createDocumentDocx as createSnapshotDocx } from "../src/pages/editor/tools/docx-export.js"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentText, getDocumentTextWarnings } from "../src/pages/editor/tools/document-text.js"
import { printDocument } from "../src/pages/editor/tools/print-document.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "Element", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
const ID1 = "nav-11111111-1111-4111-8111-111111111111"
const ID2 = "nav-22222222-2222-4222-8222-222222222222"
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const makeDocument = (size = "A4", orientation = "portrait") => ({ ...createDocument(), title: "纸张 <&> 导出",
  page: { size, orientation, marginsMm: { top: 12, right: 17, bottom: 19, left: 23 } },
  content: { type: "doc", content: [paragraph("正文保留，页面装饰不成为正文。")] } })
const watermark = { text: "  草稿 <script>&\"'  ", color: "#AB12EF", opacity: 0.27, angle: -35 }
const parseXml = source => {
  const parsed = new DOMParser().parseFromString(source, "application/xml")
  assert.equal(parsed.querySelector("parsererror"), null)
  return parsed
}
const unpack = async (source, assets = new Map()) => {
  const result = await createDocumentDocx(source, assets)
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml").async("string")
  return { ...result, zip, xml, parsed: parseXml(xml) }
}
const twips = millimeters => Math.round(millimeters * 1440 / 25.4)
const styleMap = text => Object.fromEntries(text.split(";").filter(Boolean).map(item => {
  const index = item.indexOf(":")
  return [item.slice(0, index), item.slice(index + 1)]
}))

test("A3/A4/A5/Letter 横竖纸张在真实 Word XML 与静态 HTML 使用相同毫米尺寸和四边边距", async () => {
  for (const size of Object.keys(PAGE_SIZES)) for (const orientation of ["portrait", "landscape"]) {
    const source = makeDocument(size, orientation)
    const before = structuredClone(source)
    const { parsed, zip } = await unpack(source)
    const dimensions = getPageDimensions(source.page)
    const page = parsed.getElementsByTagName("w:pgSz")[0]
    assert.equal(Number(page.getAttribute("w:w")), twips(dimensions.widthMm), `${size}/${orientation}/width`)
    assert.equal(Number(page.getAttribute("w:h")), twips(dimensions.heightMm), `${size}/${orientation}/height`)
    assert.equal(page.getAttribute("w:orient"), orientation)
    const margins = parsed.getElementsByTagName("w:pgMar")[0]
    for (const [side, value] of Object.entries(source.page.marginsMm)) assert.equal(Number(margins.getAttribute(`w:${side}`)), twips(value))
    assert.equal(zip.file(/^word\/header\d+\.xml$/).length, 0)
    const html = await createDocumentHtml(source, new Map(), ".mewoc-content { font-size: 12pt; }")
    const rendered = new DOMParser().parseFromString(html, "text/html")
    assert.ok(rendered.querySelector("style").textContent.includes(`@page { size: ${dimensions.widthMm}mm ${dimensions.heightMm}mm; margin: 12mm 17mm 19mm 23mm; }`))
    assert.equal(rendered.querySelector("article").textContent, source.content.content[0].content[0].text)
    assert.equal(rendered.querySelector("title").textContent, source.title)
    assert.equal(rendered.querySelector(".mewoc-export-watermark"), null)
    assert.deepEqual(source, before)
  }
})

test("每种纸张的超宽图片、表格与正文文本框按真实正文区域收窄，水印不改资源内容", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/m5-current-document.mewoc.json", import.meta.url), "utf8"))
  const image = fixture.document.assets.find(asset => asset.kind !== "attachment")
  const bytes = Buffer.from(fixture.assetData[image.id].split(",")[1], "base64")
  const assets = new Map([[image.id, { ...image, blob: new Blob([bytes], { type: image.mimeType }) }]])
  for (const size of Object.keys(PAGE_SIZES)) for (const orientation of ["portrait", "landscape"]) {
    const source = makeDocument(size, orientation)
    source.assets = [image]
    source.page.watermark = { ...watermark }
    source.content.content.push({ type: "image", attrs: { assetId: image.id, width: 4000, height: 2000, alt: "宽图片" } },
      { type: "table", content: [{ type: "tableRow", content: [0, 1].map(index => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [1000] }, content: [paragraph(`宽列 ${index}`)] })) }] },
      { type: "textBox", content: [paragraph("文本框仍有全部内容")] })
    const before = structuredClone(source)
    const result = await unpack(source, assets)
    const available = getPageContentDimensions(source.page)
    const extent = result.parsed.getElementsByTagName("wp:extent")[0]
    assert.ok(Number(extent.getAttribute("cx")) <= available.widthMm * 36000 + 1)
    assert.ok(Number(extent.getAttribute("cy")) <= available.heightMm * 36000 + 1)
    for (const table of result.parsed.getElementsByTagName("w:tblW")) assert.ok(Number(table.getAttribute("w:w")) <= twips(available.widthMm))
    assert.ok(result.parsed.documentElement.textContent.includes("文本框仍有全部内容"))
    const media = result.zip.file(/^word\/media\/.+\.png$/)
    assert.equal(media.length, 1)
    assert.deepEqual(Buffer.from(await media[0].async("uint8array")), bytes)
    assert.deepEqual(source, before)
  }
})

test("Word 水印是唯一关联的原生页眉 VML：居中、旋转、颜色、透明度可读，书签与正文未污染", async () => {
  const source = makeDocument("A5", "landscape")
  source.page.watermark = { ...watermark }
  source.content.content = [{ type: "heading", attrs: { level: 1, navigationId: ID1, bookmarkName: "章节" }, content: [{ type: "text", text: "有导航的正文" }] },
    { type: "paragraph", attrs: { navigationId: ID2, bookmarkName: "原段" }, content: [{ type: "text", text: "原段正文", marks: [{ type: "commentAnchor", attrs: { id: "comment-1" } }] }] },
    { type: "paragraph", content: [{ type: "text", text: "正文内跳转", marks: [{ type: "link", attrs: { href: `#${ID2}` } }] }] }]
  source.content.attrs = { commentThreads: [{ id: "comment-1", text: "批注原文", quote: "原段正文", createdAt: "2026-10-04T01:00:00.000Z", updatedAt: "2026-10-04T01:00:00.000Z", resolved: false }] }
  const before = structuredClone(source)
  const result = await unpack(source)
  assert.ok(!result.warnings.some(text => text.includes("Word 导入暂不支持这种水印")))
  // M22 仅分离已验证的本项目水印元信息，未知 VML 的严格拒绝规则仍由导入专项覆盖。
  const imported = await convertDocxImport(new Uint8Array(await result.blob.arrayBuffer()))
  assert.deepEqual(imported.page.watermark, { ...watermark, text: watermark.text.trim() })
  assert.ok(!imported.html.includes(watermark.text.trim()))
  const headerFiles = result.zip.file(/^word\/header\d+\.xml$/)
  assert.equal(headerFiles.length, 1)
  const headerXml = await headerFiles[0].async("string")
  const header = parseXml(headerXml)
  const shape = header.getElementsByTagName("v:shape")[0]
  const type = header.getElementsByTagName("v:shapetype")[0]
  assert.notEqual(shape.getAttribute("id"), type.getAttribute("id"))
  assert.equal(shape.getAttribute("type"), `#${type.getAttribute("id")}`)
  assert.equal(shape.getAttribute("fillcolor"), watermark.color)
  assert.equal(shape.getElementsByTagName("v:fill")[0].getAttribute("opacity"), String(watermark.opacity))
  const styles = styleMap(shape.getAttribute("style"))
  assert.equal(styles.rotation, String(watermark.angle))
  assert.ok(Number(styles["z-index"]) < 0)
  for (const direction of ["horizontal", "vertical"]) {
    assert.equal(styles[`mso-position-${direction}`], "center")
    assert.equal(styles[`mso-position-${direction}-relative`], "page")
  }
  const textPath = shape.getElementsByTagName("v:textpath")[0]
  assert.equal(textPath.getAttribute("string"), watermark.text.trim())
  assert.equal(header.getElementsByTagName("w:t").length, 0)
  assert.doesNotMatch(headerXml, /<script>/)
  const geometry = getWatermarkGeometry(source.page)
  assert.equal(Number.parseFloat(styles.width), geometry.textWidthMm * 72 / 25.4)
  assert.equal(Number.parseFloat(styleMap(textPath.getAttribute("style"))["font-size"]), geometry.fontSizePt)
  const reference = result.parsed.getElementsByTagName("w:headerReference")[0]
  assert.equal(reference.getAttribute("w:type"), "default")
  const relationships = parseXml(await result.zip.file("word/_rels/document.xml.rels").async("string"))
  const relation = [...relationships.getElementsByTagName("Relationship")].find(node => node.getAttribute("Id") === reference.getAttribute("r:id"))
  assert.equal(relation.getAttribute("Target"), headerFiles[0].name.replace(/^word\//, ""))
  const bookmarkIds = [...result.parsed.getElementsByTagName("w:bookmarkStart")].map(node => node.getAttribute("w:id"))
  assert.equal(new Set(bookmarkIds).size, 2)
  assert.deepEqual(new Set([...result.parsed.getElementsByTagName("w:bookmarkEnd")].map(node => node.getAttribute("w:id"))), new Set(bookmarkIds))
  assert.ok(result.parsed.documentElement.textContent.includes("批注原文"))
  assert.ok(result.parsed.documentElement.textContent.includes("正文内跳转"))
  assert.ok(!result.parsed.documentElement.textContent.includes(watermark.text.trim()))
  assert.deepEqual(source, before)
})

test("HTML 单层水印文字安全转义且不进入正文，打印复用同层 fixed 重复，非对称边距只扣一次", async () => {
  const source = makeDocument("Letter", "landscape")
  source.page.watermark = { ...watermark }
  const before = structuredClone(source)
  const html = await createDocumentHtml(source, new Map())
  const rendered = new DOMParser().parseFromString(html, "text/html")
  const layer = rendered.querySelector(".mewoc-export-watermark")
  assert.equal(rendered.querySelectorAll(".mewoc-export-watermark").length, 1)
  assert.equal(layer.getAttribute("aria-hidden"), "true")
  const svg = layer.querySelector("svg")
  assert.equal(svg.getAttribute("viewBox"), "0 0 279.4 215.9")
  assert.equal(svg.querySelector("text").textContent, watermark.text.trim())
  assert.equal(svg.querySelector("text").getAttribute("fill"), watermark.color)
  assert.equal(svg.querySelector("text").getAttribute("opacity"), String(watermark.opacity))
  assert.equal(svg.querySelector("text").getAttribute("transform"), "rotate(-35 139.7 107.95)")
  // 实际 Chrome 多页 PDF 的绘制回归：打印图片必须与安全屏幕 SVG 使用同一份内容，不能重复可见。
  const image = layer.querySelector("img")
  assert.equal(image.getAttribute("alt"), "")
  assert.ok(image.getAttribute("src").startsWith("data:image/svg+xml,"))
  const printSvg = parseXml(decodeURIComponent(image.getAttribute("src").slice("data:image/svg+xml,".length)))
  assert.equal(printSvg.querySelector("text").textContent, watermark.text.trim())
  assert.equal(printSvg.querySelector("script"), null)
  assert.equal(printSvg.documentElement.getAttribute("viewBox"), svg.getAttribute("viewBox"))
  assert.equal(rendered.querySelector("script"), null)
  assert.equal(rendered.querySelector("article").textContent, before.content.content[0].content[0].text)
  const styles = rendered.querySelector("style").textContent
  assert.match(styles, /pointer-events: none; user-select: none/)
  assert.match(styles, /@media print[\s\S]*padding: 0/)
  assert.match(styles, /position: fixed; left: -23mm; top: -12mm/)
  assert.match(styles, /print-color-adjust: exact/)
  assert.match(styles, /@media print[\s\S]*watermark svg \{ display: none; \}[\s\S]*watermark img \{ display: block;/)
  assert.deepEqual(source, before)
})

test("水印几何在长文字与±90度保持旋转包围盒完整，空配置不生成水印节点", () => {
  for (const size of Object.keys(PAGE_SIZES)) for (const orientation of ["portrait", "landscape"]) for (const angle of [-90, -35, 0, 35, 90]) {
    const page = { ...makeDocument(size, orientation).page, watermark: { ...watermark, text: "长".repeat(80), angle } }
    const geometry = getWatermarkGeometry(page)
    const cosine = Math.abs(Math.cos(angle * Math.PI / 180))
    const sine = Math.abs(Math.sin(angle * Math.PI / 180))
    assert.ok(geometry.textWidthMm * cosine + geometry.textHeightMm * sine <= geometry.widthMm * 0.78 + 0.00001)
    assert.ok(geometry.textWidthMm * sine + geometry.textHeightMm * cosine <= geometry.heightMm * 0.78 + 0.00001)
    assert.equal(geometry.centerX, geometry.widthMm / 2)
    assert.equal(geometry.centerY, geometry.heightMm / 2)
    assert.ok(geometry.fontSizeMm > 0 && geometry.fontSizeMm <= 18)
    assert.equal(geometry.fontSizePt, geometry.fontSizeMm * 72 / 25.4)
  }
  for (const value of [undefined, null]) {
    const page = makeDocument().page
    if (value === null) page.watermark = null
    assert.equal(createWatermarkSvg(page), "")
    assert.equal(createPageExportLayout(page).watermark, "")
  }
})

test("Markdown/TXT 明确提示页面外观降级，水印文字不进入正文或批注内容", async () => {
  const source = makeDocument("A3", "landscape")
  const plainMarkdown = await createDocumentMarkdown(source)
  const plainText = createDocumentText(source)
  source.page.watermark = { ...watermark }
  const result = await createDocumentMarkdown(source)
  assert.equal(result.source, plainMarkdown.source)
  assert.equal(createDocumentText(source), plainText)
  assert.ok(result.warnings.some(text => text.includes("水印")))
  assert.ok(result.warnings.some(text => text.includes("纸张大小")))
  assert.ok(getDocumentTextWarnings(source).some(text => text.includes("水印")))
  assert.ok(getDocumentTextWarnings(source).some(text => text.includes("纸张大小")))
  assert.deepEqual(getDocumentTextWarnings(createDocument()), [])
})

test("HTML 异步输出固定页面与水印快照，调用后改变原页面不混入本轮结果", async () => {
  const source = makeDocument("A5", "landscape")
  source.page.watermark = { ...watermark }
  const pending = createDocumentHtml(source, new Map())
  source.page.size = "A3"
  source.page.watermark.text = "稍后新水印"
  const html = await pending
  assert.match(html, /size: 210mm 148mm/)
  assert.doesNotMatch(html, /稍后新水印/)
  assert.equal(new DOMParser().parseFromString(html, "text/html").querySelector("svg text").textContent, watermark.text.trim())
  assert.equal(source.page.watermark.text, "稍后新水印")
})

test("Word 门面与转换器固定完整页面快照，异步后修改方向、边距和水印不混合纸张设置", async () => {
  for (const convert of [createDocumentDocx, createSnapshotDocx]) {
    const source = makeDocument("A5", "landscape")
    source.page.watermark = { ...watermark }
    const pending = convert(source, new Map())
    source.page.size = "A3"
    source.page.orientation = "portrait"
    source.page.marginsMm.left = 40
    source.page.watermark.text = "稍后新水印"
    source.content.content[0].content[0].text = "稍后新正文"
    const result = await pending
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const parsed = parseXml(await zip.file("word/document.xml").async("string"))
    const page = parsed.getElementsByTagName("w:pgSz")[0]
    assert.equal(Number(page.getAttribute("w:w")), twips(210))
    assert.equal(Number(page.getAttribute("w:h")), twips(148))
    assert.equal(page.getAttribute("w:orient"), "landscape")
    assert.equal(Number(parsed.getElementsByTagName("w:pgMar")[0].getAttribute("w:left")), twips(23))
    assert.ok(parsed.documentElement.textContent.includes("正文保留，页面装饰不成为正文。"))
    assert.ok(!parsed.documentElement.textContent.includes("稍后新正文"))
    const header = parseXml(await zip.file(/^word\/header\d+\.xml$/)[0].async("string"))
    assert.equal(header.getElementsByTagName("v:shape")[0].getElementsByTagName("v:textpath")[0].getAttribute("string"), watermark.text.trim())
    assert.equal(source.page.watermark.text, "稍后新水印")
  }
})

test("含水印的打印 HTML 原样进入唯一 iframe，资源就绪才打印，afterprint 幂等移除该层", async () => {
  const source = makeDocument("A5", "portrait")
  source.page.watermark = { ...watermark }
  const html = await createDocumentHtml(source, new Map())
  const originalDocument = globalThis.document
  let finishFonts, printCount = 0, removed = false, removeCount = 0
  const printWindow = new EventTarget()
  printWindow.document = { fonts: { ready: new Promise(resolve => { finishFonts = resolve }) }, images: [] }
  printWindow.focus = () => undefined
  printWindow.print = () => { printCount += 1 }
  const frame = { style: {}, get contentWindow() { assert.equal(removed, false); return printWindow }, remove: () => { removed = true; removeCount += 1 } }
  globalThis.document = { createElement: type => { assert.equal(type, "iframe"); return frame }, body: { append: value => {
    assert.equal(value, frame)
    queueMicrotask(() => frame.onload?.())
  } } }
  try {
    const pending = printDocument(html)
    await Promise.resolve()
    assert.equal(frame.srcdoc, html)
    assert.equal(new DOMParser().parseFromString(frame.srcdoc, "text/html").querySelectorAll(".mewoc-export-watermark").length, 1)
    assert.equal(printCount, 0)
    finishFonts()
    const cleanup = await pending
    assert.equal(printCount, 1)
    assert.equal(removed, false)
    printWindow.dispatchEvent(new Event("afterprint"))
    assert.equal(removed, true)
    assert.equal(removeCount, 1)
    assert.doesNotThrow(cleanup)
    assert.equal(removeCount, 1)
  } finally { globalThis.document = originalDocument }
})
