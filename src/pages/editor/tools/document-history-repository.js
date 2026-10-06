/**
 * 在本地数据库中保存、读取、恢复和复制文档历史快照。
 * 历史正文与 Blob 使用独立键空间；所有写操作遵循当前文档存储版本，防止跨标签页覆盖。
 */
import { createId } from "./create-id.js"
import { validateDocument } from "./document-schema.js"
import { getDatabase } from "./local-repository.js"

// 身份校验与键构造集中定义：历史元信息、历史资源和当前资源互不覆盖，游标只扫描对应前缀。
const ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/
const historyKey = (documentId, versionId) => `${documentId}:history:${versionId}`
const historyAssetKey = (documentId, versionId, assetId) => `${documentId}:history-asset:${versionId}:${assetId}`
const liveAssetKey = (documentId, assetId) => `${documentId}:${assetId}`

/**
 * 版本记录与版本 Blob 使用现有 assets 仓库中的独立前缀，数据库保持 v1。
 * metadata 行为 { id: 文档:history:版本, version }，正文只在该行中保存一次；
 * Blob 行为 { id: 文档:history-asset:版本:资源, blob }，不会和 live 文档资源键混用。
 * 列表仅扫描 metadata 前缀，不加载资源 Blob，也不向 UI 交付完整正文快照。
 */
export async function getDocumentVersions(documentId) {
  checkIds(documentId)
  return runTransaction("readonly", context => {
    readLiveDocument(context, documentId, undefined, () => {
      const prefix = `${documentId}:history:`
      const versions = []
      const request = context.assets.openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"))
      listen(context, request, cursor => {
        if (!cursor) {
          context.result = versions.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
          return
        }
        const version = readStoredVersion(cursor.value, documentId, String(cursor.key).slice(prefix.length))
        const { document: _document, ...metadata } = version
        versions.push(metadata)
        cursor.continue()
      })
    })
  })
}

// 在一个只读事务内核对当前文档仍可访问，再读取完整快照及其专属资源；不返回半套资源。
export async function getDocumentVersion(documentId, versionId) {
  checkIds(documentId, versionId)
  return runTransaction("readonly", context => {
    readLiveDocument(context, documentId, undefined, () => {
      readVersion(context, documentId, versionId, version => {
        readResources(context, version.document, assetId => historyAssetKey(documentId, versionId, assetId), assets => {
          context.result = { version, assets }
        })
      })
    })
  })
}

// 手动保存版本读取已经落盘的快照；调用方应先 flush 当前会话，不传入会话中的候选正文。
export async function createDocumentVersion(documentId, baseVersion, label = "") {
  checkIds(documentId)
  checkBaseVersion(baseVersion)
  const title = typeof label === "string" ? label.trim() : null
  if (title === null || title.length > 100) throw repositoryError("版本名称最多 100 个字符", "DOCUMENT_VERSION_LABEL_INVALID")
  return runTransaction("readwrite", context => {
    readLiveDocument(context, documentId, baseVersion, record => {
      readResources(context, record.document, assetId => liveAssetKey(documentId, assetId), assets => {
        const version = makeVersion(record, title, "manual")
        writeVersion(context, version, assets)
        context.result = version
      })
    })
  })
}

/**
 * 恢复同时锁定 documents 和 assets，先完整读取当前/历史两套资源，再排队所有写入。
 * 当前文档先保存为 before-restore 版本；删除 live 旧引用、写入历史 Blob 和更新正文
 * 仍属于同一事务。资源缺失、配额或任一请求错误会同时回滚备份和恢复，不能半恢复。
 */
export async function restoreDocumentVersion(documentId, versionId, baseVersion) {
  checkIds(documentId, versionId)
  checkBaseVersion(baseVersion)
  return runTransaction("readwrite", context => {
    readLiveDocument(context, documentId, baseVersion, record => {
      readVersion(context, documentId, versionId, version => {
        readResources(context, record.document, assetId => liveAssetKey(documentId, assetId), currentAssets => {
          readResources(context, version.document, assetId => historyAssetKey(documentId, versionId, assetId), restoredAssets => {
            const document = structuredClone(version.document)
            document.id = documentId
            document.createdAt = record.document.createdAt
            document.updatedAt = new Date().toISOString()
            validateDocument(document)
            const restored = { ...record, document, storageVersion: (record.storageVersion ?? 0) + 1 }
            const backup = makeVersion(record, "恢复前自动保留", "before-restore")
            writeVersion(context, backup, currentAssets)
            const references = new Set(document.assets.map(asset => asset.id))
            for (const asset of record.document.assets) {
              if (!references.has(asset.id)) context.assets.delete(liveAssetKey(documentId, asset.id))
            }
            writeLiveResources(context, documentId, restoredAssets)
            context.documents.put(restored)
            context.result = { ...restored, assets: restoredAssets }
          })
        })
      })
    })
  })
}

