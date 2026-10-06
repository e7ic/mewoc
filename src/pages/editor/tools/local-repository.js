/**
 * 负责浏览器 IndexedDB 的文档与资源持久化，以及文档库重命名、回收、恢复和复制。
 * 持久 storageVersion 实施乐观锁；事务全部提交后才返回成功，临时 URL 与编辑 revision 不进入数据库。
 */
import { createId } from "./create-id.js"

// 同一页面复用数据库连接；打开失败或其他标签页升级版本后清空，允许后续重试。
let databasePromise = null

// 复用同一页面的打开 Promise，第一次打开创建两张仓库；错误或版本变更清空缓存以允许重试。
export function getDatabase() {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open("mewoc", 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore("documents", { keyPath: "id" })
      request.result.createObjectStore("assets", { keyPath: "id" })
    }
    request.onsuccess = () => {
      const database = request.result
      // blocked 已向调用方报错，迟到的成功连接不能再留在后台阻碍数据库升级。
      if (blocked) {
        database.close()
        return
      }
      database.onversionchange = () => {
        database.close()
        databasePromise = null
      }
      resolve(database)
    }
    request.onerror = () => {
      databasePromise = null
      reject(new Error("无法打开本地存储，请检查浏览器存储权限"))
    }
    request.onblocked = () => {
      blocked = true
      databasePromise = null
      reject(new Error("本地数据库正在升级，请关闭其他 Mewoc 标签页后重试"))
    }
  })
  return databasePromise
}

// deletedAt 放在持久记录上，便携文档的 schemaVersion 和正文契约不受回收站影响。
// 首批记录没有 deletedAt，继续视为正常文档，无需升级数据库或重写已有资源。
export async function getDocuments({ deleted = false } = {}) {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("documents", "readonly")
    const request = transaction.objectStore("documents").getAll()
    transaction.oncomplete = () => resolve(request.result
      .filter(record => Boolean(record.deletedAt) === deleted)
      .sort((a, b) => b.document.updatedAt.localeCompare(a.document.updatedAt)))
    transaction.onerror = () => reject(new Error("读取本地文档失败，请重试"))
    transaction.onabort = () => reject(new Error("本地文档读取已中止，请重试"))
  })
}

// 常规编辑只取得活跃文档，回收站操作可显式读取已回收记录；不存在或不可见时统一返回 null。
export async function getLocalDocument(id, { includeDeleted = false } = {}) {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("documents", "readonly")
    const request = transaction.objectStore("documents").get(id)
    transaction.oncomplete = () => {
      const record = request.result
      resolve(record && (includeDeleted || !record.deletedAt) ? record : null)
    }
    transaction.onerror = () => reject(new Error("读取本地文档失败，请重试"))
    transaction.onabort = () => reject(new Error("本地文档读取已中止，请重试"))
  })
}

// 读取完整资源集后才交付会话；此层只返回 Blob，临时 URL 由会话创建并释放。
export async function getDocumentAssets(document) {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("assets", "readonly")
    const requests = document.assets.map(asset => ({ asset, request: transaction.objectStore("assets").get(`${document.id}:${asset.id}`) }))
    transaction.oncomplete = () => {
      const assets = new Map()
      for (const { asset, request } of requests) {
        if (!request.result) {
          reject(new Error(`资源「${asset.fileName}」的本地资源缺失`))
          return
        }
        assets.set(asset.id, { ...asset, blob: request.result.blob })
      }
      resolve(assets)
    }
    transaction.onerror = () => reject(new Error("读取文档资源失败，请重试"))
    transaction.onabort = () => reject(new Error("文档资源读取已中止，请重试"))
  })
}

/**
 * 在同一个读写事务中比较版本、更新资源和保存正文，任何一步失败都整体回滚。
 * document.assets 是当前快照的引用清单，assets 则还可能保留供撤销使用的旧 Blob。
 * baseVersion 必须来自上一次成功提交；版本不一致时拒绝覆盖其他标签页的内容。
 */
