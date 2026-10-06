/**
 * 管理内置与用户模板的列表、完整快照、命名、删除和文档实例创建。
 * 模板与文档在数据库中独立存放；模板及实例各自持有资源键，所有写入都受存储版本保护。
 */
import { createId } from "./create-id.js"
import { validateDocument } from "./document-schema.js"
import { getDatabase } from "./local-repository.js"
import { BUILTIN_TEMPLATE_PREFIX, MAX_TEMPLATE_NAME_LENGTH, getBuiltinDocumentTemplates, getBuiltinDocumentTemplate, stripTemplateComments } from "./document-templates.js"

// 模板元信息、模板 Blob 和真实文档 Blob 分别使用独立前缀，避免删除模板时误删来源或实例资源。
const ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/
const templateKey = id => `template:${id}`
const assetKey = (id, assetId) => `template-asset:${id}:${assetId}`
const liveAssetKey = (id, assetId) => `${id}:${assetId}`

/**
 * 模板快照与 Blob 使用 assets 仓库的独立键空间，沿用数据库 v1。
 * documents 仍然只放真实文档，因此模板不会出现在文档库或影响文档保存资源清理。
 * 列表只读取 template: 元信息行，不逐一读取图片/附件 Blob。
 */
export async function getDocumentTemplates() {
  return runTransaction("readonly", context => {
    const templates = getBuiltinDocumentTemplates()
    const custom = []
    const prefix = "template:"
    listen(context, context.assets.openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff")), cursor => {
      if (!cursor) {
        context.result = templates.concat(custom.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)))
        return
      }
      const id = String(cursor.key).slice(prefix.length)
      custom.push(metadata(readStoredTemplate(cursor.value, id)))
      cursor.continue()
    })
  })
}

// 内置模板从内存取得独立克隆且无资源；用户模板在同一只读事务中交付正文和完整资源集。
export async function getDocumentTemplate(id) {
  checkId(id)
  const builtin = getBuiltinDocumentTemplate(id)
  if (builtin) return { template: builtin, assets: new Map() }
  return runTransaction("readonly", context => {
    readTemplate(context, id, undefined, template => {
      readResources(context, template.document, assetId => assetKey(id, assetId), assets => {
        context.result = { template, assets }
      })
    })
  })
}

// 调用方先 flush；来源版本、活跃状态、正文和资源全部在同一事务内读取后保存。
export async function createDocumentTemplate(documentId, baseVersion, name) {
  checkId(documentId, "DOCUMENT_NOT_FOUND")
  checkBaseVersion(baseVersion, "DOCUMENT_CONFLICT")
  const title = checkName(name)
  return runTransaction("readwrite", context => {
    listen(context, context.documents.get(documentId), record => {
      if (!record) throw repositoryError("来源文档不存在，请先保存当前文档", "DOCUMENT_NOT_FOUND")
      if ((record.storageVersion ?? 0) !== baseVersion) throw repositoryError("来源文档已在另一标签页变更，请刷新读取最新版本", "DOCUMENT_CONFLICT")
      if (record.deletedAt) throw repositoryError("来源文档已移入回收站，请先恢复", "DOCUMENT_TRASHED")
      if (record.id !== documentId || record.document?.id !== documentId) throw repositoryError("来源文档记录无效", "TEMPLATE_INVALID")
      validateDocument(record.document)
      readResources(context, record.document, assetId => liveAssetKey(documentId, assetId), assets => {
        const time = new Date().toISOString()
        const template = {
          id: `template-${createId()}`, name: title, description: "从文档保存，保留正文、纸张、图片和附件。",
          builtin: false, createdAt: time, updatedAt: time, storageVersion: 1, document: stripTemplateComments(record.document)
        }
        // 模板快照也具有自己的身份，来源 ID 不参与后续资源寻址或文档实例创建。
        template.document.id = template.id
        template.document.title = template.name
        template.document.createdAt = template.document.updatedAt = time
        validateDocument(template.document)
        // add 阻止随机 ID 碰撞覆盖已有模板；任一资源写入失败，正文与全部资源一起回滚。
        context.assets.add({ id: templateKey(template.id), template })
        for (const [assetId, asset] of assets) context.assets.add({ id: assetKey(template.id, assetId), blob: asset.blob })
        context.result = metadata(template)
      })
    })
  })
}

