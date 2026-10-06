/**
 * 验证文档库重命名、复制、回收和恢复与自动保存共用的版本及资源规则。
 * 兼容旧 DB v1 记录，拒绝旧会话复活回收文档，复制失败不能留下新记录或半份 Blob。
 */
import test from "node:test"
import assert from "node:assert/strict"
import "fake-indexeddb/auto"
import { IDBObjectStore } from "fake-indexeddb"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import {
  getDocuments, getLocalDocument, getDocumentAssets, saveLocalDocument,
  renameLocalDocument, duplicateLocalDocument, trashLocalDocument, restoreLocalDocument
} from "../src/pages/editor/tools/local-repository.js"

// 打开独立连接以读写原始旧记录或检查残留键，事务结束后关闭，避免测试连接阻碍后续数据库操作。
async function accessStore(name, mode, callback) {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open("mewoc", 1)
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const database = opening.result
      const transaction = database.transaction(name, mode)
      const request = callback(transaction.objectStore(name))
      transaction.oncomplete = () => {
        database.close()
        resolve(request?.result)
      }
      transaction.onabort = transaction.onerror = () => {
        database.close()
        reject(transaction.error)
      }
    }
  })
}

// 创建带图片和附件的已提交基线，固定旧时间使管理操作更新时间可观察，资源字节用于核对复制完整性。
async function createStoredDocument(title = "库管理验收") {
  const document = createDocument()
  document.title = title
  document.createdAt = document.updatedAt = "2020-01-01T00:00:00.000Z"
  const image = new Blob(["original-image"], { type: "image/png" })
  const attachment = new Blob([new Uint8Array([0, 128, 255, 1])], { type: "application/octet-stream" })
  const assets = new Map()
  for (const [kind, blob, fileName] of [["image", image, "图片.png"], ["attachment", attachment, "附件.bin"]]) {
    const metadata = { id: crypto.randomUUID(), kind, mimeType: blob.type, byteLength: blob.size, fileName }
    document.assets.push(metadata)
    assets.set(metadata.id, { ...metadata, blob })
  }
  document.content.content = [
    { type: "paragraph", content: [{ type: "text", text: "保留原有正文" }] },
    { type: "image", attrs: { assetId: document.assets[0].id, width: 240 } },
    { type: "attachment", attrs: { assetId: document.assets[1].id } }
  ]
  await saveLocalDocument(document, assets, 0)
  return { document, assets }
}

test("旧版 DB v1 无回收字段/版本的文档可读取、重命名，无需迁移", async () => {
  // 先由正常入口建库，再模拟首批数据：deletedAt 和 storageVersion 都可能不存在。
  await getDocuments()
  const document = createDocument()
  document.title = "旧库文档"
  await accessStore("documents", "readwrite", store => store.add({ id: document.id, document }))
  assert.equal((await getDocuments()).some(record => record.id === document.id), true)
  assert.deepEqual((await getLocalDocument(document.id)).document, document)
  assert.equal(await getLocalDocument("missing-document"), null)
  const renamed = await renameLocalDocument(document.id, "  旧库新标题  ", 0)
  assert.equal(renamed.document.title, "旧库新标题")
  assert.equal(renamed.storageVersion, 1)
  assert.equal(renamed.document.createdAt, document.createdAt)
  assert.deepEqual(await getLocalDocument(document.id), renamed)
  const version = await new Promise((resolve, reject) => {
    const request = indexedDB.open("mewoc")
    request.onsuccess = () => {
      resolve(request.result.version)
      request.result.close()
    }
    request.onerror = () => reject(request.error)
  })
  assert.equal(version, 1)
})

test("重命名 trim 标题并拒绝空白/超长标题，失败不更改版本和正文资源", async () => {
  const { document } = await createStoredDocument()
  const before = await getLocalDocument(document.id)
  await assert.rejects(() => renameLocalDocument(document.id, "   ", 1), /1 到 100/)
  await assert.rejects(() => renameLocalDocument(document.id, "文".repeat(101), 1), /1 到 100/)
  assert.deepEqual(await getLocalDocument(document.id), before)
  const result = await renameLocalDocument(document.id, "  已重命名  ", 1)
  assert.equal(result.storageVersion, 2)
  assert.equal(result.document.title, "已重命名")
  assert.equal(result.document.createdAt, document.createdAt)
  assert.notEqual(result.document.updatedAt, document.updatedAt)
  assert.deepEqual(result.document.content, document.content)
  assert.equal((await getDocumentAssets(result.document)).size, 2)
})

