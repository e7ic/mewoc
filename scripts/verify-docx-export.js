/**
 * 通过正式导出入口生成竖版、横版与长表格 DOCX 样例，供外部渲染/人工验收复用。
 * 同时保存对应 Mewoc 数据和字节哈希，便于把视觉结果追溯到具体输入及文件版本。
 */
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { JSDOM } from "jsdom"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { createComplexDocxDocument, createLongDocxTable } from "../tests/docx-fixture.js"

// 产物必须经过应用正式入口，渲染样例才可用于证明用户实际下载的转换行为。
globalThis.DOMParser = new JSDOM("").window.DOMParser
const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/m5-current-document.mewoc.json", import.meta.url), "utf8"))
// 将便携夹具中的 base64 资源还原为 Blob，使正式入口执行和真实下载相同的资源校验。
const assets = new Map(fixture.document.assets.map(asset => [asset.id, {
  ...asset, blob: new Blob([Buffer.from(fixture.assetData[asset.id].split(",")[1], "base64")], { type: asset.mimeType })
}]))
const output = new URL("../docs/m7-docx-evidence/integration/", import.meta.url)
await mkdir(output, { recursive: true })
// 竖横页面复用复杂语义夹具，长表格单独覆盖跨页行为；横版再变更左边距覆盖页面计算。
const samples = [
  ["complex-portrait", createComplexDocxDocument(fixture.document)],
  ["complex-landscape", createComplexDocxDocument(fixture.document)],
  ["long-table", createLongDocxTable(fixture.document)]
]
samples[1][1].page.orientation = "landscape"
samples[1][1].page.marginsMm.left = 30
const results = []
// 逐样例等待导出、写入证据并记录 warnings；任何转换失败会终止脚本，不生成虚假的通过记录。
for (const [name, source] of samples) {
  const { blob, warnings } = await createDocumentDocx(source, assets)
  const bytes = Buffer.from(await blob.arrayBuffer())
  await writeFile(new URL(`${name}.docx`, output), bytes)
  const portable = { ...fixture, document: source, assetData: source.assets.length ? fixture.assetData : {} }
  await writeFile(new URL(`${name}.mewoc.json`, output), `${JSON.stringify(portable, null, 2)}\n`)
  results.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), warnings })
}
// 生成记录含运行环境与文件哈希；它证明产物生成，Word/WPS 的视觉兼容仍由后续验收负责。
await writeFile(new URL("generation.json", output), `${JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, results }, null, 2)}\n`)
process.stdout.write(`已通过正式导出入口生成 ${results.length} 份 DOCX 验收样例\n`)
