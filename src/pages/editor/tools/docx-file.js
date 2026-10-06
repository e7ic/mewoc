/**
 * Word 导出轻量入口：先固定并校验文档和资源，再动态加载重型 SDK 转换器。
 * 快照与 Blob 引用绑定在首个异步边界之前，导出期间继续编辑或切换会话不会串入新内容。
 */
import { validateDocument } from "./document-schema.js"

// 在第一个 await 前固定正文、元信息和 Blob 引用；资源 URL 随会话销毁也不影响转换。
// Blob 本身不可变，无需复制图片字节；不把编辑器实例或存储状态带入转换器。
export async function createDocumentDocx(source, assets, signal) {
  signal?.throwIfAborted()
  const snapshot = validateDocument(structuredClone(source))
  // 只收集快照声明的资产，并核对 Blob 大小/MIME；缺失资源在启动转换前直接报错。
  const references = new Map(snapshot.assets.map(asset => {
    const blob = assets.get(asset.id)?.blob
    if (!blob || blob.size !== asset.byteLength || blob.type !== asset.mimeType) throw new Error(`资源「${asset.fileName}」缺失或声明不匹配`)
    return [asset.id, { ...asset, blob }]
  }))
  // SDK 按需载入，正常编辑不承担导出模块成本；加载结束后检查取消防止继续旧任务。
  const converter = await import("./docx-export.js")
  signal?.throwIfAborted()
  return converter.createDocumentDocx(snapshot, references, signal)
}
