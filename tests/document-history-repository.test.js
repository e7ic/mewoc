/**
 * 验证本地历史版本的独立快照、资源隔离、恢复前备份和跨标签页乐观锁。
 * 通过底层故障注入及提交后读取，证明失败同时回滚元信息、Blob、当前正文和存储版本。
 */
import test from "node:test"
import assert from "node:assert/strict"
import "fake-indexeddb/auto"
import { IDBObjectStore } from "fake-indexeddb"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { getDatabase, getLocalDocument, getDocumentAssets, saveLocalDocument, trashLocalDocument, restoreLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { getDocumentVersions, getDocumentVersion, createDocumentVersion, restoreDocumentVersion, duplicateDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"

// 测试专用底层事务入口，用于检查键空间和注入损坏记录；只在事务完成后读取结果，匹配仓库提交语义。
async function accessStore(name, mode, callback) {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(name, mode)
    const request = callback(transaction.objectStore(name))
    transaction.oncomplete = () => resolve(request?.result)
    transaction.onabort = transaction.onerror = () => reject(transaction.error)
  })
}

// 图片/附件使用可区分的字节与固定资源 ID，版本变化仍复用 ID，检出历史资源被 live 更新覆盖。
// 这里验证存储隔离，不做图像解码，因此图片 Blob 使用可直接比对的文本字节。
function makeDocument(title = "历史验收", imageText = "original-image", attachmentText = "original-attachment") {
  const document = createDocument()
  document.title = title
  document.createdAt = document.updatedAt = "2020-01-01T00:00:00.000Z"
  const assets = new Map()
  for (const [id, kind, text, mimeType, fileName] of [
    ["history-image", "image", imageText, "image/png", "图片.png"],
    ["history-attachment", "attachment", attachmentText, "application/octet-stream", "附件.bin"]
  ]) {
    const blob = new Blob([text], { type: mimeType })
    const metadata = { id, kind, mimeType, byteLength: blob.size, fileName }
    document.assets.push(metadata)
    assets.set(id, { ...metadata, blob })
  }
  document.content.content = [
    { type: "paragraph", content: [{ type: "text", text: title }] },
    { type: "image", attrs: { assetId: "history-image", width: 120 } },
    { type: "attachment", attrs: { assetId: "history-attachment" } }
  ]
  validateDocument(document)
  return { document, assets }
}

// 先提交来源文档取得版本 1，历史操作从已落盘快照开始，不绕过其调用方先保存的约束。
async function seed(title, imageText, attachmentText) {
  const record = makeDocument(title, imageText, attachmentText)
  await saveLocalDocument(record.document, record.assets, 0)
  return record
}

// 逐资源比较字节和 MIME，大小相同仍可能内容不同，不能用资源数量或 Blob.size 代替完整性校验。
async function assertAssetBytes(left, right) {
  assert.equal(left.size, right.size)
  for (const [id, asset] of left) {
    assert.deepEqual(await right.get(id).blob.arrayBuffer(), await asset.blob.arrayBuffer())
    assert.equal(right.get(id).blob.type, asset.blob.type)
  }
}

// 只提取当前文档前缀的全部键，失败前后比较可发现隐藏的半份历史行或孤立资源。
async function documentKeys(id) {
  const keys = await accessStore("assets", "readonly", store => store.getAllKeys())
  return keys.filter(key => key.startsWith(id + ":"))
}

test("旧库无历史记录直接返回空列表，手动版本不升级 DB 或修改来源", async () => {
  const { document, assets } = makeDocument("旧库标题")
  await accessStore("documents", "readwrite", store => store.add({ id: document.id, document }))
  for (const [id, asset] of assets) await accessStore("assets", "readwrite", store => store.add({ id: `${document.id}:${id}`, blob: asset.blob }))
  const source = await getLocalDocument(document.id)
  assert.deepEqual(await getDocumentVersions(document.id), [])
  const version = await createDocumentVersion(document.id, 0, "  手动检查点  ")
  assert.equal(version.label, "手动检查点")
  assert.equal(version.reason, "manual")
  assert.equal(version.sourceStorageVersion, 0)
  assert.deepEqual(version.document, document)
  assert.deepEqual(await getLocalDocument(document.id), source)
  assert.equal((await getDatabase()).version, 1)
  assert.deepEqual([...((await getDatabase()).objectStoreNames)], ["assets", "documents"])
  await assertAssetBytes(assets, (await getDocumentVersion(document.id, version.id)).assets)
})