export async function saveLocalDocument(document, assets, baseVersion) {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["documents", "assets"], "readwrite")
    const documents = transaction.objectStore("documents")
    const storedAssets = transaction.objectStore("assets")
    const request = documents.get(document.id)
    let failure = null
    request.onsuccess = () => {
      const version = request.result?.storageVersion ?? 0
      if (version !== baseVersion) {
        failure = createConflictError()
        transaction.abort()
        return
      }
      // 回收是持久状态；即使另一标签页已拿到最新版本，也不能由自动保存复活文档。
      if (request.result?.deletedAt) {
        failure = createRepositoryError("文档已移入回收站，请在文档库中恢复后再编辑", "DOCUMENT_TRASHED")
        transaction.abort()
        return
      }
      try {
        const references = new Set(document.assets.map(asset => asset.id))
        // 只回收已提交版本的旧引用；会话 Blob 仍保留，撤销时可以重新写回。
        for (const asset of request.result?.document.assets || []) {
          if (!references.has(asset.id)) storedAssets.delete(`${document.id}:${asset.id}`)
        }
        for (const asset of document.assets) {
          const entry = assets.get(asset.id)
          if (!entry?.blob || entry.blob.size !== asset.byteLength || entry.blob.type !== asset.mimeType) {
            failure = new Error(`资源「${asset.fileName}」尚未就绪或类型不匹配，文档未保存`)
            transaction.abort()
            return
          }
          // 资源 ID 在便携文件内稳定；数据库按文档隔离，导入变体不会覆盖其他文档的资源。
          storedAssets.put({ id: `${document.id}:${asset.id}`, blob: entry.blob })
        }
        documents.put({ id: document.id, document, storageVersion: version + 1 })
      } catch (error) {
        failure = getSaveError(error)
        transaction.abort()
      }
    }
    // 单个 put 成功不等于整个事务成功，只在 oncomplete 后允许界面显示已保存。
    transaction.oncomplete = () => resolve({ storageVersion: baseVersion + 1 })
    transaction.onabort = () => reject(failure || getSaveError(transaction.error))
    transaction.onerror = event => {
      failure = failure || getSaveError(event.target.error)
    }
  })
}

// 标题规范化后通过统一版本事务修改，更新文档时间并提高存储版本，让跨标签页感知变化。
export async function renameLocalDocument(id, title, baseVersion) {
  const trimmedTitle = typeof title === "string" ? title.trim() : ""
  if (!trimmedTitle || trimmedTitle.length > 100) throw new Error("请输入 1 到 100 个字符的文档标题")
  return updateLocalDocument(id, baseVersion, {}, record => ({
    ...record,
    document: { ...record.document, title: trimmedTitle, updatedAt: new Date().toISOString() },
    storageVersion: (record.storageVersion ?? 0) + 1
  }))
}

// 回收仅写删除标记和更新时间，不删除正文及资源，因此可恢复且不会破坏会话中的 Blob。
export async function trashLocalDocument(id, baseVersion) {
  return updateLocalDocument(id, baseVersion, {}, record => {
    const time = new Date().toISOString()
    return {
      ...record,
      deletedAt: time,
      document: { ...record.document, updatedAt: time },
      storageVersion: (record.storageVersion ?? 0) + 1
    }
  })
}

// 只对回收记录去掉删除标记，保留原文档 ID、创建时间和资源，同时生成新的提交版本。
export async function restoreLocalDocument(id, baseVersion) {
  return updateLocalDocument(id, baseVersion, { restore: true }, record => {
    const restored = {
      ...record,
      document: { ...record.document, updatedAt: new Date().toISOString() },
      storageVersion: (record.storageVersion ?? 0) + 1
    }
    delete restored.deletedAt
    return restored
  })
}

