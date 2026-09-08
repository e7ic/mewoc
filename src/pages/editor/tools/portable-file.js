import { validateDocument, getReferencedAssetIds } from "./document-schema.js"
import { readBlobDataUrl, validateImageBlob } from "./image-assets.js"
import { MAX_FILE_BYTES } from "../constants/editor-constants.js"
import { createId } from "./create-id.js"

/**
 * 生成可跨浏览器传递的 Mewoc 文件：正文引用保持 assetId，原始 Blob 转为内嵌 data URL。
 * 仅导出当前正文引用；逐项核对实际类型与字节数，缺资源时拒绝生成不完整备份。
 */
export async function createPortableFile(document, assets) {
  validateDocument(document)
  const assetData = {}
  const ids = new Set(getReferencedAssetIds(document.content))
  const references = document.assets.filter(asset => ids.has(asset.id))
  for (const asset of references) {
    const entry = assets.get(asset.id)
    const label = asset.kind === "attachment" ? "附件" : "图片"
    if (!entry?.blob) throw new Error(`${label}「${asset.fileName}」资源缺失，无法导出完整文件`)
    if (entry.blob.size !== asset.byteLength || entry.blob.type !== asset.mimeType) throw new Error(`${label}「${asset.fileName}」资源与声明不匹配`)
    if (asset.kind !== "attachment") await validateImageBlob(entry.blob)
    assetData[asset.id] = await readBlobDataUrl(entry.blob)
  }
  return { format: "mewoc", formatVersion: 1, document: { ...document, assets: references }, assetData }
}

// 文件、文档结构和所有二进制资源全部校验成功后才返回新记录，调用方随后创建会话 URL。
export async function readPortableFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error("文档文件不能超过 32 MiB")
  let source
  try {
    source = JSON.parse(await file.text())
  } catch {
    throw new Error("无法读取文件，请选择有效的 .mewoc.json 文档")
  }
  if (source?.format !== "mewoc" || source.formatVersion !== 1) throw new Error("不是当前支持的 Mewoc 文档格式")
  validateDocument(source.document)
  const assets = new Map()
  for (const asset of source.document.assets) {
    const label = asset.kind === "attachment" ? "附件" : "图片"
    const dataUrl = source.assetData?.[asset.id]
    const prefix = `data:${asset.mimeType};base64,`
    if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) throw new Error(`${label}「${asset.fileName}」内容缺失或类型不匹配`)
    const encoded = dataUrl.slice(prefix.length)
    // 先按声明字节数限制 base64 长度，再解码，避免伪造小文件元数据造成额外分配。
    const padding = (3 - asset.byteLength % 3) % 3
    if (encoded.length !== Math.ceil(asset.byteLength / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      (encoded.match(/=+$/)?.[0].length || 0) !== padding) {
      throw new Error(`${label}编码或大小无效`)
    }
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    const blob = new Blob([bytes], { type: asset.mimeType })
    if (blob.size !== asset.byteLength) throw new Error(`${label}「${asset.fileName}」大小不匹配`)
    if (asset.kind !== "attachment") await validateImageBlob(blob)
    assets.set(asset.id, { ...asset, blob })
  }
  // 导入作为新文档，不覆盖源文件中同 ID 的本地版本。
  return {
    document: { ...source.document, id: createId(), updatedAt: new Date().toISOString() },
    storageVersion: 0,
    assets
  }
}