test("版本列表时间倒序、只读取 metadata 前缀且不携带正文或资源 Blob", async () => {
  const { document } = await seed("列表源")
  const first = await createDocumentVersion(document.id, 1, "第一版")
  const second = await createDocumentVersion(document.id, 1)
  // 固定时间，让排序断言不依赖毫秒时钟和随机 ID 的先后。
  await accessStore("assets", "readwrite", store => store.put({ id: `${document.id}:history:${first.id}`, version: { ...first, createdAt: "2020-01-01T00:00:00.000Z" } }))
  await accessStore("assets", "readwrite", store => store.put({ id: `${document.id}:history:${second.id}`, version: { ...second, createdAt: "2021-01-01T00:00:00.000Z" } }))
  const get = IDBObjectStore.prototype.get
  IDBObjectStore.prototype.get = function (key) {
    assert.equal(typeof key === "string" && key.includes(":history-asset:"), false, "列表不应读取历史 Blob")
    return get.call(this, key)
  }
  let versions
  try { versions = await getDocumentVersions(document.id) }
  finally { IDBObjectStore.prototype.get = get }
  assert.deepEqual(versions.map(version => version.id), [second.id, first.id])
  for (const version of versions) {
    assert.deepEqual(Object.keys(version).sort(), ["createdAt", "documentId", "id", "label", "reason", "sourceStorageVersion"].sort())
  }
  assert.equal(versions[0].label, "")
  assert.equal((await getLocalDocument(document.id)).storageVersion, 1)
})

test("保存快照后删除 live 图片/附件仍能读取历史原始字节，普通保存不碰 history 键", async () => {
  const { document, assets } = await seed("删图前")
  const version = await createDocumentVersion(document.id, 1, "完整内容")
  const blank = { ...document, content: createDocument().content, assets: [] }
  await saveLocalDocument(blank, new Map(), 1)
  await assert.rejects(() => getDocumentAssets(document), /资源缺失/)
  const restored = await getDocumentVersion(document.id, version.id)
  assert.deepEqual(restored.version.document, document)
  await assertAssetBytes(assets, restored.assets)
  const keys = await documentKeys(document.id)
  assert.equal(keys.length, 3)
  assert.equal(keys.every(key => key.includes(":history:") || key.includes(":history-asset:")), true)
  assert.equal((await getDocumentVersions(document.id)).length, 1)
})

// 恢复必须既得到旧版又能找回恢复前当前内容，分别读取两套快照检验备份不是错误复制的历史版。
test("恢复前自动保留当前标题正文纸张与新资源，同事务恢复旧版本并推进 live 锁", async () => {
  const original = await seed("原版标题", "old-image", "old-attachment")
  const selected = await createDocumentVersion(original.document.id, 1, "待恢复")
  const current = makeDocument("恢复前标题", "new-image-data", "new-attachment-data")
  current.document.id = original.document.id
  current.document.createdAt = "2019-01-01T00:00:00.000Z"
  current.document.page.orientation = "landscape"
  await saveLocalDocument(current.document, current.assets, 1)
  const restored = await restoreDocumentVersion(original.document.id, selected.id, 2)
  assert.equal(restored.id, original.document.id)
  assert.equal(restored.storageVersion, 3)
  assert.equal(restored.document.createdAt, current.document.createdAt)
  assert.notEqual(restored.document.updatedAt, original.document.updatedAt)
  assert.equal(restored.document.title, original.document.title)
  assert.deepEqual(restored.document.content, original.document.content)
  assert.deepEqual(restored.document.page, original.document.page)
  const { assets: returnedAssets, ...durable } = restored
  assert.deepEqual(await getLocalDocument(original.document.id), durable)
  await assertAssetBytes(original.assets, returnedAssets)
  await assertAssetBytes(original.assets, await getDocumentAssets(restored.document))
  const versions = await getDocumentVersions(original.document.id)
  assert.equal(versions.length, 2)
  const backup = versions.find(version => version.reason === "before-restore")
  assert.equal(backup.label, "恢复前自动保留")
  assert.equal(backup.sourceStorageVersion, 2)
  const before = await getDocumentVersion(original.document.id, backup.id)
  assert.deepEqual(before.version.document, current.document)
  await assertAssetBytes(current.assets, before.assets)
  assert.deepEqual((await getDocumentVersion(original.document.id, selected.id)).version, selected)
  // 父级切换后使用返回的新锁可以继续保存，不会与恢复事务冲突。
  await saveLocalDocument(restored.document, returnedAssets, 3)
  assert.equal((await getLocalDocument(original.document.id)).storageVersion, 4)
})

