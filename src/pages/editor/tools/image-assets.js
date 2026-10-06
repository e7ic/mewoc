/**
 * 处理图片文件的类型初检、真实解码、初始排版尺寸与 data URL 编码。
 * 资源保留原始字节，宽高只影响正文排版；临时 URL 成功交给会话，失败在本模块立即回收。
 */
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "../constants/editor-constants.js"
import { createId } from "./create-id.js"

// MIME 与头部特征需匹配；这里只做文件类型/大小初检，实际图片解码在 readImageFile 中执行。
export async function validateImageBlob(blob) {
  if (!IMAGE_TYPES.includes(blob.type) || blob.size <= 0 || blob.size > MAX_IMAGE_BYTES) {
    throw new Error("请选择不超过 5 MiB 的 PNG、JPEG 或 WebP 图片")
  }
  // 仅读取头部做轻量格式验证，避免为了识别类型复制整幅图片；随后仍必须执行浏览器解码。
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  const valid = { "image/png": png, "image/jpeg": jpeg, "image/webp": webp }
  if (!valid[blob.type]) throw new Error("图片内容与文件类型不一致")
}

// 返回的宽高是初始排版尺寸（px），不重采样原图；成功 URL 交给调用方持有，失败立即回收。
export async function readImageFile(file) {
  await validateImageBlob(file)
  const url = URL.createObjectURL(file)
  const image = new Image()
  image.src = url
  try {
    await image.decode()
    // 限制解码像素量，避免小体积但极大尺寸的图片占满内存。
    if (image.naturalWidth * image.naturalHeight > 40000000) throw new Error("图片像素过多，请先缩小图片")
    const width = Math.min(520, image.naturalWidth)
    return {
      id: createId(),
      fileName: file.name.slice(0, 255),
      mimeType: file.type,
      byteLength: file.size,
      blob: file,
      url,
      width,
      height: Math.round(width * image.naturalHeight / image.naturalWidth)
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw new Error(error.message === "图片像素过多，请先缩小图片" ? error.message : "图片无法解码，请选择其他图片")
  }
}

// 将任意已验证资源编码为便携文件可内嵌的地址，FileReader 的异步错误转换为统一导出提示。
export function readBlobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error("资源编码失败，请重试导出"))
    reader.readAsDataURL(blob)
  })
}
