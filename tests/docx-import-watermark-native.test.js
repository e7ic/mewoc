/** Word 16.100.2 原生回存的成对 VML：真实样本恢复与未知结构拒绝边界。 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import JSZip from "jszip"
import { extractDocxWatermark } from "../src/pages/editor/tools/docx-import-watermark.js"
import { readDocxXml, writeDocxXml, WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"

const VML_XML = "urn:schemas-microsoft-com:vml"
const PAGE = {
  size: "A5", orientation: "portrait", marginsMm: { top: 15, right: 15, bottom: 15, left: 15 }
}
const fixture = async (name = "word-resaved.docx") => {
  const bytes = await readFile(new URL(`../docs/m25-word-roundtrip-evidence/${name}`, import.meta.url))
  const zip = await JSZip.loadAsync(bytes)
  const parts = new Map()
  for (const part of zip.file(/\.(xml|rels)$/)) {
    parts.set(part.name, readDocxXml(await part.async("string"), part.name))
  }
  return { bytes, parts, warnings: new Set(), header: parts.get("word/header1.xml") }
}
const read = value => extractDocxWatermark(value.parts, PAGE, value.warnings)
const mutate = (value, transform) => {
  value.header = readDocxXml(transform(writeDocxXml(value.header)), "native header mutation")
  value.parts.set("word/header1.xml", value.header)
}

test("两份 Word 原生回存水印恢复设置并完整移除成对形状，原始压缩字节不变", async () => {
  for (const name of ["word-resaved.docx", "word-fields-updated.docx"]) {
    const value = await fixture(name)
    const bytes = value.bytes.slice()
    const body = writeDocxXml(value.parts.get("word/document.xml"))
    const watermark = read(value)
    assert.ok(watermark, name)
    assert.equal(watermark.text, "M25 原生验收")
    assert.equal(watermark.color.toLowerCase(), "#6554c0")
    assert.ok(Math.abs(watermark.opacity - 0.12) < 1 / 65536)
    assert.equal(watermark.angle, -35)
    assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "pict").length, 0)
    assert.equal(value.header.getElementsByTagNameNS(VML_XML, "shape").length, 0)
    assert.equal(writeDocxXml(value.parts.get("word/document.xml")), body)
    assert.deepEqual(value.bytes, bytes)
    assert.equal(value.warnings.size, 0)
  }
})

test("Word 成对水印缺失配对、额外内容、活动引用或改变几何时原样保留，不能只信 ID", async () => {
  for (const transform of [
    xml => xml.replace(/MewocWatermarkType_[a-f\d]{32}/, "UnknownWatermarkType"),
    xml => xml.replace(/(<v:shape id="MewocWatermarkShape_[^"]+")/, "$1 href=\"https://example.invalid/\""),
    xml => xml.replace("visibility:hidden", "visibility:visible"),
    xml => xml.replace("width:361.5pt", "width:362pt"),
    xml => xml.replace("font-family:&quot;Arial&quot;", "font-family:&quot;OtherFont&quot;"),
    xml => xml.replace("opacity=\"7864f\"", "opacity=\"1f\""),
    xml => xml.replace("rotation:325", "rotation:180"),
    xml => xml.replace("<v:formulas/>", "<v:formulas><v:f eqn=\"sum 0 0 0\"/></v:formulas>"),
    xml => xml.replace("<v:textpath on=\"t\"/>", "<v:textpath on=\"t\" string=\"不能丢失\"/>"),
    xml => xml.replace("o:connectlocs=\"0,344488;4591050,344488\"", "o:connectlocs=\"0,0;1,0\""),
    xml => xml.replace("</w:pict>", "不能丢失</w:pict>")
  ]) {
    const value = await fixture()
    mutate(value, transform)
    const before = writeDocxXml(value.header)
    assert.equal(read(value), undefined)
    assert.equal(writeDocxXml(value.header), before)
  }
})

test("Word 成对水印必须在同一直接段落且 ID 唯一，不能跨未知容器拼出有效水印", async () => {
  for (const change of [
    value => {
      const picture = value.header.getElementsByTagNameNS(WORD_XML, "pict")[0]
      picture.parentNode.appendChild(picture.cloneNode(true))
    },
    value => {
      const picture = value.header.getElementsByTagNameNS(WORD_XML, "pict")[0]
      const paragraph = value.header.createElementNS(WORD_XML, "w:p")
      paragraph.appendChild(picture.parentNode)
      value.header.documentElement.appendChild(paragraph)
    }
  ]) {
    const value = await fixture()
    change(value)
    const before = writeDocxXml(value.header)
    assert.equal(read(value), undefined)
    assert.equal(writeDocxXml(value.header), before)
  }
})

test("移除 Word 水印只影响已验证 pict，同段普通文字和未知图形继续保留", async () => {
  const value = await fixture()
  const picture = value.header.getElementsByTagNameNS(WORD_XML, "pict")[0]
  const paragraph = picture.parentNode.parentNode
  const content = readDocxXml(`<w:r xmlns:w="${WORD_XML}" xmlns:v="${VML_XML}"><w:t>普通页眉文字</w:t><w:pict><v:shape id="unknown"><v:textpath string="不能丢失"/></v:shape></w:pict></w:r>`, "extra header content")
  paragraph.appendChild(value.header.importNode(content.documentElement, true))
  assert.equal(read(value).text, "M25 原生验收")
  assert.ok(paragraph.textContent.includes("普通页眉文字"))
  assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "pict").length, 1)
  assert.equal(value.header.getElementsByTagNameNS(VML_XML, "shape")[0].getAttribute("id"), "unknown")
})

test("Word 定点不透明度保留实际精度，只有 5% 下界允许消除一个单位的量化误差", async () => {
  for (const [encoded, expected] of [["3276f", 0.05], ["32768f", 0.5], ["7864f", 7864 / 65536]]) {
    const value = await fixture()
    mutate(value, xml => xml.replace("opacity=\"7864f\"", `opacity="${encoded}"`))
    assert.equal(read(value).opacity, expected)
  }
  for (const encoded of ["3275f", "32769f", "7864f extra", "-7864f"]) {
    const value = await fixture()
    mutate(value, xml => xml.replace("opacity=\"7864f\"", `opacity="${encoded}"`))
    const before = writeDocxXml(value.header)
    assert.equal(read(value), undefined)
    assert.equal(writeDocxXml(value.header), before)
  }
})

test("混合原生与 canonical 水印按可见形状原文顺序选择首个，隐藏配对不提前占位", async () => {
  const zip = await JSZip.loadAsync(await readFile(new URL("../docs/m25-native-evidence/browser-export.docx", import.meta.url)))
  const original = await zip.file("word/header1.xml").async("string")
  const canonical = readDocxXml(original.replace(/MewocWatermark(Type|Shape)_[a-f\d]{32}/g,
    "MewocWatermark$1_ffffffffffffffffffffffffffffffff").replace("#6554C0", "#AB12EF"), "canonical watermark")
  const picture = canonical.getElementsByTagNameNS(WORD_XML, "pict")[0]
  for (const order of ["native-first", "canonical-first", "canonical-between-native-pair"]) {
    const value = await fixture()
    const nativePictures = Array.from(value.header.getElementsByTagNameNS(WORD_XML, "pict"))
    const paragraph = nativePictures[0].parentNode.parentNode
    if (order === "canonical-between-native-pair") {
      paragraph.insertBefore(value.header.importNode(picture.parentNode, true), nativePictures[1].parentNode)
    } else {
      const copy = value.header.importNode(picture.parentNode.parentNode, true)
      paragraph.parentNode.insertBefore(copy, order === "canonical-first" ? paragraph : paragraph.nextSibling)
    }
    assert.equal(read(value).color.toLowerCase(), order === "native-first" ? "#6554c0" : "#ab12ef", order)
    assert.equal(value.header.getElementsByTagNameNS(WORD_XML, "pict").length, 0)
    assert.ok([...value.warnings].some(warning => warning.includes("合并为首个水印")))
  }
})