// 将指定历史内容复制为新文档，保留资源内部 ID，但使用新的文档身份、标题后缀和创建时间。
// 先检查来源当前存储版本，避免从过期文档库操作悄悄创建错误副本。
export async function duplicateDocumentVersion(documentId, versionId, baseVersion) {
  checkIds(documentId, versionId)
  checkBaseVersion(baseVersion)
  return runTransaction("readwrite", context => {
    readLiveDocument(context, documentId, baseVersion, () => {
      readVersion(context, documentId, versionId, version => {
        readResources(context, version.document, assetId => historyAssetKey(documentId, versionId, assetId), assets => {
          const document = structuredClone(version.document)
          const suffix = " - 历史副本"
          const time = new Date().toISOString()
          document.id = createId()
          document.title = document.title.slice(0, 100 - suffix.length) + suffix
          document.createdAt = document.updatedAt = time
          validateDocument(document)
          const copy = { id: document.id, document, storageVersion: 1 }
          // 新文档及资源用 add 防止罕见随机 ID 碰撞覆盖现有记录；失败整体回滚。
          writeLiveResources(context, document.id, assets, true)
          context.documents.add(copy)
          context.result = { ...copy, assets }
        })
      })
    })
  })
}

// 校验并深克隆当前持久正文，记住其来源存储版本；快照不再共享随后可修改的会话对象。
function makeVersion(record, label, reason) {
  return {
    id: createId(),
    documentId: record.id,
    label,
    reason,
    createdAt: new Date().toISOString(),
    sourceStorageVersion: record.storageVersion ?? 0,
    document: structuredClone(validateDocument(record.document))
  }
}

// 在已开启事务内排队历史元信息和全部资源 add；随机键碰撞触发事务失败而不是覆盖旧快照。
function writeVersion(context, version, assets) {
  context.assets.add({ id: historyKey(version.documentId, version.id), version })
  for (const [assetId, asset] of assets) {
    context.assets.add({ id: historyAssetKey(version.documentId, version.id, assetId), blob: asset.blob })
  }
}

// 同一套资源可用于恢复旧文档或创建新文档；创建用 add 检测碰撞，恢复用 put 更新现有键。
function writeLiveResources(context, documentId, assets, create = false) {
  for (const [assetId, asset] of assets) {
    const row = { id: liveAssetKey(documentId, assetId), blob: asset.blob }
    if (create) context.assets.add(row)
    else context.assets.put(row)
  }
}

// 每项历史操作都通过当前文档的存在、版本、回收状态和身份检查，读取历史不绕过文档权限状态。
function readLiveDocument(context, documentId, baseVersion, ready) {
  listen(context, context.documents.get(documentId), record => {
    if (!record) throw repositoryError("这份本地文档不存在，请刷新文档库", "DOCUMENT_NOT_FOUND")
    if (baseVersion !== undefined && (record.storageVersion ?? 0) !== baseVersion) {
      throw repositoryError("文档已在另一标签页变更，请先导出当前副本，再刷新读取最新版本", "DOCUMENT_CONFLICT")
    }
    if (record.deletedAt) throw repositoryError("文档已移入回收站，请先在文档库恢复", "DOCUMENT_TRASHED")
    validateDocument(record.document)
    if (record.document.id !== documentId || record.id !== documentId) throw repositoryError("本地文档记录无效", "DOCUMENT_VERSION_INVALID")
    ready(record)
  })
}

// 只通过文档和版本的组合键读取历史行，再校验行内身份，防止混用其他文档的快照。
function readVersion(context, documentId, versionId, ready) {
  listen(context, context.assets.get(historyKey(documentId, versionId)), row => ready(readStoredVersion(row, documentId, versionId)))
}