test("历史复制使用旧快照且保留后缀，来源/历史不变，live 资源隔离", async () => {
  const original = await seed("长".repeat(100), "history-image", "history-attachment")
  const version = await createDocumentVersion(original.document.id, 1)
  const current = { ...original.document, title: "当前已修改", content: createDocument().content, assets: [] }
  await saveLocalDocument(current, new Map(), 1)
  const source = await getLocalDocument(original.document.id)
  const copy = await duplicateDocumentVersion(original.document.id, version.id, 2)
  assert.notEqual(copy.id, source.id)
  assert.equal(copy.document.id, copy.id)
  assert.equal(copy.storageVersion, 1)
  assert.equal(copy.document.title.length, 100)
  assert.equal(copy.document.title.endsWith(" - 历史副本"), true)
  assert.equal(copy.document.createdAt, copy.document.updatedAt)
  assert.deepEqual(copy.document.content, version.document.content)
  assert.deepEqual(await getLocalDocument(original.document.id), source)
  await assertAssetBytes(original.assets, copy.assets)
  await assertAssetBytes(original.assets, await getDocumentAssets(copy.document))
  await saveLocalDocument({ ...copy.document, content: createDocument().content, assets: [] }, new Map(), 1)
  await assert.rejects(() => getDocumentAssets(copy.document), /资源缺失/)
  await assertAssetBytes(original.assets, (await getDocumentVersion(original.document.id, version.id)).assets)
  assert.deepEqual(await getLocalDocument(original.document.id), source)
})

test("空资源历史可创建读取恢复，不产生 Blob 行", async () => {
  const document = createDocument()
  await saveLocalDocument(document, new Map(), 0)
  const version = await createDocumentVersion(document.id, 1, "无资源")
  assert.equal((await getDocumentVersion(document.id, version.id)).assets.size, 0)
  const restored = await restoreDocumentVersion(document.id, version.id, 1)
  assert.equal(restored.assets.size, 0)
  assert.equal(restored.storageVersion, 2)
  assert.equal((await documentKeys(document.id)).length, 2)
})

test("旧基础版本和缺省基础版本不能创建、恢复或复制，来源与历史均不变", async () => {
  const { document, assets } = await seed("锁保护")
  const version = await createDocumentVersion(document.id, 1)
  await saveLocalDocument({ ...document, title: "另一会话写入" }, assets, 1)
  const before = await getLocalDocument(document.id)
  const keys = await documentKeys(document.id)
  for (const baseVersion of [1, undefined, NaN, -1, 1.5]) {
    for (const operation of [
      () => createDocumentVersion(document.id, baseVersion),
      () => restoreDocumentVersion(document.id, version.id, baseVersion),
      () => duplicateDocumentVersion(document.id, version.id, baseVersion)
    ]) await assert.rejects(operation, error => error.code === "DOCUMENT_CONFLICT")
  }
  assert.deepEqual(await getLocalDocument(document.id), before)
  assert.deepEqual(await documentKeys(document.id), keys)
})

test("回收后所有历史入口明确拒绝，不复活文档；恢复文档库后历史仍在", async () => {
  const { document } = await seed("回收历史")
  const version = await createDocumentVersion(document.id, 1)
  const trashed = await trashLocalDocument(document.id, 1)
  for (const operation of [
    () => getDocumentVersions(document.id),
    () => getDocumentVersion(document.id, version.id),
    () => createDocumentVersion(document.id, 2),
    () => restoreDocumentVersion(document.id, version.id, 2),
    () => duplicateDocumentVersion(document.id, version.id, 2)
  ]) await assert.rejects(operation, error => error.code === "DOCUMENT_TRASHED")
  await assert.rejects(() => restoreDocumentVersion(document.id, version.id, 1), error => error.code === "DOCUMENT_CONFLICT")
  assert.deepEqual(await getLocalDocument(document.id, { includeDeleted: true }), trashed)
  await restoreLocalDocument(document.id, 2)
  assert.deepEqual((await getDocumentVersion(document.id, version.id)).version, version)
})

