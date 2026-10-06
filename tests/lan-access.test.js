/**
 * 验证非安全上下文缺少 crypto.randomUUID 时，文档/附件创建和便携导入仍能生成 UUID v4。
 * 仅提供安全随机字节 API 模拟局域网 HTTP 能力边界，原始全局 crypto 在 finally 恢复。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { webcrypto } from "node:crypto"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { readAttachmentFile } from "../src/pages/editor/tools/attachment-assets.js"
import { readPortableFile } from "../src/pages/editor/tools/portable-file.js"

test("局域网 HTTP 缺少 randomUUID 时仍能新建文档、读取附件和导入文件", async () => {
  // 故意移除便捷 UUID API 而保留 getRandomValues，确保生成链路确实走兼容实现，并保存原属性描述符以还原环境。
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")
  Object.defineProperty(globalThis, "crypto", {
    configurable: true, value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
  })
  try {
    const document = createDocument()
    const asset = await readAttachmentFile(new File(["局域网附件"], "附件.txt", { type: "text/plain" }))
    const { blob, ...metadata } = asset
    document.assets = [metadata]
    document.content.content.push({ type: "attachment", attrs: { assetId: asset.id } })
    validateDocument(document)
    const source = { format: "mewoc", formatVersion: 1, document, assetData: {
      [asset.id]: `data:text/plain;base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`
    } }
    const restored = await readPortableFile(new File([JSON.stringify(source)], "局域网.mewoc.json"))
    // 检查版本位/变体位和三个独立身份，不只检查字符串长度；内部资源 ID 仍用于导入后字节寻址。
    const ids = [document.id, asset.id, restored.document.id]
    ids.forEach(id => assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
    assert.equal(new Set(ids).size, 3)
    assert.equal(await restored.assets.get(asset.id).blob.text(), "局域网附件")
  } finally {
    Object.defineProperty(globalThis, "crypto", original)
  }
})
