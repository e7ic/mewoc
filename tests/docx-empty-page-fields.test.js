/** 脱敏空页码域回归：只在普通页眉页脚保留明确占位，不推算数字或吞掉正文。 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord } from "../src/pages/editor/tools/docx-import-session.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { WORD_XML } from "../src/pages/editor/tools/docx-import-xml.js"

const DOM = new JSDOM("<!doctype html><body></body>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
const SOURCE = await readFile(new URL("./fixtures/docx-compatibility/single-paragraph.docx", import.meta.url))
const REL_XML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const PACKAGE_XML = "http://schemas.openxmlformats.org/package/2006/relationships"
const text = value => `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`
const marker = type => `<w:fldChar w:fldCharType="${type}"/>`
const field = instruction => `${marker("begin")}<w:instrText xml:space="preserve">${instruction}</w:instrText>${marker("separate")}${marker("end")}`
const getText = node => node.text || (node.content || []).map(getText).join("")
const read = async bytes => createDocxImportRecord(await convertDocxImport(bytes), "脱敏空页码域")
const makeFile = async (content, kind = "footer") => {
  const zip = await JSZip.loadAsync(SOURCE)
  const page = kind !== "body"
  zip.file("word/document.xml", `<w:document xmlns:w="${WORD_XML}" xmlns:r="${REL_XML}"><w:body><w:p>${page ? text("脱敏正文") : content}</w:p>${page ? `<w:sectPr><w:${kind}Reference w:type="default" r:id="page"/></w:sectPr>` : ""}</w:body></w:document>`)
  if (page) {
    zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="${PACKAGE_XML}"><Relationship Id="page" Type="${REL_XML}/${kind}" Target="${kind}1.xml"/></Relationships>`)
    zip.file(`word/${kind}1.xml`, `<w:${kind === "header" ? "hdr" : "ftr"} xmlns:w="${WORD_XML}"><w:p>${content}</w:p></w:${kind === "header" ? "hdr" : "ftr"}>`)
  }
  return zip.generateAsync({ type: "uint8array" })
}

test("同一 run 内的完整空 PAGE/NUMPAGES 以明确占位导入，保留正文与页脚上下文", async () => {
  const bytes = await makeFile(`${text("第 ")}<w:r>${field("PAGE")}</w:r>${text(" / ")}<w:r>${field("NUMPAGES")}</w:r>${text(" 页")}`)
  const before = bytes.slice()
  const result = await read(bytes)
  assert.equal(getText(result.record.document.content), "脱敏正文原文页脚（静态内容）第 [页码] / [总页数] 页")
  assert.equal(result.record.document.page.footer, undefined)
  assert.ok(result.warnings.some(value => value.includes("页码域未保存实际数字") && value.includes("不会随编辑或分页自动更新")))
  assert.deepEqual(bytes, before)
  const exported = await createDocumentDocx(result.record.document, result.record.assets)
  assert.equal(getText((await read(new Uint8Array(await exported.blob.arrayBuffer()))).record.document.content), getText(result.record.document.content))
})

test("简单空域及跨 run 完整空域支持普通页眉页脚，空文本节点不伪装为缓存", async () => {
  for (const kind of ["header", "footer"]) for (const content of [
    '<w:fldSimple w:instr="PAGE"/><w:fldSimple w:instr="NUMPAGES"><w:r><w:t/></w:r></w:fldSimple>',
    `<w:r>${marker("begin")}</w:r><w:r><w:instrText>PA</w:instrText></w:r><w:r><w:instrText>GE</w:instrText></w:r><w:r>${marker("separate")}</w:r><w:r><w:t/></w:r><w:r>${marker("end")}</w:r><w:fldSimple w:instr="NUMPAGES"/>`
  ]) {
    const result = await read(await makeFile(content, kind))
    assert.equal(getText(result.record.document.content), `脱敏正文原文${kind === "header" ? "页眉" : "页脚"}（静态内容）[页码][总页数]`)
  }
})

test("正常缓存值仍按原样保留，不替换成占位或假定当前分页", async () => {
  const content = `<w:fldSimple w:instr="PAGE">${text("7")}</w:fldSimple><w:r>${field("NUMPAGES").replace(marker("end"), `<w:t>19</w:t>${marker("end")}`)}</w:r>`
  const result = await read(await makeFile(content))
  assert.equal(getText(result.record.document.content), "脱敏正文原文页脚（静态内容）719")
  assert.ok(!result.warnings.some(value => value.includes("未保存实际数字")))
})

test("正文空域以及 TOC/PAGEREF/未知指令和未支持开关保持拒绝", async () => {
  for (const content of ['<w:fldSimple w:instr="PAGE"/>', `<w:r>${field("NUMPAGES")}</w:r>`]) {
    await assert.rejects(read(await makeFile(content, "body")), /域/)
  }
  for (const instruction of ["TOC", "PAGEREF bookmark", "INCLUDETEXT file", "PAGE \\* MERGEFORMAT", "NUMPAGES extra"]) {
    for (const content of [`<w:fldSimple w:instr="${instruction}"/>`, `<w:r>${field(instruction)}</w:r>`]) {
      await assert.rejects(read(await makeFile(content)), /域/)
    }
  }
})

test("残缺、重复、嵌套或混入未知内容的空域不能靠占位通过", async () => {
  const empty = field("PAGE")
  for (const content of [
    `<w:r>${empty.replace(marker("end"), "")}</w:r>`,
    `<w:r>${empty.replace(marker("separate"), "")}</w:r>`,
    `<w:r>${empty.replace(marker("begin"), "")}</w:r>`,
    `<w:r>${empty.replace(marker("separate"), marker("separate") + marker("separate"))}</w:r>`,
    `<w:r>${empty.replace(marker("separate"), marker("begin") + marker("separate"))}</w:r>`,
    `<w:r>${empty.replace(marker("end"), field("NUMPAGES") + marker("end"))}</w:r>`,
    `<w:r>${marker("begin")}<w:instrText>TOC</w:instrText>${marker("separate")}${field("PAGE")}${marker("end")}</w:r>`,
    `<w:r>${marker("begin")}<w:instrText>TOC</w:instrText>${marker("separate")}</w:r><w:fldSimple w:instr="PAGE"/><w:r>${marker("end")}</w:r>`,
    '<w:fldSimple w:instr="PAGE"><w:fldSimple w:instr="NUMPAGES"/></w:fldSimple>',
    '<w:fldSimple w:instr="PAGE"><w:r><w:unknown>不能丢失</w:unknown></w:r></w:fldSimple>',
    '<w:fldSimple w:instr="PAGE" unknown="1"/>',
    `<w:r>${empty.replace(marker("end"), "<w:unknown>不能丢失</w:unknown>" + marker("end"))}</w:r>`,
    `<w:r>${empty.replace('w:fldCharType="begin"', 'w:fldCharType="begin" unknown="1"')}</w:r>`,
    `<w:r>${empty.replace("<w:instrText", '<w:instrText unknown="1"')}</w:r>`,
    `<w:r>${empty.replace(marker("end"), "<w:br/>" + marker("end"))}</w:r>`,
    `<w:r>${empty.replace(marker("end"), `</w:r></w:p><w:p><w:r>${marker("end")}`)}</w:r>`
  ]) await assert.rejects(read(await makeFile(content)), /域|未能完整转换/)
})