// 验证存储行的来源、名称、原因、时间和正文契约；损坏历史返回明确错误，不尝试半恢复。
function readStoredVersion(row, documentId, versionId) {
  if (!row) throw repositoryError("这个历史版本不存在，请刷新版本列表", "DOCUMENT_VERSION_NOT_FOUND")
  const version = row.version
  if (row.id !== historyKey(documentId, versionId) || !version || version.id !== versionId || version.documentId !== documentId ||
    typeof version.label !== "string" || version.label.length > 100 || !["manual", "before-restore"].includes(version.reason) ||
    typeof version.createdAt !== "string" || !Number.isFinite(Date.parse(version.createdAt)) ||
    !Number.isInteger(version.sourceStorageVersion) || version.sourceStorageVersion < 0 || version.document?.id !== documentId) {
    throw repositoryError("历史版本记录无效，请保留现有文档并导出备份", "DOCUMENT_VERSION_INVALID")
  }
  try { validateDocument(version.document) }
  catch (failure) { throw repositoryError("历史版本内容无效：" + failure.message, "DOCUMENT_VERSION_INVALID") }
  return version
}

// 只在 IDB 请求的同步成功回调中继续排队，避免等待异步 Blob 操作使事务提前结束。
// blob.size/type 可同步检查，字节复制仍交给 IDB 的结构化克隆；资源 URL 不进入持久记录。
function readResources(context, document, key, ready) {
  const assets = new Map()
  // 资源读取并行排队，remaining 只在合法 Blob 到达后递减；零资源也需要立即继续后续流程。
  let remaining = document.assets.length
  if (!remaining) {
    ready(assets)
    return
  }
  for (const asset of document.assets) {
    listen(context, context.assets.get(key(asset.id)), row => {
      const blob = row?.blob
      if (!(blob instanceof Blob) || blob.size !== asset.byteLength || blob.type !== asset.mimeType) {
        throw repositoryError(`资源「${asset.fileName}」缺失或类型不匹配，历史操作未完成`, "DOCUMENT_ASSET_MISSING")
      }
      assets.set(asset.id, { ...asset, blob })
      remaining -= 1
      if (!remaining) ready(assets)
    })
  }
}

// 把成功回调中的业务校验异常转换为整笔事务回滚；首次失败后其他读取回调不再推进写入。
function listen(context, request, ready) {
  request.onsuccess = () => {
    if (context.failure) return
    try { ready(request.result) }
    catch (failure) { context.abort(failure) }
  }
}

// 封装双仓库事务生命周期，只在 oncomplete 交付结果；请求错误和同步异常共用首个失败原因。
async function runTransaction(mode, start) {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["documents", "assets"], mode)
    const context = {
      documents: transaction.objectStore("documents"),
      assets: transaction.objectStore("assets"),
      result: null,
      failure: null,
      abort(failure) {
        // 首次失败保留具体原因；其余被取消的请求不再次 abort 或覆盖错误。
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

// 入口检查短 ID，拒绝把任意字符串拼入前缀键；错误码区分文档与历史版本寻址失败。
function checkIds(documentId, versionId) {
  if (typeof documentId !== "string" || !ID_PATTERN.test(documentId)) throw repositoryError("文档 ID 无效", "DOCUMENT_NOT_FOUND")
  if (versionId !== undefined && (typeof versionId !== "string" || !ID_PATTERN.test(versionId))) {
    throw repositoryError("历史版本 ID 无效", "DOCUMENT_VERSION_NOT_FOUND")
  }
}

// 保留可读消息并附业务错误码，调用方可区分冲突、资源缺失和存储限制。
function repositoryError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

// 写操作必须提供已提交的非负存储版本，不能用编辑 revision 或缺省值替代乐观锁。
function checkBaseVersion(baseVersion) {
  if (!Number.isInteger(baseVersion) || baseVersion < 0) {
    throw repositoryError("缺少有效的文档存储版本，请刷新读取最新文档", "DOCUMENT_CONFLICT")
  }
}

// 优先保留业务错误，配额错误转换为备份提示，其余底层失败统一为历史操作错误。
function normalizeError(error) {
  if (error?.name === "QuotaExceededError") return repositoryError("浏览器存储空间不足，历史操作未完成，请先导出备份", "DOCUMENT_STORAGE_QUOTA")
  if (typeof error?.code === "string" && error instanceof Error) return error
  return repositoryError(error?.message || "本地历史版本操作失败，请导出备份后重试", "DOCUMENT_HISTORY_FAILED")
}
