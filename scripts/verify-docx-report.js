/**
 * 私有报告的 DOCX 语义保真核对：正式导入/导出/再导入，同时独立读取原 ZIP 作预期。
 * 比较段落出现次数、每处图片的原字节及资源释放；输出仅为计数、哈希与转换说明。
 */
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { imageSize } from "image-size"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { readDocxXml, WORD_XML, getXmlChildren } from "../src/pages/editor/tools/docx-import-xml.js"

// 私有报告只通过命令行路径读取；报告输出仅含哈希和计数，不复制原文件或正文到仓库。
if (!process.argv[2]) throw new Error("用法：node scripts/verify-docx-report.js <原文件.docx> [验证记录.json]")
const source = new Uint8Array(await fs.readFile(process.argv[2]))
const hash = value => createHash("sha256").update(value).digest("hex")
const sourceHash = hash(source)
const dom = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = dom.window[key]
let opened = 0
let closed = 0
// Node 用尺寸替身检查生命周期；真实解码另由页面导入完成，不在此冒充浏览器结果。
globalThis.createImageBitmap = async blob => {
  opened += 1
  return { ...imageSize(new Uint8Array(await blob.arrayBuffer())), close: () => { closed += 1 } }
}
// 工具递归读取编辑器正文与目标类型节点，用于往返文本和图片出现次数核对。
const text = node => node.text || (node.content || []).map(text).join("")
const nodes = (node, type) => [...(node.type === type ? [node] : []), ...(node.content || []).flatMap(child => nodes(child, type))]
const read = async bytes => createDocxImportRecord(await convertDocxImport(bytes), "报告验证")
// 段落核对忽略排版空白差异，只检验有效文字与重复次数，不用它声称布局完全一致。
const compact = value => value.replace(/\s+/g, "")
try {
  const result = await read(source)
  const exported = await createDocumentDocx(result.record.document, result.record.assets)
  // 同一路径再导入正式导出的文件，先比较全文与每个图片引用的字节身份。
  const restored = await read(new Uint8Array(await exported.blob.arrayBuffer()))
  assert.equal(text(restored.record.document.content), text(result.record.document.content))
  // 按正文引用逐处取哈希：同一个去重资产多次出现仍产生多条记录，避免遗漏重复图片。
  const imageHashes = async record => Promise.all(nodes(record.document.content, "image").map(async node => hash(new Uint8Array(await record.assets.get(node.attrs.assetId).blob.arrayBuffer()))))
  const importedImages = await imageHashes(result.record)
  assert.deepEqual(await imageHashes(restored.record), importedImages)
  // 从原 ZIP 独立读取兼容分支、可见段落及图片关系，再与编辑器结果核对。
  const zip = await JSZip.loadAsync(source)
  const expectedImages = []
  const expectedParagraphs = new Map()
  for (const owner of Object.keys(zip.files).filter(name => /^word\/(document|header\d*|footer\d*)\.xml$/.test(name))) {
    const xml = readDocxXml(await zip.file(owner).async("string"), owner)
    // 独立选择源 XML 的兼容表示，只取 Fallback，防止同一图形 Choice/Fallback 被重复计数。
    const select = node => {
      for (const child of getXmlChildren(node)) {
        if (child.namespaceURI === "http://schemas.openxmlformats.org/markup-compatibility/2006" && child.localName === "AlternateContent") {
          const fallback = getXmlChildren(child).find(item => item.localName === "Fallback")
          assert.ok(fallback, "源图形必须有已验证的兼容表示")
          select(fallback)
          for (const content of Array.from(fallback.childNodes)) node.insertBefore(content, child)
          node.removeChild(child)
        } else select(child)
      }
    }
    select(xml.documentElement)
    // 一段只计入自己的文字，遇嵌套 w:p 立即截断，文本框子段随后单独统计，避免重复归属。
    const ownText = node => getXmlChildren(node).map(child => child.namespaceURI === WORD_XML && child.localName === "p" ? "" : child.namespaceURI === WORD_XML && child.localName === "t" ? child.textContent : ownText(child)).join("")
    for (const paragraph of Array.from(xml.getElementsByTagNameNS(WORD_XML, "p"))) {
      const value = compact(ownText(paragraph))
      if (value) expectedParagraphs.set(value, (expectedParagraphs.get(value) || 0) + 1)
    }
    // 每个 document/header/footer 各用自己的关系表解析图片，不能把重复 rId 当作同一资源。
    const relationshipPath = path.posix.join(path.posix.dirname(owner), "_rels", `${path.posix.basename(owner)}.rels`)
    const relationships = zip.file(relationshipPath) ? readDocxXml(await zip.file(relationshipPath).async("string"), relationshipPath) : null
    const relNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    for (const image of Array.from(xml.getElementsByTagNameNS("*", "*")).filter(node => ["blip", "imagedata"].includes(node.localName))) {
      const id = image.getAttributeNS(relNS, image.localName === "blip" ? "embed" : "id")
      const relation = Array.from(relationships?.getElementsByTagNameNS("*", "Relationship") || []).find(node => node.getAttribute("Id") === id)
      assert.ok(relation && relation.getAttribute("TargetMode") !== "External")
      const target = relation.getAttribute("Target")
      const imagePath = target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(owner), target))
      expectedImages.push(hash(await zip.file(imagePath).async("uint8array")))
    }
  }
  const content = compact(text(result.record.document.content))
  // 重复源段落必须至少保留相同次数；图片则严格比较多重集合，兼顾字节与出现次数。
  for (const [value, count] of expectedParagraphs) assert.ok(content.split(value).length - 1 >= count, "源段落文字或重复段落数量丢失")
  assert.deepEqual(importedImages.slice().sort(), expectedImages.sort(), "原文件的每处图片都应保留，字节及重复次数均一致")
  // 同时验证内存原字节和磁盘原文件未变，最后核对所有位图替身均被 close。
  assert.equal(hash(source), sourceHash)
  assert.equal(hash(await fs.readFile(process.argv[2])), sourceHash)
  assert.equal(closed, opened)
  // 证据不输出正文或资产内容，只留可复核计数/哈希；可选文件路径与 stdout 使用相同数据。
  const evidence = { checkedAt: new Date().toISOString(), sourceSha256: sourceHash, sourceBytes: source.length, imageOccurrences: importedImages.length, uniqueImages: result.record.assets.size, tables: nodes(result.record.document.content, "table").length, headings: nodes(result.record.document.content, "heading").length, sourceParagraphsChecked: [...expectedParagraphs.values()].reduce((sum, count) => sum + count, 0), originalTextAndImageChecks: "passed", roundTripTextAndImages: "passed", originalUnchanged: true, exportBytes: exported.blob.size, warnings: result.warnings }
  if (process.argv[3]) await fs.writeFile(process.argv[3], JSON.stringify(evidence, null, 2) + "\n")
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n")
} finally { dom.window.close() }