test("名称/缺失版本/跨文档版本检查失败不产生半份快照", async () => {
  const { document } = await seed("输入范围")
  await assert.rejects(() => createDocumentVersion(document.id, 1, "长".repeat(101)), error => error.code === "DOCUMENT_VERSION_LABEL_INVALID")
  await assert.rejects(() => createDocumentVersion(document.id, 1, null), error => error.code === "DOCUMENT_VERSION_LABEL_INVALID")
  assert.deepEqual(await getDocumentVersions(document.id), [])
  const version = await createDocumentVersion(document.id, 1, " ")
  assert.equal(version.label, "")
  const other = await seed("另一个文档")
  for (const operation of [
    () => getDocumentVersion(document.id, "missing-version"),
    () => restoreDocumentVersion(other.document.id, version.id, 1),
    () => duplicateDocumentVersion(other.document.id, version.id, 1)
  ]) await assert.rejects(operation, error => error.code === "DOCUMENT_VERSION_NOT_FOUND")
  await assert.rejects(() => getDocumentVersions("missing-document"), error => error.code === "DOCUMENT_NOT_FOUND")
  assert.deepEqual(await getDocumentVersions(other.document.id), [])
})

test("缺失 live 资源时创建或恢复整体回滚，不生成历史备份", async () => {
  const { document } = await seed("缺当前资源")
  const version = await createDocumentVersion(document.id, 1)
  await accessStore("assets", "readwrite", store => store.delete(`${document.id}:history-attachment`))
  const before = await getLocalDocument(document.id)
  const keys = await documentKeys(document.id)
  await assert.rejects(() => createDocumentVersion(document.id, 1), error => error.code === "DOCUMENT_ASSET_MISSING")
  await assert.rejects(() => restoreDocumentVersion(document.id, version.id, 1), error => error.code === "DOCUMENT_ASSET_MISSING")
  assert.deepEqual(await getLocalDocument(document.id), before)
  assert.deepEqual(await documentKeys(document.id), keys)
  assert.equal((await getDocumentVersions(document.id)).length, 1)
})

test("缺失历史资源时读取/恢复/复制失败，live 正文资源与版本不动", async () => {
  const { document, assets } = await seed("缺历史资源")
  const version = await createDocumentVersion(document.id, 1)
  await accessStore("assets", "readwrite", store => store.delete(`${document.id}:history-asset:${version.id}:history-attachment`))
  const before = await getLocalDocument(document.id)
  const keys = await documentKeys(document.id)
  for (const operation of [
    () => getDocumentVersion(document.id, version.id),
    () => restoreDocumentVersion(document.id, version.id, 1),
    () => duplicateDocumentVersion(document.id, version.id, 1)
  ]) await assert.rejects(operation, error => error.code === "DOCUMENT_ASSET_MISSING")
  assert.deepEqual(await getLocalDocument(document.id), before)
  assert.deepEqual(await documentKeys(document.id), keys)
  await assertAssetBytes(assets, await getDocumentAssets(document))
})

test("历史 snapshot 经 schema 校验，损坏正文或资源类型不会恢复到 live", async () => {
  const { document } = await seed("损坏历史")
  const version = await createDocumentVersion(document.id, 1)
  const corrupt = structuredClone(version)
  corrupt.document.content.content = [{ type: "unknown-history-node" }]
  await accessStore("assets", "readwrite", store => store.put({ id: `${document.id}:history:${version.id}`, version: corrupt }))
  const before = await getLocalDocument(document.id)
  for (const operation of [
    () => getDocumentVersion(document.id, version.id),
    () => restoreDocumentVersion(document.id, version.id, 1),
    () => duplicateDocumentVersion(document.id, version.id, 1)
  ]) await assert.rejects(operation, error => error.code === "DOCUMENT_VERSION_INVALID")
  assert.deepEqual(await getLocalDocument(document.id), before)
  await accessStore("assets", "readwrite", store => store.put({ id: `${document.id}:history:${version.id}`, version }))
  await accessStore("assets", "readwrite", store => store.put({ id: `${document.id}:history-asset:${version.id}:history-image`, blob: new Blob(["original-image"], { type: "text/html" }) }))
  await assert.rejects(() => getDocumentVersion(document.id, version.id), error => error.code === "DOCUMENT_ASSET_MISSING")
  assert.deepEqual(await getLocalDocument(document.id), before)
})