test("复制同时保留正文、图片和附件，来源记录不变且资源按文档键隔离", async () => {
  const { document, assets } = await createStoredDocument("来源报告")
  const source = await getLocalDocument(document.id)
  const copy = await duplicateLocalDocument(document.id, 1)
  assert.notEqual(copy.id, source.id)
  assert.equal(copy.document.id, copy.id)
  assert.equal(copy.storageVersion, 1)
  assert.equal(copy.document.title, "来源报告 - 副本")
  assert.deepEqual(copy.document.content, source.document.content)
  assert.deepEqual(copy.document.assets, source.document.assets)
  assert.deepEqual(await getLocalDocument(source.id), source)
  assert.deepEqual(await getLocalDocument(copy.id), copy)
  const copiedAssets = await getDocumentAssets(copy.document)
  for (const asset of document.assets) {
    assert.deepEqual(await copiedAssets.get(asset.id).blob.arrayBuffer(), await assets.get(asset.id).blob.arrayBuffer())
  }
  // 对副本删除资源后保存只清理副本键，不影响来源的图片/附件。
  await saveLocalDocument({ ...copy.document, content: createDocument().content, assets: [] }, new Map(), 1)
  await assert.rejects(() => getDocumentAssets(copy.document), /资源缺失/)
  assert.equal((await getDocumentAssets(source.document)).size, 2)
  assert.deepEqual(await getLocalDocument(source.id), source)
})

test("100 字符原标题复制仍保留副本后缀，新副本时间独立", async () => {
  const { document } = await createStoredDocument("长".repeat(100))
  const copy = await duplicateLocalDocument(document.id, 1)
  assert.equal(copy.document.title.length, 100)
  assert.equal(copy.document.title.endsWith(" - 副本"), true)
  assert.equal(copy.document.createdAt, copy.document.updatedAt)
  assert.notEqual(copy.document.createdAt, document.createdAt)
})

test("回收站按顶层 deletedAt 筛选，恢复不丢失图片附件且持续递增版本", async () => {
  const { document } = await createStoredDocument()
  const trashed = await trashLocalDocument(document.id, 1)
  assert.equal(trashed.storageVersion, 2)
  assert.equal(trashed.deletedAt, trashed.document.updatedAt)
  assert.equal("deletedAt" in trashed.document, false)
  assert.equal(await getLocalDocument(document.id), null)
  assert.deepEqual(await getLocalDocument(document.id, { includeDeleted: true }), trashed)
  assert.equal((await getDocuments()).some(record => record.id === document.id), false)
  assert.deepEqual((await getDocuments({ deleted: true })).find(record => record.id === document.id), trashed)
  const assets = await getDocumentAssets(trashed.document)
  assert.equal(assets.size, 2)
  const restored = await restoreLocalDocument(document.id, 2)
  assert.equal(restored.storageVersion, 3)
  assert.equal("deletedAt" in restored, false)
  assert.deepEqual(restored.document.content, document.content)
  assert.equal((await getDocuments({ deleted: true })).some(record => record.id === document.id), false)
  assert.deepEqual(await getLocalDocument(document.id), restored)
  const restoredAssets = await getDocumentAssets(restored.document)
  for (const asset of document.assets) {
    assert.deepEqual(await restoredAssets.get(asset.id).blob.arrayBuffer(), await assets.get(asset.id).blob.arrayBuffer())
  }
})

test("过期重命名/复制/回收/恢复均冲突，跨标签页不能覆盖管理操作", async () => {
  const { document, assets } = await createStoredDocument()
  const renamed = await renameLocalDocument(document.id, "最新标题", 1)
  for (const operation of [
    () => renameLocalDocument(document.id, "过期标题", 1),
    () => duplicateLocalDocument(document.id, 1),
    () => trashLocalDocument(document.id, 1),
    () => restoreLocalDocument(document.id, 1),
    () => saveLocalDocument(document, assets, 1)
  ]) await assert.rejects(operation, error => error.code === "DOCUMENT_CONFLICT")
  assert.deepEqual(await getLocalDocument(document.id), renamed)
  const trashed = await trashLocalDocument(document.id, 2)
  await assert.rejects(() => restoreLocalDocument(document.id, 2), error => error.code === "DOCUMENT_CONFLICT")
  assert.deepEqual(await getLocalDocument(document.id, { includeDeleted: true }), trashed)
})