// 只允许用户模板重命名，同步更新元信息和快照标题/时间，并增加版本供其他标签页检测冲突。
export async function renameDocumentTemplate(id, name, baseVersion) {
  checkMutableId(id)
  checkBaseVersion(baseVersion)
  const title = checkName(name)
  return runTransaction("readwrite", context => {
    readTemplate(context, id, baseVersion, template => {
      if (template.storageVersion >= Number.MAX_SAFE_INTEGER) throw repositoryError("模板存储版本已达到上限，请从模板新建文档后另存为新模板", "TEMPLATE_CONFLICT")
      const time = new Date().toISOString()
      const renamed = { ...template, name: title, updatedAt: time, storageVersion: template.storageVersion + 1,
        document: { ...template.document, title, updatedAt: time } }
      context.assets.put({ id: templateKey(id), template: renamed })
      context.result = metadata(renamed)
    })
  })
}

// 检查模板身份和版本后原子删除元信息及其资源，列表过期时拒绝删除别人刚修改的版本。
export async function deleteDocumentTemplate(id, baseVersion) {
  checkMutableId(id)
  checkBaseVersion(baseVersion)
  return runTransaction("readwrite", context => {
    readTemplate(context, id, baseVersion, () => {
      // 按模板 ID 的完整前缀清理其所有 Blob，也能清理损坏记录留下的孤立资源。
      // 不按来源文档 ID 删除，已从模板创建的真实文档有独立资源键，始终保留。
      context.assets.delete(templateKey(id))
      const prefix = `template-asset:${id}:`
      listen(context, context.assets.openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff")), cursor => {
        if (!cursor) { context.result = true; return }
        cursor.delete()
        cursor.continue()
      })
    })
  })
}

/**
 * 从模板创建的是新文档。模板版本检查、新 ID、资源复制和 documents.add 属于同一笔
 * 事务，容量不足或随机 ID 碰撞不会留下半份新文档；它不修改模板或任何当前会话。
 * 即使模板记录来自旧代码，实例创建也再次去批注，避免把原稿意见带入新的工作。
 */
export async function instantiateDocumentTemplate(id, baseVersion) {
  checkId(id)
  checkBaseVersion(baseVersion)
  return runTransaction("readwrite", context => {
    readTemplate(context, id, baseVersion, template => {
      readResources(context, template.document, assetId => assetKey(id, assetId), assets => {
        const document = stripTemplateComments(template.document)
        const time = new Date().toISOString()
        document.id = createId()
        document.title = template.name
        document.createdAt = document.updatedAt = time
        validateDocument(document)
        const record = { id: document.id, document, storageVersion: 1 }
        for (const [assetId, asset] of assets) context.assets.add({ id: liveAssetKey(document.id, assetId), blob: asset.blob })
        context.documents.add(record)
        context.result = { ...record, assets }
      })
    })
  })
}

// 统一内置和用户模板的读取入口，两类模板均在交付前核对调用方提供的版本。
function readTemplate(context, id, baseVersion, ready) {
  const builtin = getBuiltinDocumentTemplate(id)
  if (builtin) {
    checkTemplateVersion(builtin, baseVersion)
    ready(builtin)
    return
  }
  listen(context, context.assets.get(templateKey(id)), row => {
    const template = readStoredTemplate(row, id)
    checkTemplateVersion(template, baseVersion)
    ready(template)
  })
}

// 本地记录也视为需要验证的数据：核对键、身份、字段枚举和快照元信息的一致性，再校验正文。
function readStoredTemplate(row, id) {
  if (!row) throw repositoryError("这个模板不存在，请刷新模板列表", "TEMPLATE_NOT_FOUND")
  const template = row.template
  if (!ID_PATTERN.test(id) || id.startsWith(BUILTIN_TEMPLATE_PREFIX) || row.id !== templateKey(id) || !template || template.id !== id ||
    template.builtin !== false || typeof template.name !== "string" || template.name !== template.name.trim() ||
    !template.name || template.name.length > MAX_TEMPLATE_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(template.name) ||
    typeof template.description !== "string" || template.description.length > 500 ||
    ![template.createdAt, template.updatedAt].every(isValidTime) || template.updatedAt < template.createdAt ||
    !Number.isSafeInteger(template.storageVersion) || template.storageVersion < 1 || template.document?.id !== id || template.document.title !== template.name ||
    template.document.createdAt !== template.createdAt || template.document.updatedAt !== template.updatedAt ||
    Object.keys(template).some(key => !["id", "name", "description", "builtin", "createdAt", "updatedAt", "storageVersion", "document"].includes(key))) {
    throw repositoryError("模板记录无效，请保留文档并导出备份", "TEMPLATE_INVALID")
  }
  try { validateDocument(template.document) }
  catch (failure) { throw repositoryError("模板内容无效：" + failure.message, "TEMPLATE_INVALID") }
  return template
}

// 列表只交付元数据，避免每个模板卡片携带完整正文；完整快照留给打开或实例化流程。
function metadata({ document: _document, ...fields }) { return fields }