test("手动快照资源写入配额异常回滚 metadata 和已排队 Blob", async () => {
  const { document } = await seed("快照配额")
  const before = await getLocalDocument(document.id)
  const keys = await documentKeys(document.id)
  const add = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (value, ...args) {
    if (this.name === "assets" && value.id.startsWith(`${document.id}:history-asset:`) && value.id.endsWith(":history-attachment")) {
      throw new DOMException("full", "QuotaExceededError")
    }
    return add.call(this, value, ...args)
  }
  try { await assert.rejects(() => createDocumentVersion(document.id, 1), error => error.code === "DOCUMENT_STORAGE_QUOTA") }
  finally { IDBObjectStore.prototype.add = add }
  assert.deepEqual(await documentKeys(document.id), keys)
  assert.deepEqual(await getLocalDocument(document.id), before)
  assert.deepEqual(await getDocumentVersions(document.id), [])
})

// 在事务最后的正文写入处抛错，确保已经排队的自动备份及资源替换也回滚，不能只保护前置校验。
test("恢复的最终文档写入异常回滚前备份、live 资源替换及存储版本", async () => {
  const original = await seed("恢复配额原版", "old-image", "old-file")
  const version = await createDocumentVersion(original.document.id, 1)
  const changed = makeDocument("恢复配额当前版", "current-image-longer", "current-file-longer")
  changed.document.id = original.document.id
  await saveLocalDocument(changed.document, changed.assets, 1)
  const before = await getLocalDocument(original.document.id)
  const keys = await documentKeys(original.document.id)
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.name === "documents" && value.id === original.document.id) throw new DOMException("full", "QuotaExceededError")
    return put.call(this, value, ...args)
  }
  try { await assert.rejects(() => restoreDocumentVersion(original.document.id, version.id, 2), error => error.code === "DOCUMENT_STORAGE_QUOTA") }
  finally { IDBObjectStore.prototype.put = put }
  assert.deepEqual(await getLocalDocument(original.document.id), before)
  assert.deepEqual(await documentKeys(original.document.id), keys)
  await assertAssetBytes(changed.assets, await getDocumentAssets(changed.document))
  assert.equal((await getDocumentVersions(original.document.id)).length, 1)
})

test("历史复制新记录异步写入失败回滚所有新资源，来源与快照不变", async () => {
  const { document, assets } = await seed("复制失败来源")
  const version = await createDocumentVersion(document.id, 1)
  const keysBefore = await accessStore("assets", "readonly", store => store.getAllKeys())
  const documentsBefore = await accessStore("documents", "readonly", store => store.getAllKeys())
  const add = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (value, ...args) {
    // 强制来源主键碰撞，使 IDB 请求异步失败；副本资源已经排队，必须一起回滚。
    if (this.name === "documents" && value.id !== document.id) return add.call(this, { ...value, id: document.id }, ...args)
    return add.call(this, value, ...args)
  }
  try { await assert.rejects(() => duplicateDocumentVersion(document.id, version.id, 1), error => error.code === "DOCUMENT_HISTORY_FAILED") }
  finally { IDBObjectStore.prototype.add = add }
  assert.deepEqual(await accessStore("assets", "readonly", store => store.getAllKeys()), keysBefore)
  assert.deepEqual(await accessStore("documents", "readonly", store => store.getAllKeys()), documentsBefore)
  await assertAssetBytes(assets, (await getDocumentVersion(document.id, version.id)).assets)
  assert.equal((await getLocalDocument(document.id)).storageVersion, 1)
})

// 两个真实竞争事务使用同一乐观锁，既核对唯一赢家又核对备份数，防止失败者留下副作用。
test("并发恢复同基础版本只有一笔提交，失败者不增加自动备份", async () => {
  const { document } = await seed("并发恢复")
  const version = await createDocumentVersion(document.id, 1)
  const results = await Promise.allSettled([
    restoreDocumentVersion(document.id, version.id, 1),
    restoreDocumentVersion(document.id, version.id, 1)
  ])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  assert.equal(results.find(result => result.status === "rejected").reason.code, "DOCUMENT_CONFLICT")
  assert.equal((await getLocalDocument(document.id)).storageVersion, 2)
  assert.equal((await getDocumentVersions(document.id)).filter(item => item.reason === "before-restore").length, 1)
})
