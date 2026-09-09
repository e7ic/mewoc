import assert from "node:assert/strict"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { createDocxPrototype } from "../tests/docx-prototype/export.js"

// 样例阶段使用调用方明确提供的工作区 SDK，保持 package.json 和生产分包不变。
// 正式接入前还需单独固定项目依赖、浏览器分包、下载与卸载契约。
const modules = process.argv[2]
if (!modules || !path.isAbsolute(modules)) throw new Error("请传入工作区运行时 node_modules 的绝对路径")
const require = createRequire(path.join(modules, "docx/package.json"))
const sdk = require("docx")
const JSZip = require("jszip")
const sdkPackage = JSON.parse(await readFile(path.join(modules, "docx/package.json"), "utf8"))
assert.equal(sdkPackage.version, "9.6.1", "本轮样例固定使用 docx 9.6.1")
const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/m5-current-document.mewoc.json", import.meta.url), "utf8"))
const assets = new Map(fixture.document.assets.map(asset => [asset.id, {
  ...asset, blob: new Blob([Buffer.from(fixture.assetData[asset.id].split(",")[1], "base64")], { type: asset.mimeType })
}]))
const source = structuredClone(fixture.document)
source.title = "M7 DOCX 导出验证"
source.content.content[0].content[0].text = "DOCX 图文表格验证"
// 在原有图表与分页样例中补显式样式，验证 JSON 单位进入 OOXML 后没有丢失。
source.content.content[1] = {
  type: "paragraph", attrs: { lineHeight: 1.5, firstLineIndent: 2, textAlign: "left" },
  content: [
    { type: "text", text: "中文与 English 样式验证。" },
    { type: "text", text: "彩色加粗下划线", marks: [{ type: "bold" }, { type: "underline" }, { type: "textStyle", attrs: { fontSize: "14pt", color: "#6942a3", backgroundColor: "#fff1ad" } }] }
  ]
}
const output = process.argv[3] ? pathToFileURL(`${path.resolve(process.argv[3])}${path.sep}`) : new URL("../docs/m7-docx-evidence/", import.meta.url)
await mkdir(output, { recursive: true })
const results = []
for (const orientation of ["portrait", "landscape"]) {
  const document = structuredClone(source)
  document.page.orientation = orientation
  document.page.marginsMm.left = orientation === "landscape" ? 30 : 20
  const before = JSON.stringify(document)
  const { file, warnings } = await createDocxPrototype(document, assets, sdk)
  const buffer = await sdk.Packer.toBuffer(file)
  assert.equal(JSON.stringify(document), before, "转换不能改写输入文档")
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file("word/document.xml").async("string")
  const relations = await zip.file("word/_rels/document.xml.rels").async("string")
  assert.match(xml, /w:sz w:val="28"/)
  assert.match(xml, /w:color w:val="6942a3"/i)
  assert.match(xml, /w:fill="fff1ad"/i)
  assert.match(xml, /w:firstLine="480"/)
  assert.match(xml, /w:line="360"/)
  assert.match(xml, /w:br w:type="page"/)
  assert.match(xml, /<w:tblGrid><w:gridCol w:w="2400"\/><w:gridCol w:w="2400"\/><w:gridCol w:w="2400"\/><\/w:tblGrid>/)
  assert.match(xml, /cx="2286000" cy="1143000"/)
  assert.match(xml, /E = mc\^2/)
  assert.match(xml, /const message/)
  assert.match(xml, /M5验收.txt/)
  assert.doesNotMatch(xml, /blob:http|contenteditable|data-resize-handle/)
  const size = orientation === "landscape" ? 'w:w="16838" w:h="11906"' : 'w:w="11906" w:h="16838"'
  assert.ok(xml.includes(size), `纸张宽高错误：${orientation}`)
  assert.ok(xml.includes(`w:left="${orientation === "landscape" ? 1701 : 1134}"`))
  assert.match(relations, /relationships\/image/)
  const media = Object.values(zip.files).filter(entry => entry.name.startsWith("word/media/") && !entry.dir)
  assert.equal(media.length, 1)
  assert.deepEqual(await media[0].async("nodebuffer"), Buffer.from(await assets.get("m5-image").blob.arrayBuffer()))
  assert.equal(warnings.length, 3)
  await writeFile(new URL(`${orientation}.docx`, output), buffer)
  results.push({ name: `${orientation}：纸张、页边距、样式、缩进、图表、分页、源数据不可变`, passed: true, bytes: buffer.length, warnings })
}

async function checkRejected(name, change, pattern, entries = assets) {
  const document = structuredClone(source)
  change(document)
  await assert.rejects(() => createDocxPrototype(document, entries, sdk), pattern)
  results.push({ name, passed: true })
}
await checkRejected("缺失资源拒绝导出", () => {}, /资源.*缺失/, new Map())
await checkRejected("有效但超宽的表格拒绝裁切", document => {
  document.content.content[3].content.forEach(row => row.content.forEach(cell => { cell.attrs.colwidth = [400] }))
}, /表格超出/)
await checkRejected("合并单元格明确拒绝", document => {
  const row = document.content.content[3].content[0]
  row.content[0].attrs.colspan = 2
  row.content[0].attrs.colwidth = [160, 160]
  row.content.splice(1, 1)
}, /合并单元格/)
await checkRejected("范围外列表不静默丢失", document => {
  document.content.content.push({ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "列表" }] }] }] })
}, /暂不支持节点 bulletList/)
await checkRejected("未知节点由应用 Schema 拒绝", document => {
  document.content.content.push({ type: "unknown" })
}, /节点/)
const rounded = structuredClone(source)
rounded.content.content[0].attrs.level = 3
const roundedResult = await createDocxPrototype(rounded, assets, sdk)
assert.ok(roundedResult.warnings.some(message => message.includes("半磅")))
results.push({ name: "H3 四分之一磅字号转换提示", passed: true })
const report = { generatedAt: new Date().toISOString(), baseline: "5490b65", sdk: `docx ${sdkPackage.version}`, node: process.version, results }
await writeFile(new URL("checks.json", output), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${results.length}/${results.length} DOCX 样例检查通过\n`)
