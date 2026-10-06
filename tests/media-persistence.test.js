/**
 * 音视频与现有资源共用保存、历史、模板和便携文件契约。
 * 此处验证容器头与原始字节，原生解码及播放由浏览器验收承担，不用头部 fixture 伪装可播放样例。
 */
import test from "node:test"
import assert from "node:assert/strict"
import "fake-indexeddb/auto"
import { IDBObjectStore } from "fake-indexeddb"
import { createDocument, validateDocument, getReferencedAssetIds, checkAssetCapacity } from "../src/pages/editor/tools/document-schema.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { validateMediaMetadata, validateMediaBlob } from "../src/pages/editor/tools/media-assets.js"
import { createDocumentAssetUrl } from "../src/pages/editor/tools/attachment-assets.js"
import { getDatabase, getLocalDocument, getDocumentAssets, saveLocalDocument, duplicateLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentVersion, getDocumentVersion, restoreDocumentVersion, duplicateDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"
import { createDocumentTemplate, getDocumentTemplate, instantiateDocumentTemplate, deleteDocumentTemplate } from "../src/pages/editor/tools/document-template-repository.js"

globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(bytes => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`
      this.onload()
    })
  }
}

// RIFF PCM 有明确数据块；其余 fixture 仅建立受支持容器的头部，不测试编解码器或时长。
function wavBytes() {
  const bytes = new Uint8Array(48)
  const view = new DataView(bytes.buffer)
  const text = (offset, value) => bytes.set(new TextEncoder().encode(value), offset)
  text(0, "RIFF")
  view.setUint32(4, 40, true)
  text(8, "WAVE")
  text(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true)
  view.setUint32(28, 16000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, 4, true)
  bytes.set([0, 255, 128, 1], 44)
  return bytes
}

function mp3Bytes() {
  const bytes = new Uint8Array(417)
  bytes.set([0xff, 0xfb, 0x90, 0x64])
  bytes.set([0, 255, 128, 1], 16)
  return bytes
}

function mp4Bytes() {
  const bytes = new Uint8Array(32)
  new DataView(bytes.buffer).setUint32(0, 24)
  bytes.set(new TextEncoder().encode("ftypisom"), 4)
  bytes.set(new TextEncoder().encode("isommp42"), 16)
  new DataView(bytes.buffer).setUint32(24, 8)
  bytes.set(new TextEncoder().encode("moov"), 28)
  return bytes
}

function webmBytes() {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x18, 0x53, 0x80, 0x67, 0x80])
}

function createMediaRecord(types = ["audio/wav", "video/mp4"]) {
  const document = createDocument()
  const assets = new Map()
  const containers = { "audio/wav": wavBytes, "audio/mpeg": mp3Bytes, "video/mp4": mp4Bytes, "video/webm": webmBytes }
  types.forEach((mimeType, index) => {
    const kind = mimeType.startsWith("audio/") ? "audio" : "video"
    const blob = new Blob([containers[mimeType]()], { type: mimeType })
    const metadata = { id: `media-${index}`, kind, fileName: `${kind}-${index}.${mimeType.split("/")[1]}`, mimeType, byteLength: blob.size }
    document.assets.push(metadata)
    assets.set(metadata.id, { ...metadata, blob })
  })
  document.content.content = document.assets.map(asset => ({ type: "media", attrs: { assetId: asset.id } }))
  return { document, assets }
}

async function assertAssetBytes(expected, actual) {
  assert.equal(actual.size, expected.size)
  for (const [id, asset] of expected) {
    assert.equal(actual.get(id).kind, asset.kind)
    assert.equal(actual.get(id).blob.type, asset.blob.type)
    assert.deepEqual(await actual.get(id).blob.arrayBuffer(), await asset.blob.arrayBuffer())
  }
}

const portableFile = source => new File([JSON.stringify(source)], "media.mewoc.json")
const blankDocument = document => ({ ...document, content: createDocument().content, assets: [] })

async function storedAssetKeys() {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("assets", "readonly")
    const request = transaction.objectStore("assets").getAllKeys()
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = transaction.onerror = () => reject(transaction.error)
  })
}

test("媒体 metadata 与节点允许四种容器，旧无 kind 图片文件继续可读", async () => {
  const source = createMediaRecord(["audio/mpeg", "audio/wav", "video/mp4", "video/webm"])
  assert.equal(validateDocument(source.document), source.document)
  for (const asset of source.assets.values()) {
    assert.doesNotThrow(() => validateMediaMetadata(asset))
    await validateMediaBlob(asset.blob, { kind: asset.kind })
  }
  const blob = new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=", "base64")], { type: "image/png" })
  source.document.assets.push({ id: "legacy-image", fileName: "旧图.png", mimeType: blob.type, byteLength: blob.size })
  source.document.content.content.push({ type: "image", attrs: { assetId: "legacy-image" } })
  assert.equal(validateDocument(source.document), source.document)
})

test("媒体引用严格区分图片附件，媒体 metadata 不能伪装另一种 MIME", () => {
  const source = createMediaRecord()
  for (const type of ["image", "attachment"]) {
    const wrong = structuredClone(source.document)
    wrong.content.content[0].type = type
    assert.throws(() => validateDocument(wrong), /种类不匹配/)
  }
  for (const [kind, mimeType] of [["image", "image/png"], ["attachment", "application/octet-stream"]]) {
    const wrong = structuredClone(source.document)
    wrong.assets[0] = { ...wrong.assets[0], kind, mimeType }
    assert.throws(() => validateDocument(wrong), /种类不匹配/)
  }
  const wrongMime = structuredClone(source.document)
  wrongMime.assets[0].mimeType = "video/mp4"
  assert.throws(() => validateDocument(wrongMime), /类型|种类/)
  const missing = structuredClone(source.document)
  missing.assets = []
  assert.throws(() => validateDocument(missing), /资源缺失/)
})

test("媒体资源拒绝零字节越限非法名称，节点不接受 URL 或播放器状态属性", () => {
  const source = createMediaRecord()
  const asset = source.document.assets[0]
  for (const byteLength of [0, -1, 0.5, 5 * 1024 * 1024 + 1]) {
    assert.throws(() => validateMediaMetadata({ ...asset, byteLength }), /5 MiB|大小|字节/)
  }
  for (const fileName of ["", "../a.wav", "a\\b.wav", "a\nb.wav", "a".repeat(256)]) {
    assert.throws(() => validateMediaMetadata({ ...asset, fileName }), /文件名|名称/)
  }
  for (const kind of [null, "", "movie"]) {
    const wrong = structuredClone(source.document)
    wrong.assets[0].kind = kind
    assert.throws(() => validateDocument(wrong), /资源种类无效/)
  }
  for (const field of ["src", "autoplay", "currentTime", "volume"]) {
    const wrong = structuredClone(source.document)
    wrong.content.content[0].attrs[field] = "https://example.com/media"
    assert.throws(() => validateDocument(wrong), /未知属性/)
  }
})

test("媒体图片附件引用合并去重，共用原 20 MiB 总预算", () => {
  const source = createMediaRecord()
  source.document.assets = Array.from({ length: 4 }, (_, index) => ({ ...source.document.assets[index % 2], id: `budget-${index}`, byteLength: 5 * 1024 * 1024 }))
  source.document.content.content = source.document.assets.map(asset => ({ type: "media", attrs: { assetId: asset.id } }))
  source.document.content.content.push(source.document.content.content[0])
  const assets = new Map(source.document.assets.map(asset => [asset.id, asset]))
  assert.equal(getReferencedAssetIds(source.document.content).length, 4)
  assert.doesNotThrow(() => validateDocument(source.document))
  assert.doesNotThrow(() => checkAssetCapacity(source.document.content, assets))
  assert.throws(() => checkAssetCapacity(source.document.content, assets, 1), /20 MiB/)
  const extra = { id: "budget-extra", kind: "attachment", fileName: "附件.bin", mimeType: "application/octet-stream", byteLength: 1 }
  source.document.assets.push(extra)
  assert.throws(() => validateDocument(source.document), /20 MiB/)
  source.document.assets.pop()
  source.document.content.content.push({ type: "attachment", attrs: { assetId: extra.id } })
  assets.set(extra.id, extra)
  assert.throws(() => checkAssetCapacity(source.document.content, assets), /20 MiB/)
})

test("Mewoc 混合音视频便携文件原样保留字节 MIME 及稳定内部 ID，只导出当前引用", async () => {
  const source = createMediaRecord(["audio/mpeg", "audio/wav", "video/mp4", "video/webm"])
  source.document.content.content.push(source.document.content.content[0])
  const unused = { ...source.document.assets[0], id: "unused-media" }
  source.document.assets.push(unused)
  source.assets.set(unused.id, { ...source.assets.get("media-0"), ...unused })
  const portable = await createPortableFile(source.document, source.assets)
  assert.equal(portable.document.assets.length, 4)
  assert.equal(source.document.assets.length, 5)
  assert.equal(Object.hasOwn(portable.assetData, unused.id), false)
  const restored = await readPortableFile(portableFile(portable))
  assert.notEqual(restored.document.id, source.document.id)
  assert.deepEqual(restored.document.content, source.document.content)
  assert.deepEqual(restored.document.assets, source.document.assets.slice(0, 4))
  await assertAssetBytes(new Map([...source.assets].filter(([id]) => id !== unused.id)), restored.assets)
})

test("媒体便携导入校验编码、实际长度、MIME 与容器头，失败不产生部分资源", async () => {
  const source = createMediaRecord()
  const portable = await createPortableFile(source.document, source.assets)
  const asset = source.document.assets[0]
  const prefix = `data:${asset.mimeType};base64,`
  for (const data of [undefined, "data:video/mp4;base64,AAAA", prefix + "====", prefix + "AA==", prefix + "A".repeat(Math.ceil(asset.byteLength / 3) * 4), prefix + Buffer.alloc(asset.byteLength).toString("base64")]) {
    const wrong = structuredClone(portable)
    wrong.assetData[asset.id] = data
    await assert.rejects(() => readPortableFile(portableFile(wrong)), /缺失|类型|编码|大小|容器|内容|格式/)
  }
  const mismatch = structuredClone(portable)
  mismatch.document.assets[0].mimeType = "audio/mpeg"
  mismatch.assetData[asset.id] = "data:audio/mpeg;base64," + Buffer.from(await source.assets.get(asset.id).blob.arrayBuffer()).toString("base64")
  await assert.rejects(() => readPortableFile(portableFile(mismatch)), /类型|内容|容器|格式/)
})

test("媒体便携导出拒绝丢失资源、伪造 MIME 及头部，32 MiB 文件限制不放宽", async () => {
  const source = createMediaRecord()
  await assert.rejects(() => createPortableFile(source.document, new Map()), /资源缺失/)
  const asset = source.assets.get("media-0")
  for (const blob of [new Blob([wavBytes()], { type: "video/mp4" }), new Blob([new Uint8Array(asset.byteLength)], { type: asset.mimeType })]) {
    const wrong = new Map(source.assets)
    wrong.set(asset.id, { ...asset, blob })
    await assert.rejects(() => createPortableFile(source.document, wrong), /不匹配|内容|格式|容器/)
  }
  let read = false
  await assert.rejects(() => readPortableFile({ size: 32 * 1024 * 1024 + 1, text: async () => { read = true; return "{}" } }), /32 MiB/)
  assert.equal(read, false)
})

test("正文与媒体各自合法但最终 UTF-8 备份超过 32 MiB 时拒绝导出，避免生成不可回读文件", async () => {
  const source = createMediaRecord(["audio/wav", "audio/wav", "audio/wav", "audio/wav"])
  const bytes = new Uint8Array(5 * 1024 * 1024)
  bytes.set(wavBytes())
  const view = new DataView(bytes.buffer)
  view.setUint32(4, bytes.byteLength - 8, true)
  view.setUint32(40, bytes.byteLength - 44, true)
  const blob = new Blob([bytes], { type: "audio/wav" })
  await validateMediaBlob(blob, { kind: "audio" })
  source.document.assets.forEach(asset => {
    asset.byteLength = blob.size
    source.assets.set(asset.id, { ...asset, blob })
  })
  // 文字按 schema 的 UTF-16 预算合法，输出按实际 UTF-8 字节计算；不能只检查 JS string.length。
  source.document.content.content.unshift({ type: "paragraph", content: [{ type: "text", text: "中".repeat(1999000) }] })
  assert.doesNotThrow(() => validateDocument(source.document))
  assert.doesNotThrow(() => checkAssetCapacity(source.document.content, source.assets))
  await assert.rejects(() => createPortableFile(source.document, source.assets), /32 MiB.*缩小正文|32 MiB.*减少资源/)
  assert.equal(source.assets.size, 4)
  assert.equal(source.document.assets.length, 4)
  assert.equal(source.document.content.content[0].content[0].text.length, 1999000)
})

test("媒体会话 URL 保留真实播放 MIME，附件仍使用二进制下载 MIME", async () => {
  const source = createMediaRecord()
  for (const asset of source.assets.values()) {
    const url = createDocumentAssetUrl(asset)
    try {
      const response = await fetch(url)
      assert.equal(response.headers.get("content-type"), asset.mimeType)
      assert.deepEqual(await response.arrayBuffer(), await asset.blob.arrayBuffer())
    } finally { URL.revokeObjectURL(url) }
  }
  const attachment = { kind: "attachment", blob: new Blob(["<script>0</script>"], { type: "text/html" }) }
  const url = createDocumentAssetUrl(attachment)
  try { assert.equal((await fetch(url)).headers.get("content-type"), "application/octet-stream") }
  finally { URL.revokeObjectURL(url) }
})

test("媒体资源原子保存读取，正文删除回收持久资源后当前会话撤销可写回", async () => {
  const source = createMediaRecord()
  await saveLocalDocument(source.document, source.assets, 0)
  assert.deepEqual((await getLocalDocument(source.document.id)).document.content, source.document.content)
  await assertAssetBytes(source.assets, await getDocumentAssets(source.document))
  await saveLocalDocument(blankDocument(source.document), source.assets, 1)
  await assert.rejects(() => getDocumentAssets(source.document), /资源缺失/)
  assert.equal(source.assets.size, 2)
  await saveLocalDocument(source.document, source.assets, 2)
  await assertAssetBytes(source.assets, await getDocumentAssets(source.document))
})

test("媒体保存缺资源或类型不匹配不会留下文档，冲突和配额失败回滚旧资源删除", async () => {
  const source = createMediaRecord()
  await assert.rejects(() => saveLocalDocument(source.document, new Map(), 0), /尚未就绪/)
  const wrong = new Map(source.assets)
  wrong.set("media-0", { ...wrong.get("media-0"), blob: new Blob([wavBytes()], { type: "text/html" }) })
  await assert.rejects(() => saveLocalDocument(source.document, wrong, 0), /类型不匹配/)
  assert.equal(await getLocalDocument(source.document.id), null)
  await saveLocalDocument(source.document, source.assets, 0)
  const blank = blankDocument(source.document)
  await assert.rejects(() => saveLocalDocument(blank, new Map(), 0), error => error.code === "DOCUMENT_CONFLICT")
  const originalPut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.name === "documents" && value.id === source.document.id) throw new DOMException("full", "QuotaExceededError")
    return originalPut.call(this, value, ...args)
  }
  try { await assert.rejects(() => saveLocalDocument(blank, new Map(), 1), /存储空间不足/) }
  finally { IDBObjectStore.prototype.put = originalPut }
  assert.equal((await getLocalDocument(source.document.id)).storageVersion, 1)
  await assertAssetBytes(source.assets, await getDocumentAssets(source.document))
  await saveLocalDocument(blank, new Map(), 1)
  await assert.rejects(() => getDocumentAssets(source.document), /资源缺失/)
})

test("复制媒体文档建立独立资源键，删除来源引用不影响副本字节", async () => {
  const source = createMediaRecord()
  await saveLocalDocument(source.document, source.assets, 0)
  const duplicate = await duplicateLocalDocument(source.document.id, 1)
  assert.notEqual(duplicate.id, source.document.id)
  assert.deepEqual(duplicate.document.content, source.document.content)
  await saveLocalDocument(blankDocument(source.document), new Map(), 1)
  await assertAssetBytes(source.assets, await getDocumentAssets(duplicate.document))
  const keys = await storedAssetKeys()
  assert.equal(keys.some(key => key === `${source.document.id}:media-0`), false)
  assert.equal(keys.includes(`${duplicate.id}:media-0`), true)
})

test("媒体历史独立保存资源，恢复前保留备份，历史另存副本不依赖 live 字节", async () => {
  const source = createMediaRecord()
  await saveLocalDocument(source.document, source.assets, 0)
  const version = await createDocumentVersion(source.document.id, 1, "含音视频")
  await saveLocalDocument(blankDocument(source.document), new Map(), 1)
  const history = await getDocumentVersion(source.document.id, version.id)
  await assertAssetBytes(source.assets, history.assets)
  const duplicate = await duplicateDocumentVersion(source.document.id, version.id, 2)
  await assertAssetBytes(source.assets, await getDocumentAssets(duplicate.document))
  const restored = await restoreDocumentVersion(source.document.id, version.id, 2)
  assert.equal(restored.storageVersion, 3)
  assert.deepEqual(restored.document.content, source.document.content)
  await assertAssetBytes(source.assets, restored.assets)
  await assertAssetBytes(source.assets, await getDocumentAssets(restored.document))
  const keys = await storedAssetKeys()
  assert.equal(keys.filter(key => key.startsWith(`${source.document.id}:history:`)).length, 2)
})

test("媒体模板和实例独立保存原字节，来源与模板清理不影响后续实例", async () => {
  const source = createMediaRecord()
  await saveLocalDocument(source.document, source.assets, 0)
  const template = await createDocumentTemplate(source.document.id, 1, "媒体模板")
  await saveLocalDocument(blankDocument(source.document), new Map(), 1)
  const preview = await getDocumentTemplate(template.id)
  await assertAssetBytes(source.assets, preview.assets)
  const instance = await instantiateDocumentTemplate(template.id, 1)
  assert.notEqual(instance.id, source.document.id)
  await assertAssetBytes(source.assets, await getDocumentAssets(instance.document))
  await deleteDocumentTemplate(template.id, 1)
  await assertAssetBytes(source.assets, await getDocumentAssets(instance.document))
  const keys = await storedAssetKeys()
  assert.equal(keys.some(key => key.startsWith(`template-asset:${template.id}:`)), false)
})

test("媒体模板与历史资源写入故障不会留下部分快照或改变来源", async () => {
  const source = createMediaRecord()
  await saveLocalDocument(source.document, source.assets, 0)
  const before = await storedAssetKeys()
  const originalAdd = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (value, ...args) {
    if (this.name === "assets" && (value.id.startsWith("template-asset:") || value.id.includes(":history-asset:"))) {
      throw new DOMException("full", "QuotaExceededError")
    }
    return originalAdd.call(this, value, ...args)
  }
  try {
    await assert.rejects(() => createDocumentTemplate(source.document.id, 1, "失败模板"), /存储空间不足/)
    await assert.rejects(() => createDocumentVersion(source.document.id, 1, "失败历史"), /存储空间不足/)
  } finally { IDBObjectStore.prototype.add = originalAdd }
  assert.deepEqual(await storedAssetKeys(), before)
  assert.equal((await getLocalDocument(source.document.id)).storageVersion, 1)
  await assertAssetBytes(source.assets, await getDocumentAssets(source.document))
})
