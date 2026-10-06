/**
 * 验证用户模板、内置模板和真实文档拥有独立身份、版本、正文与资源键空间。
 * 覆盖去批注、实例化、只读内置项、并发版本及同步/异步故障后的整笔事务回滚。
 */
import test from "node:test"
import assert from "node:assert/strict"
import "fake-indexeddb/auto"
import { IDBObjectStore } from "fake-indexeddb"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { getDatabase, getLocalDocument, getDocumentAssets, saveLocalDocument, trashLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { getDocumentTemplates, getDocumentTemplate, createDocumentTemplate, renameDocumentTemplate, deleteDocumentTemplate, instantiateDocumentTemplate } from "../src/pages/editor/tools/document-template-repository.js"

// 测试底层事务入口用于读取键、构造旧/损坏模板与验证失败后持久状态，完成后才交付请求结果。
async function accessStore(name, mode, callback) {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(name, mode)
    const request = callback(transaction.objectStore(name))
    transaction.oncomplete = () => resolve(request?.result)
    transaction.onabort = transaction.onerror = () => reject(transaction.error)
  })
}

// 列表契约只包含这些字段，避免 UI 列表意外携带完整正文或 Blob；原始读写 helpers 专用于故障 fixture。
const metadataKeys = ["id", "name", "description", "builtin", "createdAt", "updatedAt", "storageVersion"].sort()
const keys = name => accessStore(name, "readonly", store => store.getAllKeys())
const readStored = id => accessStore("assets", "readonly", store => store.get(`template:${id}`))
const saveStored = template => accessStore("assets", "readwrite", store => store.put({ id: `template:${template.id}`, template }))

