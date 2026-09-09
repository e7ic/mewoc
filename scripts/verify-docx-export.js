import { readFile, mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { JSDOM } from "jsdom"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { createComplexDocxDocument, createLongDocxTable } from "../tests/docx-fixture.js"

// 产物必须经过应用正式入口，渲染样例才可用于证明用户实际下载的转换行为。
globalThis.DOMParser = new JSDOM("").window.DOMParser
const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/m5-current-document.mewoc.json", import.meta.url), "utf8"))
const assets = new Map(fixture.document.assets.map(asset => [asset.id, {
  ...asset, blob: new Blob([Buffer.from(fixture.assetData[asset.id].split(",")[1], "base64")], { type: asset.mimeType })
}]))
const output = new URL("../docs/m7-docx-evidence/integration/", import.meta.url)
await mkdir(output, { recursive: true })
const samples = [
  ["complex-portrait", createComplexDocxDocument(fixture.document)],
  ["complex-landscape", createComplexDocxDocument(fixture.document)],
  ["long-table", createLongDocxTable(fixture.document)]
]
samples[1][1].page.orientation = "landscape"
samples[1][1].page.marginsMm.left = 30
const results = []
for (const [name, source] of samples) {
  const { blob, warnings } = await createDocumentDocx(source, assets)
  const bytes = Buffer.from(await blob.arrayBuffer())
  await writeFile(new URL(`${name}.docx`, output), bytes)
  const portable = { ...fixture, document: source, assetData: source.assets.length ? fixture.assetData : {} }
  await writeFile(new URL(`${name}.mewoc.json`, output), `${JSON.stringify(portable, null, 2)}\n`)
  results.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), warnings })
}
await writeFile(new URL("generation.json", output), `${JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, results }, null, 2)}\n`)
process.stdout.write(`已通过正式导出入口生成 ${results.length} 份 DOCX 验收样例\n`)
