/** Word 字母编号在 z 后重复同一字母；按真实 OOXML 解释显示标签，不能仅检查 lowerLetter 字段。 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { readDocxXml, getWordChild, getWordValue, WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"

const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const list = (type, start, count) => ({ type: "orderedList", attrs: { type, start }, content: Array.from({ length: count }, (_, index) => ({ type: "listItem", content: [paragraph(`项目 ${start + index}`)] })) })
const read = async bytes => createDocxImportRecord(await convertDocxImport(new Uint8Array(bytes)), "字母编号往返")
const text = node => node.text || (node.content || []).map(text).join("")
const lists = node => [...(node.type === "orderedList" ? [{ attrs: { type: node.attrs.type, start: node.attrs.start }, items: node.content.map(text) }] : []), ...(node.content || []).flatMap(lists)]
const alphabet = value => {
  let label = ""
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(97 + value % 26) + label
    value = Math.floor(value / 26)
  }
  return label
}

// 独立解释 Word 的原生编号标签；只有 1–26 时 lowerLetter 与浏览器规则相同。
async function labels(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const numbering = readDocxXml(await zip.file("word/numbering.xml").async("string"), "numbering")
  const document = readDocxXml(await zip.file("word/document.xml").async("string"), "document")
  const instances = new Map(Array.from(numbering.getElementsByTagNameNS(WORD_XML, "num"), node => [node.getAttributeNS(WORD_XML, "numId"), node]))
  const abstracts = new Map(Array.from(numbering.getElementsByTagNameNS(WORD_XML, "abstractNum"), node => [node.getAttributeNS(WORD_XML, "abstractNumId"), node]))
  const counts = new Map()
  const result = []
  for (const paragraph of Array.from(document.getElementsByTagNameNS(WORD_XML, "p"))) {
    const numPr = getWordChild(getWordChild(paragraph, "pPr"), "numPr")
    if (!numPr) continue
    const id = getWordValue(numPr, "numId")
    const depth = getWordValue(numPr, "ilvl")
    const instance = instances.get(id)
    const abstract = abstracts.get(getWordValue(instance, "abstractNumId"))
    const level = Array.from(abstract.getElementsByTagNameNS(WORD_XML, "lvl")).find(node => node.getAttributeNS(WORD_XML, "ilvl") === depth)
    const override = Array.from(instance.getElementsByTagNameNS(WORD_XML, "lvlOverride")).find(node => node.getAttributeNS(WORD_XML, "ilvl") === depth)
    const key = `${id}:${depth}`
    const value = counts.get(key) ?? Number(getWordValue(override, "startOverride") ?? getWordValue(level, "start"))
    counts.set(key, value + 1)
    const format = getWordValue(level, "numFmt")
    let label = String(value)
    if (["lowerLetter", "upperLetter"].includes(format)) label = String.fromCharCode((format === "upperLetter" ? 65 : 97) + (value - 1) % 26).repeat(Math.floor((value - 1) / 26) + 1)
    result.push(getWordValue(level, "lvlText").replace(`%${Number(depth) + 1}`, label))
  }
  return { labels: result, zip }
}

test("Word 字母列表跨 z、az、zz 后显示标签与浏览器相同，往返仍是原自动列表", async () => {
  for (const [type, start, count] of [["a", 7, 48], ["A", 24, 32], ["a", 699, 9], ["A", 999999990, 10]]) {
    const document = createDocument()
    document.content.content = [list(type, start, count)]
    const original = JSON.stringify(document)
    const exported = await createDocumentDocx(document, new Map())
    const bytes = await exported.blob.arrayBuffer()
    const rendered = await labels(bytes)
    const expected = Array.from({ length: count }, (_, index) => alphabet(start + index)).map(value => `${type === "A" ? value.toUpperCase() : value}.`)
    assert.deepEqual(rendered.labels, expected)
    assert.ok(exported.warnings.some(value => /字母编号/.test(value) && /分段/.test(value)))
    const imported = await read(bytes)
    assert.deepEqual(lists(imported.record.document.content), lists(document.content))
    const repeated = await createDocumentDocx(imported.record.document, imported.record.assets)
    assert.deepEqual((await labels(await repeated.blob.arrayBuffer())).labels, expected)
    assert.equal(JSON.stringify(document), original)
  }
})

test("字母分段保留嵌套、多段项目、同级相邻列表身份和不同起点", async () => {
  const document = createDocument()
  const parent = list("a", 24, 6)
  parent.content[2].content.push(paragraph("同项第二段"), list("A", 25, 5))
  document.content.content = [parent, list("a", 30, 3), list("A", 5, 4)]
  const exported = await createDocumentDocx(document, new Map())
  const imported = await read(await exported.blob.arrayBuffer())
  assert.deepEqual(lists(imported.record.document.content), lists(document.content))
  const first = imported.record.document.content.content[0]
  assert.equal(first.content[2].content[1].content[0].text, "同项第二段")
  assert.equal(first.content[2].content[2].type, "orderedList")
})

test("未跨界的短字母列表和数字、罗马列表保持原生编号，不产生分段提示", async () => {
  const document = createDocument()
  document.content.content = [list("a", 1, 26), list("A", 3, 4), list("1", 28, 4), list("i", 28, 4)]
  const exported = await createDocumentDocx(document, new Map())
  assert.ok(!exported.warnings.some(value => /字母编号/.test(value)))
  const imported = await read(await exported.blob.arrayBuffer())
  assert.deepEqual(lists(imported.record.document.content), lists(document.content))
})

test("自有字母分段的前缀、计数、隐藏状态和重启语义损坏时拒绝，不能凭样式名猜恢复", async () => {
  const document = createDocument()
  document.content.content = [list("a", 24, 32)]
  const exported = await createDocumentDocx(document, new Map())
  const bytes = await exported.blob.arrayBuffer()
  for (const [part, mutate] of [
    ["word/numbering.xml", xml => xml.replace('w:val="a%1."', 'w:val="a-%1."')],
    ["word/numbering.xml", xml => xml.replace('w:val="a%1."', 'w:val="A%1."')],
    ["word/numbering.xml", xml => xml.replace('w:start w:val="24"', 'w:start w:val="0"').replace('w:startOverride w:val="24"', 'w:startOverride w:val="0"')],
    ["word/numbering.xml", xml => xml.replace('<w:lvlText w:val="a%1."/>', '<w:lvlText w:val="a%1."/><w:suff w:val="nothing"/>')],
    ["word/numbering.xml", xml => xml.replace('<w:lvlText w:val="a%1."/>', '<w:lvlText w:val="a%1."/><w:unknown/>')],
    ["word/numbering.xml", xml => xml.replace(/(<w:lvlText w:val="a%1\."\/>[\s\S]*?<w:rPr>)/, "$1<w:vanish/>")],
    ["word/numbering.xml", xml => xml.replaceAll('w15:restartNumberingAfterBreak="0"', 'w15:restartNumberingAfterBreak="1"')],
    ["word/styles.xml", xml => xml.replace("Mewoc Alphabetic v1 group 1", "Foreign alphabetic list")],
    ["word/document.xml", xml => xml.replace(/(<w:p><w:pPr><w:pStyle w:val="MewocAlphaV1G1"\/>[\s\S]*?<\/w:p>)/, "$1$1$1$1")]
  ]) {
    const zip = await JSZip.loadAsync(bytes)
    const original = await zip.file(part).async("string")
    const changed = mutate(original)
    assert.notEqual(changed, original)
    zip.file(part, changed)
    await assert.rejects(read(await zip.generateAsync({ type: "uint8array" })), /编号/)
  }
})

test("Word 16.100.2 原生另存的大小写分段保留标签，改写样式 ID 后仍恢复完整列表", async () => {
  const bytes = await readFile(new URL("./fixtures/docx-compatibility/word-letter-segments.docx", import.meta.url))
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "06a6e95d15636b9a3f42d01d4cdaa7e7a290d09427717df374886d0296ab7588")
  const imported = await read(bytes)
  const recovered = lists(imported.record.document.content).slice(-2)
  for (const [index, type] of ["a", "A"].entries()) {
    assert.deepEqual(recovered[index].attrs, { start: 24, type })
    assert.deepEqual(recovered[index].items, Array.from({ length: 32 }, (_, offset) => {
      const value = offset + 24
      const label = type === "A" ? alphabet(value).toUpperCase() : alphabet(value)
      return `expected ${label}. item ${value}`
    }))
  }
  const native = await labels(bytes)
  assert.deepEqual(native.labels.slice(-64), ["a", "A"].flatMap(type => Array.from({ length: 32 }, (_, index) => {
    const label = alphabet(index + 24)
    return `${type === "A" ? label.toUpperCase() : label}.`
  })))
})
