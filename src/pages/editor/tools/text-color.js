/**
 * 在文字颜色弹层中转换 HEX、RGB、HSB 输入草稿并保留调色状态的精度。
 * 正文只提交不透明颜色，草稿允许暂时非法输入；只有校验通过才构造可应用的 Color 对象。
 */
import { Color } from "@rc-component/color-picker"

// 字段键、可访问名称和最大值共同定义数值输入，RGB 使用字节通道，HSB 显示角度/百分比。
export const TEXT_COLOR_FIELDS = {
  rgb: [["r", "红色通道", 255], ["g", "绿色通道", 255], ["b", "蓝色通道", 255]],
  hsb: [["h", "色相", 360], ["s", "饱和度", 100], ["b", "亮度", 100]]
}

// Color 的 HSB 缓存保留黑色/灰色的色相；仅去掉透明度，不从 HEX 重建本地调色状态。
export const createOpaqueTextColor = value => new Color(value).setA(1)

// 把内部颜色转换为适合表单的整数显示值；HSB 内部 0–1 的饱和度/亮度转换为百分比。
export function getTextColorDraft(color, format) {
  if (format === "hex") return { hex: color.toHexString().slice(1).toUpperCase() }
  const values = format === "rgb" ? color.toRgb() : color.toHsb()
  return Object.fromEntries(TEXT_COLOR_FIELDS[format].map(([key]) => [key, Math.round(values[key] * (format === "hsb" && key !== "h" ? 100 : 1))]))
}

// HEX 可接受三位或六位输入；数值格式先校验全部可见字段，再只覆盖 dirty 通道，非法返回 null。
export function parseTextColorDraft(color, format, draft, dirty = new Set()) {
  if (format === "hex") {
    const hex = String(draft.hex || "").trim()
    return /^#?(?:[\da-f]{3}|[\da-f]{6})$/i.test(hex) ? createOpaqueTextColor(hex.startsWith("#") ? hex : `#${hex}`) : null
  }
  const fields = TEXT_COLOR_FIELDS[format]
  if (!fields || fields.some(([key, , max]) => !isTextColorNumber(draft[key], max))) return null
  const values = format === "rgb" ? color.toRgb() : color.toHsb()
  // 只覆盖实际输入的通道，保留调色区域产生的其他 HSB 小数精度。
  fields.forEach(([key]) => {
    if (dirty.has(key)) values[key] = Number(draft[key]) / (format === "hsb" && key !== "h" ? 100 : 1)
  })
  return createOpaqueTextColor(values)
}

// 显式拒绝空输入，避免 Number("") 被当作合法 0；数值必须是范围内整数。
export function isTextColorNumber(value, max) {
  if (value === null || value === undefined || String(value).trim() === "") return false
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 && number <= max
}
