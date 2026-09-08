let databasePromise = null

function getDatabase() {
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

export async function getDocuments() {
  const database = await getDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("documents", "readonly")
    const request = transaction.objectStore("documents").getAll()
    transaction.oncomplete = () => resolve(request.result.sort((a, b) => b.document.updatedAt.localeCompare(a.document.updatedAt)))
    transaction.onerror = () => reject(new Error("读取本地文档失败，请重试"))
    transaction.onabort = () => reject(new Error("本地文档读取已中止，请重试"))
  })
}

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
        failure = new Error("另一标签页已保存这份文档。请先导出当前副本，再刷新页面读取已保存版本")
        failure.code = "DOCUMENT_CONFLICT"
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
    transaction.oncomplete = () => resolve({ storageVersion: baseVersion + 1 })
    transaction.onabort = () => reject(failure || getSaveError(transaction.error))
    transaction.onerror = event => {
      failure = failure || getSaveError(event.target.error)
    }
  })
}

function getSaveError(error) {
  return new Error(error?.name === "QuotaExceededError"
    ? "浏览器存储空间不足，请导出文件备份后释放空间并重试"
    : "本地保存失败，请导出文件备份后重试")
}
