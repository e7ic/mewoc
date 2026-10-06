/**
 * 为文档、资源、模板、历史版本和批注生成可持久化的 UUID v4 身份。
 * 使用浏览器安全随机源，调用方在数据库创建时仍通过 add 检测极低概率的键碰撞。
 */
export function createId() {
  // 局域网 HTTP 没有 randomUUID，但仍提供安全随机字节；保持 UUID v4 格式。
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // 第 7 字节高四位固定为版本 4，第 9 字节高两位固定为 10，其余位保留随机值。
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
