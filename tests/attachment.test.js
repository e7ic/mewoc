import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor, generateHTML } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { createDocument, validateDocument, getReferencedAssetIds, checkAssetCapacity } from "../src/pages/editor/tools/document-schema.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { readAttachmentFile, createDocumentAssetUrl, getAttachmentFileName } from "../src/pages/editor/tools/attachment-assets.js"
import { insertAttachmentNode, removeAttachment } from "../src/pages/editor/tools/attachment-commands.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(bytes => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`
      this.onload()
    })
  }
}

async function createAttachment(file = new File([new Uint8Array([0, 255, 13, 10, 128, 1])], "原始附件.bin")) {
  const asset = await readAttachmentFile(file)
  const record = createDocument()
  const { blob, ...metadata } = asset
  record.assets = [metadata]
  record.content.content = [{ type: "attachment", attrs: { assetId: asset.id } }]
  return { record, asset: { ...metadata, blob }, assets: new Map([[asset.id, asset]]) }
}

test("附件按不透明字节读取，缺少 MIME 时补二进制类型，空文件可以保存", async () => {
  const asset = await readAttachmentFile(new File([], "空文件.txt"))
  assert.equal(asset.kind, "attachment")
  assert.equal(asset.mimeType, "application/octet-stream")
  assert.equal(asset.byteLength, 0)
  const { record, assets } = await createAttachment(new File([], "空文件.txt"))
  const source = await createPortableFile(record, assets)
  const restored = await readPortableFile(new File([JSON.stringify(source)], "empty.mewoc.json"))
  assert.equal(restored.assets.get(record.assets[0].id).blob.size, 0)
  assert.equal(restored.document.assets[0].kind, "attachment")
})

test("附件校验拒绝超限文件、路径、控制字符及非法 MIME，读取失败不伪装成功", async () => {
  await assert.rejects(() => readAttachmentFile(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "大附件.bin")), /5 MiB/)
  for (const name of ["", "../文件.txt", "目录\\文件.txt", "控制\n字符.txt", "a".repeat(256)]) {
    await assert.rejects(() => readAttachmentFile(new File(["a"], name)), /文件名/)
  }
  await assert.rejects(() => readAttachmentFile(new File(["a"], "类型.txt", { type: "text/html;script" })), /类型/)
  const file = new File(["a"], "失效.txt")
  file.arrayBuffer = async () => { throw new Error("unavailable") }
  await assert.rejects(() => readAttachmentFile(file), /读取失败/)
  file.arrayBuffer = async () => new ArrayBuffer(0)
  await assert.rejects(() => readAttachmentFile(file), /大小不一致/)
})

test("旧图片格式仍可读，附件与图片必须引用匹配种类的资源", async () => {
  const { record } = await createAttachment()
  assert.doesNotThrow(() => validateDocument(record))
  const wrongKind = structuredClone(record)
  wrongKind.content.content[0] = { type: "image", attrs: { assetId: record.assets[0].id } }
  assert.throws(() => validateDocument(wrongKind), /种类不匹配/)
  const missing = structuredClone(record)
  missing.assets = []
  assert.throws(() => validateDocument(missing), /资源缺失/)
  for (const kind of [null, "", "video"]) {
    const invalid = structuredClone(record)
    invalid.assets[0].kind = kind
    assert.throws(() => validateDocument(invalid), /资源种类无效/)
  }
  const attrs = structuredClone(record)
  attrs.content.content[0].attrs.href = "https://example.com/file"
  assert.throws(() => validateDocument(attrs), /未知属性/)
  const duplicate = structuredClone(record)
  duplicate.assets.push({ ...duplicate.assets[0] })
  assert.throws(() => validateDocument(duplicate), /重复/)
})

