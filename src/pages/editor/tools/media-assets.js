/**
 * 本地音视频资源的声明、容器与原生播放器校验。只接受可播放的有限本地 Blob，保留原始字节。
 * 校验阶段不会登记资源；成功的 URL 交由文档会话持有，失败、取消或超时立即释放。
 */
import { MAX_MEDIA_BYTES, MEDIA_TYPES, MEDIA_LOAD_TIMEOUT } from "../constants/editor-constants.js"
import { createId } from "./create-id.js"
import { formatAttachmentSize, getAttachmentFileName } from "./attachment-assets.js"

const getMediaKind = mimeType => Object.keys(MEDIA_TYPES).find(kind => MEDIA_TYPES[kind].includes(mimeType))
const isKind = kind => kind === "audio" || kind === "video"
const abortError = () => new DOMException("媒体读取已取消", "AbortError")
const checkAbort = signal => { if (signal?.aborted) throw abortError() }
const ascii = (bytes, start, count) => String.fromCharCode(...bytes.slice(start, start + count))

// 操作系统可把 WAV 声明为 x-wav 或完全不提供 MIME。只归一化已知别名/受控扩展名，
// 后续仍必须核对对应容器头和原生解码，绝不把 text/plain 等冲突声明按扩展名强制接受。
export function getMediaFileMetadata(file, kind) {
  let mimeType = file?.type || ""
  const aliases = { "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/x-pn-wav": "audio/wav", "audio/mp3": "audio/mpeg" }
  mimeType = aliases[mimeType] || mimeType
  const extension = typeof file?.name === "string" ? file.name.split(".").at(-1).toLowerCase() : ""
  const byExtension = { mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm" }
  if (!mimeType) mimeType = byExtension[extension] || ""
  const metadata = { kind: kind || getMediaKind(mimeType), fileName: file?.name, mimeType, byteLength: file?.size }
  validateMediaMetadata(metadata)
  return metadata
}

// 纯元数据验证供 schema/持久化入口复用，不依赖 document，也不创建 URL 或播放器。
export function validateMediaMetadata(asset) {
  if (!asset || typeof asset.fileName !== "string" || !asset.fileName.trim() || asset.fileName.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(asset.fileName)) {
    throw new Error("媒体文件名无效，最多 255 个字符且不能包含路径或控制字符")
  }
  if (!isKind(asset.kind) || !MEDIA_TYPES[asset.kind].includes(asset.mimeType)) throw new Error("请选择 MP3、WAV 音频或 MP4、WebM 视频，文件类型须与资源种类一致")
  if (!Number.isInteger(asset.byteLength) || asset.byteLength <= 0 || asset.byteLength > MAX_MEDIA_BYTES) throw new Error("单个音视频文件须大于 0 且不能超过 5 MiB")
}

// MP3 可由 ID3v2 开头或直接从 MPEG 音频帧开始；原生解码仍负责判定实际编码是否可播放。
function isMp3(bytes) {
  if (bytes.length < 4) return false
  if (ascii(bytes, 0, 3) === "ID3") {
    if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3]) || bytes[4] === 255 || bytes.slice(6, 10).some(value => value > 127)) return false
    const tagLength = bytes.slice(6, 10).reduce((size, value) => size * 128 + value, 0)
    return tagLength + 10 < bytes.length
  }
  return bytes[0] === 255 && (bytes[1] & 224) === 224 && (bytes[1] & 24) !== 8 && (bytes[1] & 6) !== 0 &&
    (bytes[2] & 240) !== 240 && (bytes[2] & 12) !== 12
}

// 遍历 RIFF 自描述的块，拒绝伪造 WAVE 标签、越界块与没有声音数据的文件。
function isWav(bytes) {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = view.getUint32(4, true) + 8
  if (end > bytes.length || end < 44) return false
  let format = false
  let data = false
  for (let position = 12; position + 8 <= end;) {
    const length = view.getUint32(position + 4, true)
    const next = position + 8 + length
    if (next > end) return false
    const name = ascii(bytes, position, 4)
    if (name === "fmt ") {
      if (length < 16) return false
      format = view.getUint16(position + 10, true) > 0 && view.getUint32(position + 12, true) > 0
    }
    if (name === "data" && length > 0) data = true
    position = next + length % 2
  }
  return format && data
}

function isMp4(bytes) {
  if (bytes.length < 20 || ascii(bytes, 4, 4) !== "ftyp") return false
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (size < 16 || size > bytes.length || size % 4 !== 0) return false
  const brands = [ascii(bytes, 8, 4)]
  for (let position = 16; position + 4 <= size; position += 4) brands.push(ascii(bytes, position, 4))
  return brands.some(brand => /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash)$/.test(brand))
}

// EBML 的 size 去掉长度标记，ID 保留标记；只遍历有限的头部，确认 DocType 真的是 webm。
function ebmlValue(bytes, start, identifier = false) {
  let marker = 128
  let length = 1
  while (length <= 8 && !(bytes[start] & marker)) { marker >>= 1; length += 1 }
  if (length > (identifier ? 4 : 8) || start + length > bytes.length) return null
  let value = identifier ? bytes[start] : bytes[start] & (marker - 1)
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[start + index]
  return Number.isSafeInteger(value) ? { value, length } : null
}
function isWebm(bytes) {
  if (bytes.length < 12 || ![26, 69, 223, 163].every((byte, index) => bytes[index] === byte)) return false
  const header = ebmlValue(bytes, 4)
  if (!header || header.value > 65536) return false
  const end = 4 + header.length + header.value
  if (end + 4 > bytes.length) return false
  let webm = false
  for (let position = 4 + header.length; position < end;) {
    const id = ebmlValue(bytes, position, true)
    const size = id && ebmlValue(bytes, position + id.length)
    if (!size) return false
    const content = position + id.length + size.length
    const next = content + size.value
    if (next > end) return false
    if (id.value === 17026) webm = ascii(bytes, content, size.value) === "webm"
    position = next
  }
  return webm && [24, 83, 128, 103].every((byte, index) => bytes[end + index] === byte)
}