// 来源同时包含横向纸张、缩进、粗体、批注、图片和附件，去批注时必须保留其他结构与字节。
function makeDocument(title = "模板来源") {
  const document = createDocument()
  document.title = title
  document.createdAt = document.updatedAt = "2020-01-01T00:00:00.000Z"
  document.page.orientation = "landscape"
  const assets = new Map()
  for (const [id, kind, text, mimeType, fileName] of [
    ["template-image", "image", "original-image", "image/png", "图片.png"],
    ["template-attachment", "attachment", "original-attachment", "application/octet-stream", "附件.bin"]
  ]) {
    const blob = new Blob([text], { type: mimeType })
    const metadata = { id, kind, mimeType, byteLength: blob.size, fileName }
    document.assets.push(metadata)
    assets.set(id, { ...metadata, blob })
  }
  document.content = {
    type: "doc", attrs: { commentThreads: [{ id: "template-comment", text: "原稿审阅意见", quote: title, resolved: false, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" }] },
    content: [
      { type: "paragraph", attrs: { leftIndent: 2 }, content: [{ type: "text", text: title, marks: [{ type: "bold" }, { type: "commentAnchor", attrs: { id: "template-comment" } }] }] },
      { type: "image", attrs: { assetId: "template-image", width: 120 } },
      { type: "attachment", attrs: { assetId: "template-attachment" } }
    ]
  }
  validateDocument(document)
  return { document, assets }
}

// 先把来源真实保存为版本 1，让模板入口从持久快照读取，避免测试直接传会话候选内容。
async function seed(title) {
  const source = makeDocument(title)
  await saveLocalDocument(source.document, source.assets, 0)
  return source
}

// 检查资源数量、字节与 MIME，来源、模板、实例之间的键隔离不能以牺牲二进制内容为代价。
async function assertAssetBytes(expected, actual) {
  assert.equal(actual.size, expected.size)
  for (const [id, asset] of expected) {
    assert.deepEqual(await actual.get(id).blob.arrayBuffer(), await asset.blob.arrayBuffer())
    assert.equal(actual.get(id).blob.type, asset.blob.type)
  }
}

test("旧数据库直接提供三份内置模板，保持 v1 与 documents/asset 契约", async () => {
  const templates = await getDocumentTemplates()
  assert.equal(templates.length, 3)
  assert.equal(templates.every(template => template.builtin), true)
  assert.equal((await getDatabase()).version, 1)
  assert.deepEqual([...(await getDatabase()).objectStoreNames], ["assets", "documents"])
  for (const item of templates) {
    assert.deepEqual(Object.keys(item).sort(), metadataKeys)
    const read = await getDocumentTemplate(item.id)
    assert.equal(validateDocument(read.template.document), read.template.document)
    assert.equal(read.assets.size, 0)
  }
})

test("保存模板原子保留正文纸张资源，移除批注而不改来源及存储版本", async () => {
  const source = await seed("原稿带批注")
  const before = await getLocalDocument(source.document.id)
  const template = await createDocumentTemplate(source.document.id, 1, "  正式模板  ")
  assert.deepEqual(Object.keys(template).sort(), metadataKeys)
  assert.equal(template.name, "正式模板")
  assert.equal(template.builtin, false)
  assert.equal(template.storageVersion, 1)
  assert.notEqual(template.id, source.document.id)
  const read = await getDocumentTemplate(template.id)
  assert.equal(read.template.document.id, template.id)
  assert.equal(read.template.document.title, template.name)
  assert.equal(read.template.document.createdAt, template.createdAt)
  assert.equal(read.template.document.updatedAt, template.updatedAt)
  assert.deepEqual(read.template.document.page, source.document.page)
  assert.equal(read.template.document.content.attrs.commentThreads, undefined)
  assert.deepEqual(read.template.document.content.content[0].content[0].marks, [{ type: "bold" }])
  assert.deepEqual(read.template.document.content.content[0].attrs, { leftIndent: 2 })
  await assertAssetBytes(source.assets, read.assets)
  assert.deepEqual(await getLocalDocument(source.document.id), before)
})

test("模板列表只扫描 metadata 前缀，内置在前且自定义不包含正文或 Blob", async () => {
  const source = await seed("列表扫描")
  const template = await createDocumentTemplate(source.document.id, 1, "列表模板")
  const get = IDBObjectStore.prototype.get
  const getAll = IDBObjectStore.prototype.getAll
  const cursor = IDBObjectStore.prototype.openCursor
  IDBObjectStore.prototype.get = function () { assert.fail("模板列表不应读取单个 Blob") }
  IDBObjectStore.prototype.getAll = function () { assert.fail("模板列表不应扫描全资产仓库") }
  IDBObjectStore.prototype.openCursor = function (range, ...rest) {
    assert.equal(this.name, "assets")
    assert.equal(range.lower, "template:")
    assert.equal(range.upper, "template:\uffff")
    return cursor.call(this, range, ...rest)
  }
  let list
  try { list = await getDocumentTemplates() }
  finally { IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.getAll = getAll; IDBObjectStore.prototype.openCursor = cursor }
  assert.equal(list.slice(0, 3).every(item => item.builtin), true)
  assert.equal(list.some(item => item.id === template.id), true)
  assert.equal(list.every(item => Object.keys(item).sort().join() === metadataKeys.join()), true)
})

test("来源删除 live 资源或移入回收站后，独立模板仍可预览及创建实例", async () => {
  const source = await seed("来源分离")
  const template = await createDocumentTemplate(source.document.id, 1, "独立模板")
  await saveLocalDocument({ ...source.document, content: createDocument().content, assets: [] }, new Map(), 1)
  await trashLocalDocument(source.document.id, 2)
  await assertAssetBytes(source.assets, (await getDocumentTemplate(template.id)).assets)
  const instance = await instantiateDocumentTemplate(template.id, 1)
  assert.notEqual(instance.id, source.document.id)
  assert.notEqual(instance.id, template.id)
  assert.equal(instance.document.title, template.name)
  assert.equal(instance.storageVersion, 1)
  assert.equal(instance.document.createdAt, instance.document.updatedAt)
  const { assets, ...stored } = instance
  assert.deepEqual(await getLocalDocument(instance.id), stored)
  await assertAssetBytes(source.assets, assets)
  await assertAssetBytes(source.assets, await getDocumentAssets(instance.document))
})

// 模板与来源及实例共用内部 assetId，但持久前缀不同；删除后再读取另外两套 Blob 才能证明清理范围正确。
test("模板删除只清理自身键，保留来源及已创建实例资源", async () => {
  const source = await seed("删除模板隔离")
  const template = await createDocumentTemplate(source.document.id, 1, "待删除")
  const instance = await instantiateDocumentTemplate(template.id, 1)
  await accessStore("assets", "readwrite", store => store.add({ id: `template-asset:${template.id}:orphan`, blob: new Blob(["orphan"]) }))
  await accessStore("assets", "readwrite", store => store.add({ id: `template-asset:${template.id}-suffix:foreign`, blob: new Blob(["foreign"]) }))
  const sourceBefore = await getLocalDocument(source.document.id)
  assert.equal(await deleteDocumentTemplate(template.id, 1), true)
  assert.equal((await keys("assets")).some(key => key === `template:${template.id}` || key.startsWith(`template-asset:${template.id}:`)), false)
  assert.equal((await keys("assets")).includes(`template-asset:${template.id}-suffix:foreign`), true)
  await assertAssetBytes(source.assets, await getDocumentAssets(source.document))
  await assertAssetBytes(source.assets, await getDocumentAssets(instance.document))
  assert.deepEqual(await getLocalDocument(source.document.id), sourceBefore)
  await assert.rejects(() => getDocumentTemplate(template.id), error => error.code === "TEMPLATE_NOT_FOUND")
})

test("重命名推进模板版本且更新快照标题，新实例采用最新名称", async () => {
  const source = await seed("模板重命名源")
  const template = await createDocumentTemplate(source.document.id, 1, "旧模板名")
  const renamed = await renameDocumentTemplate(template.id, "  新模板名  ", 1)
  assert.equal(renamed.name, "新模板名")
  assert.equal(renamed.storageVersion, 2)
  const read = await getDocumentTemplate(template.id)
  assert.equal(read.template.document.title, renamed.name)
  assert.equal(read.template.document.updatedAt, renamed.updatedAt)
  await assertAssetBytes(source.assets, read.assets)
  const instance = await instantiateDocumentTemplate(template.id, 2)
  assert.equal(instance.document.title, renamed.name)
  assert.equal((await getLocalDocument(source.document.id)).storageVersion, 1)
})

test("内置模板不可改名删除，版本为0，创建独立文档不改内置定义", async () => {
  const id = "builtin-template-meeting"
  const original = await getDocumentTemplate(id)
  await assert.rejects(() => renameDocumentTemplate(id, "修改", 0), error => error.code === "TEMPLATE_BUILTIN_READONLY")
  await assert.rejects(() => deleteDocumentTemplate(id, 0), error => error.code === "TEMPLATE_BUILTIN_READONLY")
  await assert.rejects(() => instantiateDocumentTemplate(id, 1), error => error.code === "TEMPLATE_CONFLICT")
  const instance = await instantiateDocumentTemplate(id, 0)
  assert.equal(instance.assets.size, 0)
  assert.notEqual(instance.document.id, id)
  assert.deepEqual(instance.document.content, original.template.document.content)
  assert.deepEqual(await getDocumentTemplate(id), original)
})

test("旧版本及非法版本不能改名删除创建模板实例，持久数据不变", async () => {
  const source = await seed("模板锁")
  const template = await createDocumentTemplate(source.document.id, 1, "模板锁")
  await renameDocumentTemplate(template.id, "新版本", 1)
  const stored = await readStored(template.id)
  const beforeKeys = await keys("assets")
  const beforeDocs = await keys("documents")
  for (const version of [1, undefined, null, NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const operation of [
      () => renameDocumentTemplate(template.id, "再修改", version),
      () => deleteDocumentTemplate(template.id, version),
      () => instantiateDocumentTemplate(template.id, version)
    ]) await assert.rejects(operation, error => error.code === "TEMPLATE_CONFLICT")
  }
  assert.deepEqual(await readStored(template.id), stored)
  assert.deepEqual(await keys("assets"), beforeKeys)
  assert.deepEqual(await keys("documents"), beforeDocs)
})

test("来源版本冲突、未保存及回收状态阻止保存模板，不复活源文档", async () => {
  const source = await seed("来源锁")
  await saveLocalDocument({ ...source.document, title: "另一窗口" }, source.assets, 1)
  for (const version of [1, undefined, NaN, -1, 1.5]) {
    await assert.rejects(() => createDocumentTemplate(source.document.id, version, "应失败"), error => error.code === "DOCUMENT_CONFLICT")
  }
  await assert.rejects(() => createDocumentTemplate("not-saved-document", 0, "未保存"), error => error.code === "DOCUMENT_NOT_FOUND")
  const trashed = await trashLocalDocument(source.document.id, 2)
  await assert.rejects(() => createDocumentTemplate(source.document.id, 3, "应失败"), error => error.code === "DOCUMENT_TRASHED")
  assert.deepEqual(await getLocalDocument(source.document.id, { includeDeleted: true }), trashed)
})

test("名称和ID非法时不进入写事务，空白与控制字符不能成为模板名称", async () => {
  const source = await seed("名称验证")
  const template = await createDocumentTemplate(source.document.id, 1, "合法模板")
  for (const name of [null, undefined, " ", "x".repeat(101), "内部\u0000字符", "内部\n换行"]) {
    await assert.rejects(() => createDocumentTemplate(source.document.id, 1, name), error => error.code === "TEMPLATE_NAME_INVALID")
    await assert.rejects(() => renameDocumentTemplate(template.id, name, 1), error => error.code === "TEMPLATE_NAME_INVALID")
  }
  for (const id of [null, undefined, "template:unsafe", "x".repeat(101)]) {
    await assert.rejects(() => getDocumentTemplate(id), error => error.code === "TEMPLATE_NOT_FOUND")
    await assert.rejects(() => instantiateDocumentTemplate(id, 1), error => error.code === "TEMPLATE_NOT_FOUND")
  }
  assert.equal((await getDocumentTemplate(template.id)).template.name, "合法模板")
})

test("缺失来源 Blob 阻止模板保存，元信息和先读取的资源不会留下半份模板", async () => {
  const source = await seed("缺来源资源")
  await accessStore("assets", "readwrite", store => store.delete(`${source.document.id}:template-attachment`))
  const before = await keys("assets")
  await assert.rejects(() => createDocumentTemplate(source.document.id, 1, "应失败"), error => error.code === "DOCUMENT_ASSET_MISSING")
  assert.deepEqual(await keys("assets"), before)
  assert.equal((await getLocalDocument(source.document.id)).storageVersion, 1)
})

test("缺失或错类型模板资源阻止预览与实例创建，仍允许删除损坏模板", async () => {
  const source = await seed("缺模板资源")
  const template = await createDocumentTemplate(source.document.id, 1, "损坏模板")
  const attachmentKey = `template-asset:${template.id}:template-attachment`
  await accessStore("assets", "readwrite", store => store.delete(attachmentKey))
  const beforeDocs = await keys("documents")
  for (const blob of [null, new Blob(["original-attachment"], { type: "text/html" }), new Blob(["short"], { type: "application/octet-stream" })]) {
    if (blob) await accessStore("assets", "readwrite", store => store.put({ id: attachmentKey, blob }))
    for (const operation of [() => getDocumentTemplate(template.id), () => instantiateDocumentTemplate(template.id, 1)]) {
      await assert.rejects(operation, error => error.code === "DOCUMENT_ASSET_MISSING")
    }
    assert.deepEqual(await keys("documents"), beforeDocs)
  }
  await deleteDocumentTemplate(template.id, 1)
  await assertAssetBytes(source.assets, await getDocumentAssets(source.document))
})

test("坏模板元信息/正文/身份拒绝读取与所有写入，且不会操作其他键", async () => {
  const source = await seed("坏元信息")
  const template = await createDocumentTemplate(source.document.id, 1, "需校验")
  const stored = (await readStored(template.id)).template
  const malformed = [
    { ...stored, builtin: true }, { ...stored, name: " " }, { ...stored, description: {} },
    { ...stored, storageVersion: 0 }, { ...stored, storageVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...stored, createdAt: "2026-02-30T00:00:00.000Z" }, { ...stored, hidden: true },
    { ...stored, document: { ...stored.document, id: source.document.id } },
    { ...stored, document: { ...stored.document, content: { type: "doc", content: [{ type: "unsupported-template-node" }] } } }
  ]
  for (const candidate of malformed) {
    await saveStored(candidate)
    const before = await keys("assets")
    for (const operation of [
      () => getDocumentTemplate(template.id), () => instantiateDocumentTemplate(template.id, 1),
      () => renameDocumentTemplate(template.id, "应失败", 1), () => deleteDocumentTemplate(template.id, 1)
    ]) await assert.rejects(operation, error => error.code === "TEMPLATE_INVALID")
    assert.deepEqual(await keys("assets"), before)
  }
  await saveStored(stored)
  await assertAssetBytes(source.assets, (await getDocumentTemplate(template.id)).assets)
})

// 人为写入旧式带批注模板，证明实例化自身承担兼容净化，且不会反向修改持久模板。
test("实例再次净化模板内遗留批注，不把审阅意见带到新文档", async () => {
  const source = await seed("旧模板批注")
  const template = await createDocumentTemplate(source.document.id, 1, "旧模板批注")
  const stored = (await readStored(template.id)).template
  stored.document.content = source.document.content
  await saveStored(stored)
  const instance = await instantiateDocumentTemplate(template.id, 1)
  assert.equal(instance.document.content.attrs.commentThreads, undefined)
  assert.deepEqual(instance.document.content.content[0].content[0].marks, [{ type: "bold" }])
  assert.deepEqual((await getDocumentTemplate(template.id)).template.document.content, source.document.content)
})

test("保存模板资源写入配额错误回滚 metadata 与已排队 Blob", async () => {
  const source = await seed("保存配额")
  const before = await keys("assets")
  const add = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (value, ...args) {
    if (this.name === "assets" && value.id.startsWith("template-asset:") && value.id.endsWith(":template-attachment")) {
      throw new DOMException("full", "QuotaExceededError")
    }
    return add.call(this, value, ...args)
  }
  try { await assert.rejects(() => createDocumentTemplate(source.document.id, 1, "配额失败"), error => error.code === "DOCUMENT_STORAGE_QUOTA") }
  finally { IDBObjectStore.prototype.add = add }
  assert.deepEqual(await keys("assets"), before)
  await assertAssetBytes(source.assets, await getDocumentAssets(source.document))
})

// 强制请求级主键冲突而非同步异常，覆盖 IDB 在已排队资源写入后才失败的路径。
test("实例 documents.add 异步冲突回滚全部新资源，源模板保持完整", async () => {
  const source = await seed("新建回滚")
  const template = await createDocumentTemplate(source.document.id, 1, "新建回滚")
  const beforeAssets = await keys("assets")
  const beforeDocs = await keys("documents")
  const add = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (value, ...args) {
    if (this.name === "documents") return add.call(this, { ...value, id: source.document.id }, ...args)
    return add.call(this, value, ...args)
  }
  try { await assert.rejects(() => instantiateDocumentTemplate(template.id, 1), error => error.code === "TEMPLATE_FAILED") }
  finally { IDBObjectStore.prototype.add = add }
  assert.deepEqual(await keys("assets"), beforeAssets)
  assert.deepEqual(await keys("documents"), beforeDocs)
  await assertAssetBytes(source.assets, (await getDocumentTemplate(template.id)).assets)
})

test("重命名配额与删除最终请求失败均整体回滚，版本及资源保留", async () => {
  const source = await seed("变更回滚")
  const template = await createDocumentTemplate(source.document.id, 1, "变更回滚")
  const before = await readStored(template.id)
  const beforeKeys = await keys("assets")
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.name === "assets" && value.id === `template:${template.id}`) throw new DOMException("full", "QuotaExceededError")
    return put.call(this, value, ...args)
  }
  try { await assert.rejects(() => renameDocumentTemplate(template.id, "应回滚", 1), error => error.code === "DOCUMENT_STORAGE_QUOTA") }
  finally { IDBObjectStore.prototype.put = put }
  const openCursor = IDBObjectStore.prototype.openCursor
  IDBObjectStore.prototype.openCursor = function (range, ...args) {
    if (this.name === "assets" && range?.lower === `template-asset:${template.id}:`) throw new DOMException("failed", "UnknownError")
    return openCursor.call(this, range, ...args)
  }
  try { await assert.rejects(() => deleteDocumentTemplate(template.id, 1), error => error.code === "TEMPLATE_FAILED") }
  finally { IDBObjectStore.prototype.openCursor = openCursor }
  assert.deepEqual(await readStored(template.id), before)
  assert.deepEqual(await keys("assets"), beforeKeys)
  await assertAssetBytes(source.assets, (await getDocumentTemplate(template.id)).assets)
})

// 不假定哪一候选先提交，只核对成功候选与读回名称一致，并保证版本只增加一次。
test("同基础版本并发重命名只有一笔提交，失败者不改变已提交名称", async () => {
  const source = await seed("并发模板")
  const template = await createDocumentTemplate(source.document.id, 1, "并发模板")
  const results = await Promise.allSettled([renameDocumentTemplate(template.id, "候选一", 1), renameDocumentTemplate(template.id, "候选二", 1)])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  assert.equal(results.find(result => result.status === "rejected").reason.code, "TEMPLATE_CONFLICT")
  const winner = results.find(result => result.status === "fulfilled").value
  const read = await getDocumentTemplate(template.id)
  assert.equal(read.template.name, winner.name)
  assert.equal(read.template.storageVersion, 2)
})

test("版本达到安全整数上限时拒绝继续递增，原模板仍可读取与创建实例", async () => {
  const source = await seed("整数上限")
  const template = await createDocumentTemplate(source.document.id, 1, "整数上限")
  const stored = (await readStored(template.id)).template
  stored.storageVersion = Number.MAX_SAFE_INTEGER
  await saveStored(stored)
  await assert.rejects(() => renameDocumentTemplate(template.id, "不会写入", Number.MAX_SAFE_INTEGER), error => error.code === "TEMPLATE_CONFLICT")
  assert.deepEqual((await readStored(template.id)).template, stored)
  const instance = await instantiateDocumentTemplate(template.id, Number.MAX_SAFE_INTEGER)
  assert.equal(instance.storageVersion, 1)
  await assertAssetBytes(source.assets, instance.assets)
})
