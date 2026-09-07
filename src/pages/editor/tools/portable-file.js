import { validateDocument, getReferencedAssetIds } from "./document-schema.js"
import { readBlobDataUrl, validateImageBlob } from "./image-assets.js"
import { MAX_FILE_BYTES } from "../constants/editor-constants.js"

export async function createPortableFile(document, assets) {
  validateDocument(document)
  const assetData = {}
  for (const id of getReferencedAssetIds(document.content)) {
    const entry = assets.get(id)
    if (!entry) throw new Error("部分图片缺失，无法导出完整文件")
    assetData[id] = await readBlobDataUrl(entry.blob)
  }
  return { format: "mewoc", formatVersion: 1, document, assetData }
}

export async function readPortableFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error("文档文件不能超过 32 MiB")
  let source
  try {
    source = JSON.parse(await file.text())
  } catch {
    throw new Error("无法读取文件，请选择有效的 .mewoc.json 文档")
  }
  if (source.format !== "mewoc" || source.formatVersion !== 1) throw new Error("不是当前支持的 Mewoc 文档格式")
  validateDocument(source.document)
  const assets = new Map()
  for (const asset of source.document.assets) {
    const dataUrl = source.assetData?.[asset.id]
    const prefix = `data:${asset.mimeType};base64,`
    if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) throw new Error(`图片「${asset.fileName}」内容缺失`)
    const encoded = dataUrl.slice(prefix.length)
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("图片编码无效")
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    const blob = new Blob([bytes], { type: asset.mimeType })
    if (blob.size !== asset.byteLength) throw new Error(`图片「${asset.fileName}」大小不匹配`)
    await validateImageBlob(blob)
    assets.set(asset.id, { ...asset, blob })
  }
  // 导入作为新文档，不覆盖源文件中同 ID 的本地版本。
  return {
    document: { ...source.document, id: crypto.randomUUID(), updatedAt: new Date().toISOString() },
    storageVersion: 0,
    assets
  }
}

