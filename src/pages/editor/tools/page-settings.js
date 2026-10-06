/**
 * 定义纸张、页边距与文字水印的共享契约，供页面设置、保存和导出使用。
 * 校验只报告错误，不改写输入；旧文档缺少 watermark 时继续保留原来的字段形状。
 */

// 尺寸始终按竖版毫米值存放；横版只在读取时交换宽高，避免多套尺寸常量出现偏差。
export const PAGE_SIZES = Object.freeze({
  A3: Object.freeze({ widthMm: 297, heightMm: 420 }),
  A4: Object.freeze({ widthMm: 210, heightMm: 297 }),
  A5: Object.freeze({ widthMm: 148, heightMm: 210 }),
  Letter: Object.freeze({ widthMm: 215.9, heightMm: 279.4 })
})

// 预设和水印默认值不可直接修改；会话或表单需要可编辑草稿时应显式深克隆。
export const MARGIN_PRESETS = Object.freeze([
  makeMarginPreset("normal", "常规", 20),
  makeMarginPreset("narrow", "窄", 12.7),
  makeMarginPreset("wide", "宽", 25.4)
])

export const DEFAULT_WATERMARK = Object.freeze({
  text: "草稿", color: "#797087", opacity: 0.12, angle: -35
})

const PAGE_KEYS = ["size", "orientation", "marginsMm", "watermark"]
const MARGIN_KEYS = ["top", "right", "bottom", "left"]
const WATERMARK_KEYS = ["text", "color", "opacity", "angle"]
const SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const MIN_CONTENT_MM = 40

function makeMarginPreset(id, label, margin) {
  return Object.freeze({
    id, label,
    marginsMm: Object.freeze({ top: margin, right: margin, bottom: margin, left: margin })
  })
}

/**
 * 按纸型与方向返回纸面尺寸，不依赖边距或水印，因此也能服务纸型选项的小预览。
 * 不接受继承得到的纸型、未知枚举或数组，避免原型属性被当作可保存的页面配置。
 */
export function getPageDimensions(page) {
  if (!isRecord(page) || !Object.hasOwn(page, "size") || !Object.hasOwn(page, "orientation") ||
    typeof page.size !== "string" || !Object.hasOwn(PAGE_SIZES, page.size) || !["portrait", "landscape"].includes(page.orientation)) {
    throw new Error("纸张设置无效，请选择 A3、A4、A5 或 Letter 的横版或竖版")
  }
  const { widthMm, heightMm } = PAGE_SIZES[page.size]
  return page.orientation === "landscape" ? { widthMm: heightMm, heightMm: widthMm } : { widthMm, heightMm }
}

// 正文区域从已验证的毫米边距计算，编辑画布与导出无需各自重复尺寸减法。
export function getPageContentDimensions(page) {
  validatePageSettings(page)
  const { widthMm, heightMm } = getPageDimensions(page)
  const { top, right, bottom, left } = page.marginsMm
  return { widthMm: widthMm - (left + right), heightMm: heightMm - (top + bottom) }
}

/**
 * 统一验证页面完整对象，成功返回原对象；不能替调用方补默认值或修复损坏文档。
 * watermark 只在字段存在时校验，缺省与显式 null 都表示无水印，便携文件与旧历史无需迁移。
 */
export function validatePageSettings(page) {
  const { widthMm, heightMm } = getPageDimensions(page)
  if (!hasOnlyKeys(page, PAGE_KEYS) || !Object.hasOwn(page, "marginsMm")) {
    throw new Error("纸张设置包含未知字段或缺少页边距")
  }
  const margins = page.marginsMm
  if (!isCompleteRecord(margins, MARGIN_KEYS) ||
    !MARGIN_KEYS.every(key => Number.isFinite(margins[key]) && margins[key] >= 0)) {
    throw new Error("页边距必须是大于或等于 0 的数字，并且只包含上、右、下、左四边")
  }
  // 比较边距之和与允许总量，保留恰好 40 mm 的合法边界；Letter 的小数尺寸不先舍入。
  if (margins.left + margins.right > widthMm - MIN_CONTENT_MM || margins.top + margins.bottom > heightMm - MIN_CONTENT_MM) {
    throw new Error("页边距过大，请至少保留 40 mm 的正文区域")
  }
  if (Object.hasOwn(page, "watermark") && page.watermark !== null) validateWatermark(page.watermark)
  return page
}

// 首尾空白只用于判断非空，原值本身也限制 80 个码点，避免超长空白绕过水印容量上限。
// UI 保存时执行 trim；验证过程始终不修改原稿，导出显示同样使用去首尾空白后的文字。
// 禁止所有控制字符和 Unicode 行分隔符，保持水印是一行普通文字，不可承载活动 HTML。
function validateWatermark(watermark) {
  if (!isCompleteRecord(watermark, WATERMARK_KEYS)) throw new Error("水印设置无效或包含未知字段")
  if (typeof watermark.text !== "string" || watermark.text.length > 160 || SINGLE_LINE_CONTROLS.test(watermark.text) ||
    !watermark.text.trim() || Array.from(watermark.text).length > 80) {
    throw new Error("水印文字应为 1–80 个字符的单行文字")
  }
  if (typeof watermark.color !== "string" || !/^#[\da-f]{6}$/i.test(watermark.color)) {
    throw new Error("水印颜色应为 #RRGGBB 格式")
  }
  if (!Number.isFinite(watermark.opacity) || watermark.opacity < 0.05 || watermark.opacity > 0.5) {
    throw new Error("水印透明度应为 5%–50%")
  }
  if (!Number.isFinite(watermark.angle) || watermark.angle < -90 || watermark.angle > 90) {
    throw new Error("水印角度应为 -90°–90°")
  }
}

// 仅完整、没有额外字段且四边与预设精确相同才显示预设名，非对称边距保持「自定义」。
export function getMarginPresetId(margins) {
  if (!isCompleteRecord(margins, MARGIN_KEYS)) return "custom"
  return MARGIN_PRESETS.find(preset => MARGIN_KEYS.every(key => margins[key] === preset.marginsMm[key]))?.id || "custom"
}

// 接受普通 JSON 对象及无原型字典；数组、日期和任意自定义原型不能进入持久页面契约。
function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value, keys) {
  return Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key))
}

function isCompleteRecord(value, keys) {
  return isRecord(value) && hasOnlyKeys(value, keys) && keys.every(key => Object.hasOwn(value, key))
}