test("混合图片与附件的 Mewoc 往返保留字节、名称、类型与稳定 ID", async () => {
  const { record, assets, asset } = await createAttachment(new File(["<script>原样保留</script>\u0000"], "报告<草稿>.html", { type: "text/html" }))
  const blob = new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=", "base64")], { type: "image/png" })
  const image = { id: "legacy-image", fileName: "旧图片.png", mimeType: "image/png", byteLength: blob.size }
  record.assets.push(image)
  record.content.content.push({ type: "image", attrs: { assetId: image.id } })
  assets.set(image.id, { ...image, blob })
  const source = await createPortableFile(record, assets)
  const restored = await readPortableFile(new File([JSON.stringify(source)], "mixed.mewoc.json"))
  assert.notEqual(restored.document.id, record.id)
  assert.deepEqual(restored.document.content, record.content)
  assert.deepEqual(restored.document.assets, record.assets)
  assert.deepEqual(await restored.assets.get(asset.id).blob.arrayBuffer(), await asset.blob.arrayBuffer())
  assert.deepEqual(await restored.assets.get(image.id).blob.arrayBuffer(), await blob.arrayBuffer())
})

test("缺失内容、伪造类型、长度或 base64 均拒绝导入，缺失 Blob 拒绝导出", async () => {
  const { record, assets, asset } = await createAttachment()
  const source = await createPortableFile(record, assets)
  for (const value of [undefined, "data:text/html;base64,AP8NCoAB", "data:application/octet-stream;base64,====", "data:application/octet-stream;base64,AA=="]) {
    await assert.rejects(() => readPortableFile(new File([JSON.stringify({ ...source, assetData: { [asset.id]: value } })], "broken.json")), /缺失|类型|大小|编码/)
  }
  await assert.rejects(() => createPortableFile(record, new Map()), /资源缺失/)
  assets.set(asset.id, { ...asset, blob: new Blob(["same??"], { type: "text/html" }) })
  await assert.rejects(() => createPortableFile(record, assets), /不匹配/)
})

test("5 MiB 附件可以完整往返，未引用资源不会进入导出文件", async () => {
  const { record, assets, asset } = await createAttachment(new File([new Uint8Array(5 * 1024 * 1024).fill(171)], "边界.bin"))
  const unused = await readAttachmentFile(new File(["unused"], "未引用.txt"))
  const { blob, ...metadata } = unused
  record.assets.push(metadata)
  assets.set(unused.id, { ...metadata, blob })
  const source = await createPortableFile(record, assets)
  assert.equal(source.document.assets.length, 1)
  assert.equal(record.assets.length, 2)
  const restored = await readPortableFile(new File([JSON.stringify(source)], "limit.json"))
  assert.deepEqual(await restored.assets.get(asset.id).blob.arrayBuffer(), await asset.blob.arrayBuffer())
})

test("容量按正文唯一资源引用计算，新增附件与图片共用 20 MiB 预算", async () => {
  const { record, asset } = await createAttachment()
  record.assets = Array.from({ length: 4 }, (_, index) => ({ ...record.assets[0], id: `asset-${index}`, byteLength: 5 * 1024 * 1024 }))
  record.content.content = record.assets.map(item => ({ type: "attachment", attrs: { assetId: item.id } }))
  record.content.content.push(record.content.content[0])
  const assets = new Map(record.assets.map(item => [item.id, item]))
  assets.set(asset.id, asset)
  assert.equal(getReferencedAssetIds(record.content).length, 4)
  assert.doesNotThrow(() => validateDocument(record))
  assert.doesNotThrow(() => checkAssetCapacity(record.content, assets))
  assert.throws(() => checkAssetCapacity(record.content, assets, 1), /20 MiB/)
  record.assets.push({ ...record.assets[0], id: "over-limit", byteLength: 1 })
  assert.throws(() => validateDocument(record), /20 MiB/)
})

