import { validateDocument } from "./document-schema.js"

// 在第一个 await 前固定正文、元信息和 Blob 引用；资源 URL 随会话销毁也不影响转换。
// Blob 本身不可变，无需复制图片字节；不把编辑器实例或存储状态带入转换器。
export async function createDocumentDocx(source, assets, signal) {
  signal?.throwIfAborted()
  const snapshot = validateDocument(structuredClone(source))
  const references = new Map(snapshot.assets.map(asset => {
    const blob = assets.get(asset.id)?.blob
    if (!blob || blob.size !== asset.byteLength || blob.type !== asset.mimeType) throw new Error(`资源「${asset.fileName}」缺失或声明不匹配`)
    return [asset.id, { ...asset, blob }]
  }))
  const converter = await import("./docx-export.js")
  signal?.throwIfAborted()
  return converter.createDocumentDocx(snapshot, references, signal)
}