async function readValidatedBytes(blob, kind, mimeType = blob?.type) {
  if (!blob || !isKind(kind) || !MEDIA_TYPES[kind].includes(mimeType) || !Number.isInteger(blob.size) || blob.size <= 0 || blob.size > MAX_MEDIA_BYTES) {
    throw new Error("请选择不超过 5 MiB 的 MP3、WAV 音频或 MP4、WebM 视频")
  }
  let buffer
  try { buffer = await blob.arrayBuffer() } catch { throw new Error("媒体文件读取失败，请重新选择文件") }
  if (buffer.byteLength !== blob.size) throw new Error("媒体读取大小不一致，请重新选择文件")
  const bytes = new Uint8Array(buffer)
  const valid = { "audio/mpeg": isMp3, "audio/wav": isWav, "video/mp4": isMp4, "video/webm": isWebm }
  if (!valid[mimeType](bytes)) throw new Error("媒体内容与文件类型不一致或容器损坏")
  return bytes
}

// 外部文档先验证真实字节和容器头；该入口不依赖浏览器解码，便于持久化与便携文件复用。
export async function validateMediaBlob(blob, { kind = getMediaKind(blob?.type) } = {}) {
  await readValidatedBytes(blob, kind)
}

/**
 * loadedmetadata 表示原生解码器已识别资源，不以扩展名或 MIME 声明代替真实读取。
 * 临时播放器绝不 autoplay；video 还需真实画面尺寸，拒绝仅含声音的伪视频容器。
 * createMedia/timeoutMs 仅为生命周期测试控制原生事件入口，产品调用保持默认值。
 */
function createPlayableUrl(blob, kind, { signal, createMedia = name => document.createElement(name), timeoutMs = MEDIA_LOAD_TIMEOUT } = {}) {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    let url = null
    let player = null
    let timer = null
    let settled = false
    const clean = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
      player?.removeEventListener("loadedmetadata", loaded)
      player?.removeEventListener("error", failed)
      // 停止临时播放器的读取，URL 成功后仍留给正文播放器；失败路径单独回收 URL。
      if (player) {
        try { player.removeAttribute("src"); player.load() } catch { /* 原生播放器可能已随页面销毁。 */ }
      }
    }
    const finish = error => {
      if (settled) return
      settled = true
      clean()
      if (error) { if (url) URL.revokeObjectURL(url); reject(error) } else resolve(url)
    }
    const cancel = () => finish(abortError())
    const failed = () => finish(new Error("当前浏览器无法播放此媒体，请选择其他 MP3、WAV、MP4 或 WebM 文件"))
    const loaded = () => {
      // MediaRecorder 的有限 WebM Blob 常无 duration 字段，原生会报告 Infinity；这表示未知时长，
      // 不等于远端无限流。已验证有限容器、原生 metadata 和画面后允许它，不伪造或显示总时长。
      if (typeof player.duration !== "number" || Number.isNaN(player.duration) || player.duration <= 0 || (kind === "video" && (!player.videoWidth || !player.videoHeight))) {
        finish(new Error("媒体时长或画面无效，请选择完整且可播放的文件"))
      } else finish()
    }
    try {
      player = createMedia(kind)
      if (!player?.canPlayType(blob.type)) throw new Error("当前浏览器不支持此媒体格式，请选择其他 MP3、WAV、MP4 或 WebM 文件")
      player.preload = "metadata"
      player.autoplay = false
      player.controls = false
      player.addEventListener("loadedmetadata", loaded)
      player.addEventListener("error", failed)
      signal?.addEventListener("abort", cancel, { once: true })
      timer = setTimeout(() => finish(new Error("媒体读取超过 10 秒，请重试或选择较小的文件")), timeoutMs)
      url = URL.createObjectURL(blob)
      player.src = url
      player.load()
      if (signal?.aborted) cancel()
    } catch (error) { finish(error) }
  })
}

// 只在字节/容器/原生元数据全部通过后返回资源；原字节不转码，正文使用独立资源 ID。
export async function readMediaFile(file, kind = getMediaKind(file?.type), options = {}) {
  checkAbort(options.signal)
  const metadata = { id: createId(), ...getMediaFileMetadata(file, kind) }
  const bytes = await readValidatedBytes(file, metadata.kind, metadata.mimeType)
  checkAbort(options.signal)
  const blob = new Blob([bytes], { type: metadata.mimeType })
  const url = await createPlayableUrl(blob, metadata.kind, options)
  // metadata 完成与 await 续行之间也可能收到取消；交给会话前再检查并回收已成功的临时 URL。
  if (options.signal?.aborted) { URL.revokeObjectURL(url); throw abortError() }
  return { ...metadata, blob, url }
}

export const getMediaFileName = getAttachmentFileName
export function getMediaText(asset) {
  if (!asset || !isKind(asset.kind)) return "[音视频资源缺失]"
  return `[${asset.kind === "audio" ? "音频" : "视频"}：${asset.fileName}（${formatAttachmentSize(asset.byteLength)}）]`
}