// 读取详情可省略版本；实际修改和实例化由入口要求版本，防止旧列表操作新的模板。
function checkTemplateVersion(template, baseVersion) {
  if (baseVersion !== undefined && template.storageVersion !== baseVersion) {
    throw repositoryError("模板已在另一标签页变更，请刷新模板列表", "TEMPLATE_CONFLICT")
  }
}

// 继续排队请求必须发生在 IDB 成功回调中，不在事务内部 await Blob 字节读取。
// Blob 字节由 IndexedDB 结构化克隆，size/type 同步校验；临时 URL 不进入持久数据。
function readResources(context, document, key, ready) {
  const assets = new Map()
  // 所有资源请求同步排队，全部合法后才推进；无资源模板也会立刻执行后续创建流程。
  let remaining = document.assets.length
  if (!remaining) { ready(assets); return }
  for (const asset of document.assets) {
    listen(context, context.assets.get(key(asset.id)), row => {
      const blob = row?.blob
      if (!(blob instanceof Blob) || row.id !== key(asset.id) || blob.size !== asset.byteLength || blob.type !== asset.mimeType) {
        throw repositoryError(`资源「${asset.fileName}」缺失或类型不匹配，模板操作未完成`, "DOCUMENT_ASSET_MISSING")
      }
      assets.set(asset.id, { ...asset, blob })
      remaining -= 1
      if (!remaining) ready(assets)
    })
  }
}

// 业务校验抛错时中止整个事务；已有失败后忽略后续回调，防止继续创建部分记录。
function listen(context, request, ready) {
  request.onsuccess = () => {
    if (context.failure) return
    try { ready(request.result) }
    catch (failure) { context.abort(failure) }
  }
}

// 将双仓库事务封装成 Promise，提交后才返回结果，失败保留最初错误并回滚全部排队写入。
async function runTransaction(mode, start) {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["documents", "assets"], mode)
    const context = {
      documents: transaction.objectStore("documents"), assets: transaction.objectStore("assets"), result: null, failure: null,
      abort(failure) {
        // 首次错误保留具体原因，已取消的并发读取不重复 abort 或覆盖资源缺失提示。
        if (context.failure) return
        context.failure = normalizeError(failure)
        transaction.abort()
      }
    }
    transaction.oncomplete = () => resolve(context.result)
    transaction.onabort = () => reject(context.failure || normalizeError(transaction.error))
    transaction.onerror = event => { context.failure = context.failure || normalizeError(event.target.error) }
    try { start(context) }
    catch (failure) { context.abort(failure) }
  })
}

// 同一个短 ID 契约也用于来源文档，传入错误码使调用方保留实际业务上下文。
function checkId(id, code = "TEMPLATE_NOT_FOUND") {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw repositoryError("模板或来源文档 ID 无效", code)
}

// 内置前缀代表只读定义，重命名/删除前显式拒绝，避免误把内置项当成本地持久行。
function checkMutableId(id) {
  checkId(id)
  if (id.startsWith(BUILTIN_TEMPLATE_PREFIX)) throw repositoryError("内置模板不能重命名或删除，请先创建文档再保存为自己的模板", "TEMPLATE_BUILTIN_READONLY")
}

// 提交前规范化名字并限制长度/控制字符，成功返回可直接写入元信息与快照的同一字符串。
function checkName(name) {
  const trimmed = typeof name === "string" ? name.trim() : ""
  if (!trimmed || trimmed.length > MAX_TEMPLATE_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw repositoryError(`模板名称应为 1–${MAX_TEMPLATE_NAME_LENGTH} 个字符`, "TEMPLATE_NAME_INVALID")
  }
  return trimmed
}

// 模板版本是安全整数，内置定义可使用版本 0；外部编辑序号不能作为持久版本。
function checkBaseVersion(baseVersion, code = "TEMPLATE_CONFLICT") {
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) throw repositoryError("缺少有效的存储版本，请刷新读取最新记录", code)
}

// 要求标准 UTC 毫秒形式并往返比对，浏览器自动修正的非法日期不会进入模板记录。
function isValidTime(time) {
  return typeof time === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) &&
    Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time
}

// 可读错误消息配合稳定错误码，便于上层区分只读内置项、冲突、缺失和损坏。
function repositoryError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

// 配额不足给出备份路径，已有业务错误原样保留；未知 IDB 失败统一为可展示模板错误。
function normalizeError(error) {
  if (error?.name === "QuotaExceededError") return repositoryError("浏览器存储空间不足，模板操作未完成，请先导出备份", "DOCUMENT_STORAGE_QUOTA")
  if (typeof error?.code === "string" && error instanceof Error) return error
  return repositoryError(error?.message || "本地模板操作失败，请稍后重试", "TEMPLATE_FAILED")
}
