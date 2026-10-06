/** 精细图表设置的导出回归：核对 Word 单位/合并外观、Markdown 降级说明和 Mewoc 完整往返。 */
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import test from "node:test"
import { JSDOM } from "jsdom"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"

// 使用 docx 自身解析路径中的 ZIP 依赖，直接检查实际生成包内 XML。
const JSZip = createRequire(createRequire(import.meta.url).resolve("docx"))("jszip")
const dom = new JSDOM("")
globalThis.DOMParser = dom.window.DOMParser
// Node 侧补 data URL 读取以支持资源文件往返；字节仍来自真实 Blob。
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buffer => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`
      this.onload?.()
    }).catch(error => { this.error = error; this.onerror?.() })
  }
}
// 读取固定资源样例并还原原始字节，图片导出和重新导入可比较同一资源。
const fixture = JSON.parse(await readFile(new URL("./fixtures/m5-current-document.mewoc.json", import.meta.url), "utf8"))
const assets = new Map(fixture.document.assets.map(asset => [asset.id, {
  ...asset, blob: new Blob([Buffer.from(fixture.assetData[asset.id].split(",")[1], "base64")], { type: asset.mimeType })
}]))
// 共用表格 fixture 含显式颜色、内边距和边框，场景按需覆盖默认属性。
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const appearance = { backgroundColor: "#fff1ad", verticalAlign: "middle", paddingX: 18, paddingY: 12, borderColor: "#6942a3", borderWidth: 3, borderStyle: "dashed" }
const cell = (text, attrs = {}) => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [180], ...appearance, ...attrs }, content: [paragraph(text)] })
const row = (cells, minHeight = null) => ({ type: "tableRow", attrs: { minHeight }, content: cells })
const createFineDocument = () => ({ ...createDocument(), content: { type: "doc", content: [
  { type: "table", content: [row([cell("甲"), cell("乙")], 72), row([cell("丙"), cell("丁")])] }, paragraph("表格后")
] } })
// 从最终 DOCX 产物读取 XML 并验证可解析，返回转换说明供各兼容分支断言。
async function unpack(document, entries = new Map()) {
  const result = await createDocumentDocx(document, entries)
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml").async("string")
  const parsed = new dom.window.DOMParser().parseFromString(xml, "application/xml")
  assert.equal(parsed.querySelector("parsererror"), null)
  return { ...result, xml, parsed }
}

test("精细设置 Word：列宽、最小行高、单元格颜色和垂直对齐、边框、内边距使用正确单位", async () => {
  const document = createFineDocument()
  const before = JSON.stringify(document)
  const { parsed, warnings } = await unpack(document)
  assert.equal(JSON.stringify(document), before)
  assert.deepEqual(warnings, [])
  const first = parsed.getElementsByTagName("w:tc")[0]
  assert.equal(first.getElementsByTagName("w:tcW")[0].getAttribute("w:w"), "2700")
  assert.equal(first.getElementsByTagName("w:shd")[0].getAttribute("w:fill"), "FFF1AD")
  assert.equal(first.getElementsByTagName("w:vAlign")[0].getAttribute("w:val"), "center")
  const borders = first.getElementsByTagName("w:tcBorders")[0]
  for (const side of ["top", "left", "bottom", "right"]) {
    const border = borders.getElementsByTagName(`w:${side}`)[0]
    assert.equal(border.getAttribute("w:val"), "dashed")
    assert.equal(border.getAttribute("w:sz"), "18")
    assert.equal(border.getAttribute("w:color"), "6942A3")
  }
  const margins = first.getElementsByTagName("w:tcMar")[0]
  assert.equal(margins.getElementsByTagName("w:left")[0].getAttribute("w:w"), "270")
  assert.equal(margins.getElementsByTagName("w:top")[0].getAttribute("w:w"), "180")
  const heights = parsed.getElementsByTagName("w:trHeight")
  assert.equal(heights.length, 1)
  assert.equal(heights[0].getAttribute("w:val"), "1080")
  assert.equal(heights[0].getAttribute("w:hRule"), "atLeast")
})

test("精细设置 Word：纵向合并续行继承外观，零粗细或无边框不产生可见线", async () => {
  const document = createFineDocument()
  document.content.content[0].content = [row([cell("跨行", { rowspan: 2 }), cell("右上", { borderWidth: 0 })]), row([cell("右下", { borderStyle: "none", backgroundColor: null, verticalAlign: "bottom" })])]
  const { parsed } = await unpack(document)
  const cells = [...parsed.getElementsByTagName("w:tc")]
  const continuation = cells.find(node => node.getElementsByTagName("w:vMerge")[0]?.getAttribute("w:val") === "continue")
  assert.equal(continuation.getElementsByTagName("w:shd")[0].getAttribute("w:fill"), "FFF1AD")
  assert.equal(continuation.getElementsByTagName("w:vAlign")[0].getAttribute("w:val"), "center")
  for (const text of ["右上", "右下"]) {
    const node = cells.find(item => item.textContent === text)
    assert.equal(node.getElementsByTagName("w:tcBorders")[0].getElementsByTagName("w:top")[0].getAttribute("w:val"), "nil")
  }
})

// 导出可用宽度可能小于源内边距，缩减必须仅作用于产物且报告转换。
test("精细设置 Word：窄列内边距只缩减到可用范围并报告，源设置仍完整", async () => {
  const document = createFineDocument()
  document.content.content[0].content = [row([cell("窄列", { colwidth: [35], paddingX: 40 })])]
  const { parsed, warnings } = await unpack(document)
  assert.equal(warnings.filter(item => item.includes("内边距")).length, 1)
  const margins = parsed.getElementsByTagName("w:tcMar")[0]
  assert.equal(margins.getElementsByTagName("w:left")[0].getAttribute("w:w"), "83")
  assert.equal(document.content.content[0].content[0].content[0].attrs.paddingX, 40)
})

test("精细设置 Word：图片位置、自由拉伸尺寸和替代文本/说明完整输出", async () => {
  const document = createDocument()
  document.assets = fixture.document.assets
  document.content.content = [{ type: "image", attrs: { assetId: document.assets[0].id, width: 320, height: 90, align: "right", lockAspectRatio: false, alt: "精细图片", title: "图片说明" } }]
  const { parsed, warnings } = await unpack(document, assets)
  assert.deepEqual(warnings, [])
  const drawing = parsed.getElementsByTagName("w:drawing")[0]
  const extent = drawing.getElementsByTagName("wp:extent")[0]
  assert.equal(extent.getAttribute("cx"), String(320 * 9525))
  assert.equal(extent.getAttribute("cy"), String(90 * 9525))
  assert.equal(parsed.getElementsByTagName("w:jc")[0].getAttribute("w:val"), "right")
  const properties = drawing.getElementsByTagName("wp:docPr")[0]
  assert.equal(properties.getAttribute("descr"), "精细图片")
  assert.equal(properties.getAttribute("title"), "图片说明")
})

test("精细设置 Markdown：文字保留，布局限制逐类提示且去重", async () => {
  const { source, warnings } = await createDocumentMarkdown(createFineDocument())
  for (const text of ["甲", "乙", "丙", "丁", "表格后"]) assert.ok(source.includes(text))
  assert.equal(warnings.filter(text => text.includes("内边距")).length, 1)
  assert.equal(warnings.filter(text => text.includes("最小行高")).length, 1)
  assert.equal(warnings.filter(text => text.includes("列宽")).length, 1)
})

test("精细设置 Mewoc：全部属性、资源和小数图片尺寸原样传递，导入创建新 ID", async () => {
  const document = createFineDocument()
  document.assets = fixture.document.assets
  document.content.content.push({ type: "image", attrs: { assetId: document.assets[0].id, width: 310.5, height: 190.5, align: "center", lockAspectRatio: false, alt: "说明", title: "标题" } })
  const portable = await createPortableFile(document, assets)
  const imported = await readPortableFile(new File([JSON.stringify(portable)], "precision.mewoc.json"))
  assert.notEqual(imported.document.id, document.id)
  assert.deepEqual(imported.document.content, document.content)
  assert.equal(imported.assets.get(document.assets[0].id).blob.size, assets.get(document.assets[0].id).blob.size)
})

test("精细设置契约：非法颜色、枚举、尺寸和 CSS 不能通过文件校验", () => {
  const invalid = [{ paddingX: -1 }, { paddingY: 41 }, { paddingX: 1.5 }, { borderWidth: 7 }, { borderStyle: "double" }, { borderColor: "url(x)" }, { verticalAlign: "baseline" }]
  for (const attrs of invalid) {
    const document = createFineDocument()
    Object.assign(document.content.content[0].content[0].content[0].attrs, attrs)
    assert.throws(() => validateDocument(document))
  }
  for (const value of [0, 1001, 1.5, "72px"]) {
    const document = createFineDocument()
    document.content.content[0].content[0].attrs.minHeight = value
    assert.throws(() => validateDocument(document))
  }
  for (const attrs of [{ align: "justify" }, { lockAspectRatio: "false" }, { width: 20001 }, { height: 0 }]) {
    const document = createDocument()
    document.assets = fixture.document.assets
    document.content.content = [{ type: "image", attrs: { assetId: document.assets[0].id, width: 320, height: 90, align: "right", lockAspectRatio: false, ...attrs } }]
    assert.throws(() => validateDocument(document))
  }
})
