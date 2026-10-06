/**
 * DOCX 导入原型的闭环验收：导入后用真实编辑器编辑，再保存/恢复 Mewoc 并重新导出 DOCX。
 * 校验正文可编辑、持久化内容一致与图片字节不变；证据保留原型范围，不声称生产 UI 已验证。
 */
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { JSDOM } from "jsdom"
import JSZip from "jszip"
import { Editor } from "@tiptap/core"
import { readDocxPrototype } from "../tests/docx-import-prototype/read.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"

// JSDOM 提供 Tiptap/HTML 转换所需 DOM 全局，脚本完成时关闭，避免测试环境悬挂。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
// 仅给 Node 验证脚本补浏览器文件读取边界，生产代码继续使用原生 FileReader。
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(bytes => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`
      this.onload()
    }, () => this.onerror())
  }
}
// 可指定单个输入和输出目录；省略参数时按固定竖版、横版、长表格集验证。
const OUTPUT = path.resolve(process.argv[3] || "docs/m7-docx-evidence/import-prototype")
const SOURCES = process.argv[2] ? [process.argv[2]] : [
  "docs/m7-docx-evidence/portrait.docx",
  "docs/m7-docx-evidence/landscape.docx",
  "docs/m7-docx-evidence/integration/long-table.docx"
]
const RESULTS = []
// 以 SHA-256 记录输入、输出及图片字节身份，比只比较数量更能发现资源损坏或替换。
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
await fs.mkdir(OUTPUT, { recursive: true })
try {
  for (const file of SOURCES) {
    const source = await fs.readFile(file)
    const name = path.basename(file, ".docx")
    const { record, warnings } = await readDocxPrototype(source, `DOCX 导入验证 · ${name}`)
    // 真正载入 Tiptap Schema 后插入文字，以证明结果可编辑，而非只有一个能读取的静态 JSON。
    const editor = new Editor({ extensions: createExtensions(), content: record.document.content })
    try {
      editor.commands.insertContentAt(1, "导入后编辑验证：")
      record.document.content = editor.getJSON()
      const portable = await createPortableFile(record.document, record.assets)
      const json = JSON.stringify(portable, null, 2)
      const restored = await readPortableFile(new File([json], `${name}.mewoc.json`))
      // 文件往返比较 JSON 数据；ProseMirror attrs 的空原型不属于持久化内容。
      assert.deepEqual(restored.document.content, JSON.parse(JSON.stringify(record.document.content)))
      // 每个恢复资源逐一比较原字节哈希，并把元数据与哈希写入证据，不靠 Blob 对象身份判等。
      const assets = []
      for (const [id, asset] of restored.assets) {
        const digest = hash(new Uint8Array(await asset.blob.arrayBuffer()))
        assert.equal(digest, hash(new Uint8Array(await record.assets.get(id).blob.arrayBuffer())))
        assets.push({ fileName: asset.fileName, bytes: asset.byteLength, sha256: digest })
      }
      // 再走正式导出入口并检查 OOXML 含新插入文字，证明编辑结果没有在导出阶段丢失。
      const exported = await createDocumentDocx(restored.document, restored.assets)
      const zip = await JSZip.loadAsync(await exported.blob.arrayBuffer())
      assert.match(await zip.file("word/document.xml").async("string"), /导入后编辑验证/)
      await fs.writeFile(path.join(OUTPUT, `${name}.mewoc.json`), json + "\n")
      RESULTS.push({ source: file, sourceSha256: hash(source), output: `${name}.mewoc.json`, outputSha256: hash(Buffer.from(json + "\n")), assets, warnings, editedSavedRestoredExported: true, exportedBytes: exported.blob.size })
    // 每份样例均销毁编辑器，即使断言/导出失败也不残留插件与 DOM 监听。
    } finally { editor.destroy() }
  }
  // 明确列出未安装的目标桌面应用与原型边界，Node 断言通过不等同于 Word/WPS 排版已验收。
  const record = { checkedAt: new Date().toISOString(), node: process.version, baseline: "76a3b56", scope: "Node import prototype; no production import UI", targetApplications: { Word: "not installed; unverified", WPS: "not installed; unverified" }, results: RESULTS }
  await fs.writeFile(path.join(OUTPUT, "checks.json"), JSON.stringify(record, null, 2) + "\n")
  process.stdout.write(`DOCX 导入原型验证通过：${RESULTS.length} 个样例，结果位于 ${OUTPUT}\n`)
} finally { DOM.window.close() }
