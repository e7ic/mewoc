import { MAX_ATTACHMENT_BYTES } from "../constants/editor-constants.js"
import { createId } from "./create-id.js"

export function validateAttachmentMetadata(asset) {
  if (typeof asset.fileName !== "string" || !asset.fileName.trim() || asset.fileName.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(asset.fileName)) {
    throw new Error("附件文件名无效，最多 255 个字符且不能包含路径或控制字符")
  }
  if (typeof asset.mimeType !== "string" || asset.mimeType.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(asset.mimeType)) {
    throw new Error("附件文件类型无效")
  }
  if (!Number.isInteger(asset.byteLength) || asset.byteLength < 0 || asset.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error("单个附件不能超过 5 MiB")
  }
}

// 附件可为零字节文件；仅验证元数据与实际读取长度，不解析或执行文件内容。
// 返回的 Blob 保留原始 MIME，下载用 URL 的 MIME 单独由 createDocumentAssetUrl 处理。
export async function readAttachmentFile(file) {
  const asset = {
    id: createId(), kind: "attachment", fileName: file.name,
    mimeType: file.type || "application/octet-stream", byteLength: file.size
  }
  validateAttachmentMetadata(asset)
  let bytes
  try {
    bytes = await file.arrayBuffer()
  } catch {
    throw new Error(`附件「${asset.fileName}」读取失败，请重新选择文件`)
  }
  if (bytes.byteLength !== asset.byteLength) throw new Error("附件读取大小不一致，请重新选择文件")
  return { ...asset, blob: new Blob([bytes], { type: asset.mimeType }) }
}

export function createDocumentAssetUrl(asset) {
  // 附件只用于下载；即使原文件是 HTML / SVG，也不让 object URL 按活动内容解释。
  const blob = asset.kind === "attachment" ? asset.blob.slice(0, asset.blob.size, "application/octet-stream") : asset.blob
  return URL.createObjectURL(blob)
}

export function getAttachmentFileName(fileName) {
  return fileName.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/, "") || "附件"
}

export function formatAttachmentSize(byteLength) {
  if (byteLength < 1024) return `${byteLength} B`
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KiB`
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MiB`
}

export function getAttachmentText(asset) {
  if (!asset || asset.kind !== "attachment") return "[附件资源缺失]"
  return `[附件：${asset.fileName}（${formatAttachmentSize(asset.byteLength)}）]`
}
