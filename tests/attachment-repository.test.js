import test from "node:test"
import assert from "node:assert/strict"
import "fake-indexeddb/auto"
import { IDBObjectStore } from "fake-indexeddb"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { readAttachmentFile } from "../src/pages/editor/tools/attachment-assets.js"
import { getDocuments, saveLocalDocument, getDocumentAssets } from "../src/pages/editor/tools/local-repository.js"

async function createRecord() {
  const asset = await readAttachmentFile(new File([new Uint8Array([0, 255, 128, 1])], "数据库附件.bin"))
  const record = createDocument()
  const { blob, ...metadata } = asset
  record.assets = [metadata]
  record.content.content = [{ type: "attachment", attrs: { assetId: asset.id } }]
  return { record, assets: new Map([[asset.id, { ...metadata, blob }]]), asset }
}

test("附件正文与原始 Blob 可保存读取，删除回收磁盘资源后撤销可重新写回", async () => {
  const { record, assets, asset } = await createRecord()
  await saveLocalDocument(record, assets, 0)
  const stored = (await getDocuments()).find(item => item.id === record.id)
  assert.equal(stored.document.assets[0].kind, "attachment")
  assert.deepEqual(await (await getDocumentAssets(stored.document)).get(asset.id).blob.arrayBuffer(), await asset.blob.arrayBuffer())
  const deleted = { ...record, content: createDocument().content, assets: [] }
  await saveLocalDocument(deleted, assets, 1)
  await assert.rejects(() => getDocumentAssets(record), /资源缺失/)
  assert.equal(assets.get(asset.id).blob, asset.blob)
  await saveLocalDocument(record, assets, 2)
  assert.deepEqual(await (await getDocumentAssets(record)).get(asset.id).blob.arrayBuffer(), await asset.blob.arrayBuffer())
})

test("附件资源丢失或类型不符时中止保存，不产生不完整文档", async () => {
  const { record, assets, asset } = await createRecord()
  await assert.rejects(() => saveLocalDocument(record, new Map(), 0), /尚未就绪/)
  assets.set(asset.id, { ...asset, blob: new Blob([new Uint8Array(4)], { type: "text/html" }) })
  await assert.rejects(() => saveLocalDocument(record, assets, 0), /类型不匹配/)
  assert.equal((await getDocuments()).some(item => item.id === record.id), false)
})

test("附件版本冲突和配额异常不会删除已保存资源，重试仍可成功", async () => {
  const { record, assets, asset } = await createRecord()
  await saveLocalDocument(record, assets, 0)
  const deleted = { ...record, content: createDocument().content, assets: [] }
  await assert.rejects(() => saveLocalDocument(deleted, assets, 0), error => error.code === "DOCUMENT_CONFLICT")
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.name === "documents" && value.id === record.id) throw new DOMException("full", "QuotaExceededError")
    return put.call(this, value, ...args)
  }
  try {
    await assert.rejects(() => saveLocalDocument(deleted, assets, 1), /存储空间不足/)
  } finally {
    IDBObjectStore.prototype.put = put
  }
  assert.equal((await getDocuments()).find(item => item.id === record.id).storageVersion, 1)
  assert.deepEqual(await (await getDocumentAssets(record)).get(asset.id).blob.arrayBuffer(), await asset.blob.arrayBuffer())
  await saveLocalDocument(deleted, assets, 1)
  await assert.rejects(() => getDocumentAssets(record), /资源缺失/)
})