// 复制内容深克隆并建立新的文档身份与时间，标题预留后缀长度；资源字节在统一事务中复制到新键。
export async function duplicateLocalDocument(id, baseVersion) {
  return updateLocalDocument(id, baseVersion, { duplicate: true }, record => {
    const time = new Date().toISOString()
    const suffix = " - 副本"
    const document = structuredClone(record.document)
    document.id = createId()
    document.title = document.title.slice(0, 100 - suffix.length) + suffix
    document.createdAt = time
    document.updatedAt = time
    return { id: document.id, document, storageVersion: 1 }
  })
}

/**
 * 库操作与自动保存共享同一条版本规则：读取和变更必须在同一个读写事务内完成。
 * 复制同时锁定资源仓库，资源在新文档键下保存；任一读取或写入失败都撤销整个副本。
 * 回收/恢复不删除 Blob，因此不需要打开资源仓库，也不会干扰正在编辑的会话资源。
 */
async function updateLocalDocument(id, baseVersion, options, change) {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(options.duplicate ? ["documents", "assets"] : ["documents"], "readwrite")
    const documents = transaction.objectStore("documents")
    const request = documents.get(id)
    let failure = null
    let result = null
    // 业务分支主动中止时记录具体错误，事务 onabort 优先展示它，避免只显示底层取消信息。
    const abort = error => {
      failure = error
      transaction.abort()
    }
    request.onsuccess = () => {
      const record = request.result
      if (!record) {
        abort(createRepositoryError("这份本地文档不存在，请刷新文档库", "DOCUMENT_NOT_FOUND"))
        return
      }
      if ((record.storageVersion ?? 0) !== baseVersion) {
        abort(createConflictError())
        return
      }
      if (record.deletedAt && !options.restore) {
        abort(createRepositoryError("文档已移入回收站，请在文档库中恢复后再编辑", "DOCUMENT_TRASHED"))
        return
      }
      if (!record.deletedAt && options.restore) {
        abort(createRepositoryError("文档已在文档库中，无需恢复", "DOCUMENT_NOT_TRASHED"))
        return
      }
      try {
        result = change(record)
        if (options.duplicate) {
          const storedAssets = transaction.objectStore("assets")
          // 复制资源仍在 IDB 同步回调中排队，不 await 字节读取；每份 Blob 核对声明后才写新文档键。
          for (const asset of record.document.assets) {
            const assetRequest = storedAssets.get(`${record.id}:${asset.id}`)
            assetRequest.onsuccess = () => {
              const blob = assetRequest.result?.blob
              if (!blob || blob.size !== asset.byteLength || blob.type !== asset.mimeType) {
                abort(createRepositoryError(`资源「${asset.fileName}」缺失或类型不匹配，文档未复制`, "DOCUMENT_ASSET_MISSING"))
                return
              }
              try {
                storedAssets.add({ id: `${result.id}:${asset.id}`, blob })
              } catch (error) {
                abort(getSaveError(error))
              }
            }
          }
          // add 避免罕见的随机 ID 重复覆盖已有文档；失败会连同资源一起回滚。
          documents.add(result)
        } else {
          documents.put(result)
        }
      } catch (error) {
        abort(getSaveError(error))
      }
    }
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = () => reject(failure || getSaveError(transaction.error))
    transaction.onerror = event => {
      failure = failure || getSaveError(event.target.error)
    }
  })
}

// 可读错误附业务码，调用方可针对冲突、回收状态和资源缺失采取不同界面处理。
function createRepositoryError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

// 库操作和自动保存使用同一冲突提示，拒绝覆盖后提醒先备份当前会话再读取最新版本。
function createConflictError() {
  return createRepositoryError("另一标签页已保存或变更这份文档。请先导出当前副本，再刷新页面读取已保存版本", "DOCUMENT_CONFLICT")
}

// 把配额不足与其他存储失败转换成可展示的备份/重试提示，避免底层浏览器异常直接泄露给界面。
function getSaveError(error) {
  return new Error(error?.name === "QuotaExceededError"
    ? "浏览器存储空间不足，请导出文件备份后释放空间并重试"
    : "本地保存失败，请导出文件备份后重试")
}