// 不仅测试过期版本，还测试拿到最新版本仍拒绝普通保存，证明回收状态具有独立于版本锁的保护。
test("已回收文档拒绝同版本普通保存、重命名和复制，旧会话也不能复活文档", async () => {
  const { document, assets } = await createStoredDocument()
  const trashed = await trashLocalDocument(document.id, 1)
  await assert.rejects(() => saveLocalDocument(document, assets, 1), error => error.code === "DOCUMENT_CONFLICT")
  for (const operation of [
    () => saveLocalDocument(document, assets, 2),
    () => renameLocalDocument(document.id, "尝试复活", 2),
    () => duplicateLocalDocument(document.id, 2),
    () => trashLocalDocument(document.id, 2)
  ]) await assert.rejects(operation, error => error.code === "DOCUMENT_TRASHED")
  assert.deepEqual(await getLocalDocument(document.id, { includeDeleted: true }), trashed)
  assert.equal((await getDocumentAssets(document)).size, 2)
})

test("恢复只接受回收状态，丢失文档明确报错且不会新建记录", async () => {
  const { document } = await createStoredDocument()
  const source = await getLocalDocument(document.id)
  await assert.rejects(() => restoreLocalDocument(document.id, 1), error => error.code === "DOCUMENT_NOT_TRASHED")
  for (const operation of [
    () => renameLocalDocument("no-record", "标题", 0),
    () => duplicateLocalDocument("no-record", 0),
    () => trashLocalDocument("no-record", 0),
    () => restoreLocalDocument("no-record", 0)
  ]) await assert.rejects(operation, error => error.code === "DOCUMENT_NOT_FOUND")
  assert.deepEqual(await getLocalDocument(document.id), source)
})

test("缺失任一来源资源时复制整体回滚，无新增文档或半份资源", async () => {
  const { document } = await createStoredDocument()
  await accessStore("assets", "readwrite", store => store.delete(`${document.id}:${document.assets[1].id}`))
  const documentsBefore = await getDocuments()
  const assetsBefore = await accessStore("assets", "readonly", store => store.getAllKeys())
  await assert.rejects(() => duplicateLocalDocument(document.id, 1), error => error.code === "DOCUMENT_ASSET_MISSING")
  assert.deepEqual(await getDocuments(), documentsBefore)
  assert.deepEqual(await accessStore("assets", "readonly", store => store.getAllKeys()), assetsBefore)
  assert.equal((await getLocalDocument(document.id)).storageVersion, 1)
})

// 故障发生在复制资源阶段，最终键集合与来源字节都需保持，保证复制的原子性和来源隔离。
test("复制资源写入配额失败回滚新记录和已排队资源，来源保持完整", async () => {
  const { document } = await createStoredDocument()
  const documentsBefore = await getDocuments()
  const assetsBefore = await accessStore("assets", "readonly", store => store.getAllKeys())
  const add = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (value, ...args) {
    if (this.name === "assets" && value.id.endsWith(document.assets[1].id) && !value.id.startsWith(document.id)) {
      throw new DOMException("full", "QuotaExceededError")
    }
    return add.call(this, value, ...args)
  }
  try {
    await assert.rejects(() => duplicateLocalDocument(document.id, 1), /存储空间不足/)
  } finally {
    IDBObjectStore.prototype.add = add
  }
  assert.deepEqual(await getDocuments(), documentsBefore)
  assert.deepEqual(await accessStore("assets", "readonly", store => store.getAllKeys()), assetsBefore)
  assert.equal((await getDocumentAssets(document)).size, 2)
})

// 并发结果不假定具体赢家，只检验一个提交与一个业务冲突，再从仓库读取真正提交的记录。
test("并发同版本管理操作只有一项提交，另一项冲突后可读取最终状态", async () => {
  const { document } = await createStoredDocument()
  const results = await Promise.allSettled([
    renameLocalDocument(document.id, "并发标题", 1),
    trashLocalDocument(document.id, 1)
  ])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  assert.equal(results.find(result => result.status === "rejected").reason.code, "DOCUMENT_CONFLICT")
  const stored = await getLocalDocument(document.id, { includeDeleted: true })
  assert.deepEqual(stored, results.find(result => result.status === "fulfilled").value)
  assert.equal(stored.storageVersion, 2)
})
