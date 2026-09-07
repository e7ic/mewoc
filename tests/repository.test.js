import test from "node:test"
import assert from "node:assert/strict"
import "fake-indexeddb/auto"
import { IDBObjectStore } from "fake-indexeddb"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { getDocuments, saveLocalDocument, getDocumentAssets } from "../src/pages/editor/tools/local-repository.js"

test("双会话存储版本冲突不会覆盖已保存文档", async () => {
  const document = createDocument()
  await saveLocalDocument(document, new Map(), 0)
  await assert.rejects(() => saveLocalDocument({ ...document, title: "过期写入" }, new Map(), 0), error => error.code === "DOCUMENT_CONFLICT")
  const records = await getDocuments()
  assert.equal(records.find(record => record.id === document.id).document.title, document.title)
})

test("资源与文档原子保存，缺失资源时整笔写入中止", async () => {
  const document = createDocument()
  const blob = new Blob(["image-bytes"], { type: "image/png" })
  const asset = { id: crypto.randomUUID(), fileName: "image.png", mimeType: blob.type, byteLength: blob.size }
  document.assets = [asset]
  await assert.rejects(() => saveLocalDocument(document, new Map(), 0), /尚未就绪/)
  assert.equal((await getDocuments()).some(record => record.id === document.id), false)
  await saveLocalDocument(document, new Map([[asset.id, { ...asset, blob }]]), 0)
  const assets = await getDocumentAssets(document)
  assert.equal(await assets.get(asset.id).blob.text(), "image-bytes")
})

test("不同文档的同名资源 ID 不会互相覆盖", async () => {
  const first = createDocument()
  const second = createDocument()
  const id = crypto.randomUUID()
  const saveImage = (document, text) => {
    const blob = new Blob([text], { type: "image/png" })
    const asset = { id, fileName: "shared.png", mimeType: blob.type, byteLength: blob.size }
    document.assets = [asset]
    return saveLocalDocument(document, new Map([[id, { ...asset, blob }]]), 0)
  }
  await saveImage(first, "first-image")
  await saveImage(second, "second-image")
  assert.equal(await (await getDocumentAssets(first)).get(id).blob.text(), "first-image")
  assert.equal(await (await getDocumentAssets(second)).get(id).blob.text(), "second-image")
  await saveLocalDocument({ ...first, assets: [] }, new Map(), 1)
  assert.equal(await (await getDocumentAssets(second)).get(id).blob.text(), "second-image")
})

test("删除图片后保存清理磁盘资源，保留会话 Blob 可供撤销恢复", async () => {
  const document = createDocument()
  const blob = new Blob(["undo-image"], { type: "image/png" })
  const asset = { id: crypto.randomUUID(), fileName: "undo.png", mimeType: blob.type, byteLength: blob.size }
  document.assets = [asset]
  const assets = new Map([[asset.id, { ...asset, blob }]])
  await saveLocalDocument(document, assets, 0)
  await saveLocalDocument({ ...document, assets: [] }, assets, 1)
  await assert.rejects(() => getDocumentAssets(document), /资源缺失/)
  assert.equal(assets.get(asset.id).blob, blob)
  await saveLocalDocument(document, assets, 2)
  assert.equal(await (await getDocumentAssets(document)).get(asset.id).blob.text(), "undo-image")
})

test("配额写入异常回滚已排队的资源删除，版本不变且允许重试", async () => {
  const document = createDocument()
  const blob = new Blob(["keep-image"], { type: "image/png" })
  const asset = { id: crypto.randomUUID(), fileName: "keep.png", mimeType: blob.type, byteLength: blob.size }
  document.assets = [asset]
  const assets = new Map([[asset.id, { ...asset, blob }]])
  await saveLocalDocument(document, assets, 0)
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.name === "documents" && value.id === document.id) throw new DOMException("Quota reached", "QuotaExceededError")
    return put.call(this, value, ...args)
  }
  try {
    await assert.rejects(() => saveLocalDocument({ ...document, assets: [] }, assets, 1), /存储空间不足/)
  } finally {
    IDBObjectStore.prototype.put = put
  }
  const saved = (await getDocuments()).find(record => record.id === document.id)
  assert.equal(saved.storageVersion, 1)
  assert.equal(saved.document.assets.length, 1)
  assert.equal(await (await getDocumentAssets(document)).get(asset.id).blob.text(), "keep-image")
  assert.deepEqual(await saveLocalDocument({ ...document, assets: [] }, assets, 1), { storageVersion: 2 })
  await assert.rejects(() => getDocumentAssets(document), /资源缺失/)
})

test("异步写入失败也回滚资源删除与文档版本", async () => {
  const document = createDocument()
  const blob = new Blob(["keep-on-abort"], { type: "image/png" })
  const asset = { id: crypto.randomUUID(), fileName: "abort.png", mimeType: blob.type, byteLength: blob.size }
  document.assets = [asset]
  const assets = new Map([[asset.id, { ...asset, blob }]])
  await saveLocalDocument(document, assets, 0)
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, ...args) {
    // 重复主键在请求异步完成时触发 ConstraintError，而不是同步 throw。
    if (this.name === "documents" && value.id === document.id) return this.add(value)
    return put.call(this, value, ...args)
  }
  try {
    await assert.rejects(() => saveLocalDocument({ ...document, assets: [] }, assets, 1), /本地保存失败/)
  } finally {
    IDBObjectStore.prototype.put = put
  }
  const saved = (await getDocuments()).find(record => record.id === document.id)
  assert.equal(saved.storageVersion, 1)
  assert.equal(saved.document.assets.length, 1)
  assert.equal(await (await getDocumentAssets(document)).get(asset.id).blob.text(), "keep-on-abort")
})