test("下载 URL 按二进制返回原字节，文件名进入 DOM 时不会执行 HTML", async () => {
  const { record, asset, assets } = await createAttachment(new File(["<script>test</script>"], '<草稿>".html', { type: "text/html" }))
  const url = createDocumentAssetUrl(asset)
  try {
    const response = await fetch(url)
    assert.equal(response.headers.get("content-type"), "application/octet-stream")
    assert.equal(await response.text(), "<script>test</script>")
    const html = generateHTML(record.content, createExtensions(() => url, id => assets.get(id)))
    const parsed = new DOMParser().parseFromString(html, "text/html")
    assert.equal(parsed.querySelector("[data-attachment-name]").textContent, '<草稿>".html')
    assert.equal(parsed.querySelector("script"), null)
    assert.equal(parsed.querySelector("a").getAttribute("download"), getAttachmentFileName(asset.fileName))
  } finally {
    URL.revokeObjectURL(url)
  }
})

test("附件插入、后续文字和删除各自可撤销，只读与代码块拒绝修改", async () => {
  const { asset, assets } = await createAttachment()
  const editor = new Editor({ element: document.createElement("div"), extensions: createExtensions(() => "", id => assets.get(id)), content: "<p>正文</p>" })
  try {
    editor.commands.setTextSelection(3)
    assert.equal(insertAttachmentNode(editor, editor.state.selection, asset.id), true)
    assert.equal(editor.getText().includes("原始附件.bin"), true)
    editor.commands.insertContent("后续文字")
    editor.commands.undo()
    assert.equal(getReferencedAssetIds(editor.getJSON()).length, 1)
    assert.equal(editor.getText().includes("后续文字"), false)
    let position
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "attachment") position = pos })
    editor.commands.setNodeSelection(position)
    assert.equal(removeAttachment(editor), true)
    assert.equal(getReferencedAssetIds(editor.getJSON()).length, 0)
    editor.commands.undo()
    assert.equal(getReferencedAssetIds(editor.getJSON()).length, 1)
    editor.setEditable(false, false)
    assert.equal(removeAttachment(editor), false)
    assert.equal(insertAttachmentNode(editor, editor.state.selection, asset.id), false)
    editor.setEditable(true, false)
    editor.commands.setContent("<pre><code>const a = 1</code></pre>")
    assert.equal(insertAttachmentNode(editor, TextSelection.create(editor.state.doc, 1), asset.id), false)
  } finally {
    editor.destroy()
  }
})

test("附件内部复制只恢复已有资源，外部引用降为文字且不接受下载链接", async () => {
  const { record, assets, asset } = await createAttachment()
  const html = generateHTML(record.content, createExtensions(() => "https://example.com/ignored", id => assets.get(id)))
  const editor = new Editor({ element: document.createElement("div"), extensions: createExtensions(() => "", id => assets.get(id)) })
  try {
    const cleaned = cleanPastedHtml(html, (id, kind) => assets.get(id)?.kind === kind)
    assert.equal(cleaned.includes("https:"), false)
    editor.commands.setContent(cleaned)
    assert.deepEqual(getReferencedAssetIds(editor.getJSON()), [asset.id])
    editor.commands.setContent(cleanPastedHtml(html))
    assert.equal(getReferencedAssetIds(editor.getJSON()).length, 0)
    assert.equal(editor.getText().includes(asset.fileName), true)
    editor.commands.setContent(`<img data-mewoc-asset-id="${asset.id}" src="https://example.com/image">`)
    assert.equal(getReferencedAssetIds(editor.getJSON()).length, 0)
  } finally {
    editor.destroy()
  }
})

test("Markdown 输出保留附件名称和大小，给出内容转换说明而不生成虚假链接", async () => {
  const { record } = await createAttachment(new File(["x"], "[附件](link).txt", { type: "text/plain" }))
  const before = structuredClone(record)
  const result = await createDocumentMarkdown(record)
  assert.equal(result.source.includes("1 B"), true)
  assert.equal(result.source.includes("Mewoc 文件"), true)
  assert.equal(result.warnings.some(warning => warning.includes("附件")), true)
  assert.equal(result.source.includes("data:"), false)
  assert.deepEqual(record, before)
})
