/**
 * M25 Word 16.100.2 原生回存样本：覆盖生产转换器、页面恢复和主线程记录组装。
 * 样本来源及原生视觉证据见 docs/m25-word-roundtrip.md；图片尺寸桩不代表浏览器解码验收。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { imageSize } from "image-size"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"

const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
globalThis.createImageBitmap = async blob => ({ ...imageSize(new Uint8Array(await blob.arrayBuffer())), close() {} })
const MARKER = " M25_WORD_ROUNDTRIP_20261029"
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const readSample = path => readFile(new URL(`../docs/${path}`, import.meta.url))
const importSample = async bytes => createDocxImportRecord(await convertDocxImport(new Uint8Array(bytes)), "M25 原生回存回归")
const getText = node => node.type === "hardBreak" ? "\n" : node.text || (node.content || []).map(getText).join("")
function* walk(node) {
  yield node
  for (const child of node.content || []) yield* walk(child)
}
const contentSummary = content => {
  const nodes = [...walk(content)]
  return {
    nodes: nodes.filter(node => node.type !== "text").reduce((counts, node) => ({ ...counts, [node.type]: (counts[node.type] || 0) + 1 }), {}),
    tables: nodes.filter(node => node.type === "table").map(table => table.content.map(row => row.content.map(cell => ({
      type: cell.type, colspan: cell.attrs.colspan, rowspan: cell.attrs.rowspan, text: getText(cell)
    })))),
    lists: nodes.filter(node => node.type.endsWith("List")).map(list => ({ type: list.type, attrs: list.attrs, items: list.content.map(getText) })),
    images: nodes.filter(node => node.type === "image").map(node => ({ width: node.attrs.width, height: node.attrs.height }))
  }
}
const assetSummary = async assets => Promise.all([...assets.values()].map(async asset => ({
  mimeType: asset.mimeType, bytes: asset.blob.size, sha256: sha256(new Uint8Array(await asset.blob.arrayBuffer()))
})))
const assertPage = (actual, expected) => {
  // Word 将透明度存为 16.16 固定点数并小写化色值；只容许量化误差和等值色号。
  assert.ok(Math.abs(actual.watermark.opacity - expected.watermark.opacity) <= 1 / 65536)
  assert.deepEqual({ ...actual, watermark: { ...actual.watermark, color: actual.watermark.color.toUpperCase(), opacity: expected.watermark.opacity } },
    { ...expected, watermark: { ...expected.watermark, color: expected.watermark.color.toUpperCase() } })
}

for (const [name, hash, baselinePath = "m25-native-evidence/browser-export.docx", marker = MARKER] of [
  ["word-resaved.docx", "24f9a48d2dbe61198d134c0850965c53a85de9a45a925eb46edcde2e84ea69d2"],
  ["word-fields-updated.docx", "5e0bfac24daa32a13526358c625a4abf34576567a95aa9595d0ef90c6e831742"],
  ["display-fix/word-resaved.docx", "cf1ce811cc900a654074c70dd8a2bd5c44498a4a33690648b22255aa6637cc73",
    "m25-word-roundtrip-evidence/display-fix/browser-export.docx", " M25_WORD_FINAL_20261029"]
]) {
  test(`真实 Word 回存 ${name} 恢复动态页面设置、全部正文及原图字节`, async () => {
    const baseline = await importSample(await readSample(baselinePath))
    const bytes = await readSample(`m25-word-roundtrip-evidence/${name}`)
    assert.equal(sha256(bytes), hash, "原生样本必须保持验收时的原始字节")
    const result = await importSample(bytes)
    assertPage(result.record.document.page, baseline.record.document.page)
    assert.deepEqual(result.record.document.page.header, { text: "M25 持续验收", alignment: "left", pageNumber: "page" })
    assert.deepEqual(result.record.document.page.footer, { text: "原始文档与资源", alignment: "center", pageNumber: "page-total" })
    assert.deepEqual({ ...result.record.document.page.watermark, color: result.record.document.page.watermark.color.toUpperCase(), opacity: 0.12 },
      { text: "M25 原生验收", color: "#6554C0", opacity: 0.12, angle: -35 })
    assert.equal(getText(result.record.document.content), getText(baseline.record.document.content) + marker)
    assert.deepEqual(contentSummary(result.record.document.content), contentSummary(baseline.record.document.content))
    assert.deepEqual(contentSummary(result.record.document.content).nodes, {
      doc: 1, image: 1, paragraph: 178, table: 2, tableRow: 49, tableHeader: 2, tableCell: 95,
      orderedList: 1, listItem: 48, hardBreak: 89
    })
    for (const [text, count] of [["M25_SOAK_DOCUMENT_START", 1], ["M25_SOAK_DOCUMENT_END", 1],
      ["同一段中英文 Mixed text", 110], ["引用中的长段落持续跨页", 80], ["const line", 90], ["[x] ", 8], ["[ ] ", 16]]) {
      assert.equal(getText(result.record.document.content).split(text).length - 1, count, text)
    }
    assert.deepEqual(await assetSummary(result.record.assets), await assetSummary(baseline.record.assets))
    assert.deepEqual(await assetSummary(result.record.assets), [{ mimeType: "image/png", bytes: 1100, sha256: "3000f55839a18c6dfd0eba68fa2912af63d525c33b1c402d4fdbef7ca1aa4c4b" }])
    assert.ok(!result.warnings.some(warning => /页码为原文件保存值|目录、页码|原文页眉|原文页脚/.test(warning)))
    assert.equal(sha256(bytes), hash, "恢复仅修改内存 DOM，不能改写原样本")

    const exported = await createDocumentDocx(result.record.document, result.record.assets)
    const repeated = await importSample(await exported.blob.arrayBuffer())
    assert.deepEqual(repeated.record.document.page, result.record.document.page)
    assert.equal(getText(repeated.record.document.content), getText(result.record.document.content))
    assert.deepEqual(contentSummary(repeated.record.document.content), contentSummary(result.record.document.content))
    assert.deepEqual(await assetSummary(repeated.record.assets), await assetSummary(result.record.assets))
  })
}

test("原生 Word 样本的未知控件内容、复杂域指令或残缺字段仍拒绝，不能只凭 marker 吞掉", async () => {
  const source = await readSample("m25-word-roundtrip-evidence/word-resaved.docx")
  for (const [label, mutate] of [
    ["未知属性", xml => xml.replace("<w:sdt>", '<w:sdt onclick="bad">')],
    ["额外段落", xml => xml.replace("</w:sdtContent>", "<w:p><w:r><w:t>不能丢失的页眉正文</w:t></w:r></w:p></w:sdtContent>")],
    ["额外 SDT 用途", xml => xml.replace("</w:sdtPr>", '<w:alias w:val="未知用途"/></w:sdtPr>')],
    ["外部域指令", xml => xml.replace(">PAGE</w:instrText>", ">INCLUDETEXT external</w:instrText>")],
    ["缺少 separate", xml => xml.replace('<w:fldChar w:fldCharType="separate"/>', "")],
    ["缺少 end", xml => xml.replace('<w:fldChar w:fldCharType="end"/>', "")],
    ["嵌套 begin", xml => xml.replace('<w:fldChar w:fldCharType="separate"/>', '<w:fldChar w:fldCharType="begin"/>')]
  ]) {
    const zip = await JSZip.loadAsync(source)
    const original = await zip.file("word/header1.xml").async("string")
    const changed = mutate(original)
    assert.notEqual(changed, original, `${label} 必须实际改变原生样本`)
    zip.file("word/header1.xml", changed)
    await assert.rejects(importSample(await zip.generateAsync({ type: "uint8array" })), /页眉、页脚|内容控件|字段|域/, label)
  }
})
