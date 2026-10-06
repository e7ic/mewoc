/**
 * 管理附件从用户文件到会话资源的转换，以及下载名、体积和正文占位文字。
 * 附件不参与内容解析；元数据负责文件契约，Blob 保存原字节，临时 URL 由持有它的会话释放。
 */
import { MAX_ATTACHMENT_BYTES } from "../constants/editor-constants.js"
import { createId } from "./create-id.js"

// 在读取字节和接受外部文档前检查附件声明；失败抛出可直接展示的错误。
// 文件名只表示名称，拒绝路径分隔符；MIME 与体积限制确保资源能按统一契约保存。
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
  // 先验证声明再分配读取缓冲区；读取失败与读取长度变化分别报告，避免保存不完整附件。
  let bytes
  try {
    bytes = await file.arrayBuffer()
  } catch {
    throw new Error(`附件「${asset.fileName}」读取失败，请重新选择文件`)
  }
  if (bytes.byteLength !== asset.byteLength) throw new Error("附件读取大小不一致，请重新选择文件")
  return { ...asset, blob: new Blob([bytes], { type: asset.mimeType }) }
}

// 生成当前浏览器会话可访问的地址，不把地址写入便携文件或数据库。
export function createDocumentAssetUrl(asset) {
  // 附件只用于下载；即使原文件是 HTML / SVG，也不让 object URL 按活动内容解释。
  const blob = asset.kind === "attachment" ? asset.blob.slice(0, asset.blob.size, "application/octet-stream") : asset.blob
  return URL.createObjectURL(blob)
}

// 下载前替换主流文件系统不允许的字符并移除结尾点/空格；清理为空时提供可用名称。
export function getAttachmentFileName(fileName) {
  return fileName.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/, "") || "附件"
}

// 按二进制单位显示已验证的字节数，小文件保留原字节，大文件统一一位小数。
export function formatAttachmentSize(byteLength) {
  if (byteLength < 1024) return `${byteLength} B`
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KiB`
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MiB`
}

// 供无法保留附件交互的输出使用可读占位；资源丢失时保留缺失提示而不伪造文件信息。
export function getAttachmentText(asset) {
  if (!asset || asset.kind !== "attachment") return "[附件资源缺失]"
  return `[附件：${asset.fileName}（${formatAttachmentSize(asset.byteLength)}）]`
}
