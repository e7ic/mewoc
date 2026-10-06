/**
 * 固定来源的独立 DOCX 兼容性回归：预期取自上游断言/源 XML，并校验夹具哈希。
 * 对支持样例执行导入、正式导出、再导入；对范围外样例核对拒绝理由，防止单靠自产样例误判兼容。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { JSDOM } from "jsdom"
import { imageSize } from "image-size"
import { getSchema } from "@tiptap/core"
import { TableMap } from "@tiptap/pm/tables"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"

// sources.json 固定来源版本与 SHA-256，测试启动时逐文件核对，避免夹具被改后继续沿用旧预期。
const ROOT = new URL("./fixtures/docx-compatibility/", import.meta.url)
const SOURCES = JSON.parse(await fs.readFile(new URL("sources.json", ROOT), "utf8"))
const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
// 本组锁定独立 DOCX 的语义，不用 Node 的尺寸读取冒充真实浏览器解码。
let CREATED = 0
let CLOSED = 0
globalThis.createImageBitmap = async blob => {
  const size = imageSize(new Uint8Array(await blob.arrayBuffer()))
  CREATED += 1
  return { ...size, close: () => { CLOSED += 1 } }
}
// 用实际编辑器 Schema 与 TableMap 判断合并表格合法性，全文相同不能证明网格结构正确。
const SCHEMA = getSchema(createExtensions())
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
// 递归文字读取用于比对语义正文；getNodes 按类型定位列表、标记、表格与图片。
const getText = node => node.text || (node.content || []).map(getText).join("")
const getNodes = (node, type) => [...(node.type === type ? [node] : []), ...(node.content || []).flatMap(child => getNodes(child, type))]
const read = async bytes => createDocxImportRecord(await convertDocxImport(bytes), "独立兼容性样例")
// 明确拒绝同样属于兼容契约，不能把脚注/批注或外链被转换器忽略当作通过。
const REJECTED = {
  "comments.docx": /批注/,
  "endnotes.docx": /尾注/,
  "external-picture.docx": /外部图片或文件/,
  "footnote-hyperlink.docx": /脚注/,
  "footnotes.docx": /脚注/,
  "strict-format.docx": /严格 Open XML.*另存为普通 Word 文档/
}
// 文本与结构预期来自上游验收断言及原始 XML，未从本项目转换结果生成快照。
const TEXT = {
  "text-box.docx": "Datum plane",
  "embedded-style-map.docx": "Walking on imported air",
  "empty.docx": "",
  "simple-list.docx": "AppleBanana",
  "single-paragraph.docx": "Walking on imported air",
  "strikethrough.docx": "Today's Special: Salmon Sold out",
  "tables.docx": "AboveTop leftTop rightBottom leftBottom rightBelow",
  "tiny-picture-target-base-relative.docx": "",
  "tiny-picture.docx": "",
  "underline.docx": "The Sunset Tree",
  "utf8-bom.docx": "This XML has a byte order mark.",
  "tbl-cell-access.docx": "1234567891234678912345679123469"
}
// 合并后的每个逻辑格对应的文字预期，重复值证明 rowspan/colspan 覆盖位置，而非重复正文。
const GRIDS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
  ["1", "2", "3", "4", "4", "6", "7", "8", "9"],
  ["1", "2", "3", "4", "5", "6", "7", "5", "9"],
  ["1", "2", "3", "4", "4", "6", "4", "4", "9"]
]

/** 同时检查独立样例的文字、标记、列表和表格结构，首次导入与往返结果复用同一套源事实。 */
function checkContent(file, record) {
  const content = record.document.content
  assert.equal(getText(content), TEXT[file])
  if (file === "simple-list.docx") {
    const lists = getNodes(content, "bulletList")
    assert.equal(lists.length, 1)
    assert.deepEqual(lists[0].content.map(getText), ["Apple", "Banana"])
  }
  if (file === "underline.docx") {
    const sunset = getNodes(content, "text").find(node => node.text === "Sunset")
    assert.ok(sunset.marks.some(mark => mark.type === "underline"))
    assert.ok(sunset.marks.some(mark => mark.type === "bold"))
  }
  if (file === "strikethrough.docx") {
    const marked = getNodes(content, "text").filter(node => node.marks?.some(mark => mark.type === "strike"))
    assert.equal(marked.map(getText).join(""), "Today's Special: Salmon")
  }
  if (file.startsWith("tiny-picture")) {
    assert.equal(getNodes(content, "image").length, 1)
    assert.equal(record.assets.size, 1)
  }
  if (file === "tables.docx" || file === "tbl-cell-access.docx") {
    const tables = getNodes(content, "table")
    assert.equal(tables.length, file === "tables.docx" ? 1 : 4)
    tables.forEach((table, index) => {
      const node = SCHEMA.nodeFromJSON(table)
      const map = TableMap.get(node)
      assert.equal(map.problems, null)
      assert.equal(map.width, file === "tables.docx" ? 2 : 3)
      assert.equal(map.height, map.width)
      const expected = file === "tables.docx" ? ["Top left", "Top right", "Bottom left", "Bottom right"] : GRIDS[index]
      assert.deepEqual(map.map.map(offset => node.nodeAt(offset).textContent), expected)
    })
  }
}

// 每个来源分别注册测试；支持样例还校验图片字节、位图关闭及输入不变，拒绝样例只核对错误。
for (const source of SOURCES) {
  test(`独立 DOCX：${source.file}（${REJECTED[source.file] ? "明确拒绝" : "导入与再次导出"}）`, async () => {
    const bytes = new Uint8Array(await fs.readFile(new URL(source.file, ROOT)))
    assert.equal(hash(bytes), source.sha256, "原始样例必须与固定版本来源一致")
    if (REJECTED[source.file]) {
      await assert.rejects(read(bytes), REJECTED[source.file])
      return
    }
    const result = await read(bytes)
    checkContent(source.file, result.record)
    const exported = await createDocumentDocx(result.record.document, result.record.assets)
    const restored = await read(new Uint8Array(await exported.blob.arrayBuffer()))
    checkContent(source.file, restored.record)
    // 资源 ID 在重新导入时可能重新生成，比较二进制哈希即可判断实际图片是否被替换或损坏。
    const assetHashes = async assets => Promise.all([...assets.values()].map(async asset => hash(new Uint8Array(await asset.blob.arrayBuffer()))))
    assert.deepEqual(await assetHashes(restored.record.assets), await assetHashes(result.record.assets))
    assert.equal(CLOSED, CREATED, "每个已创建的 Bitmap 都必须关闭")
    assert.equal(hash(bytes), source.sha256, "转换不能修改原始输入")
  })
}
