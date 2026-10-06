/** 纸型和方向的纯尺寸契约；页面验证及页眉页脚预算共同使用，避免循环依赖和重复常量。 */
// 尺寸始终按竖版毫米值存放；横版只在读取时交换宽高，避免多套尺寸常量出现偏差。
export const PAGE_SIZES = Object.freeze({
  A3: Object.freeze({ widthMm: 297, heightMm: 420 }),
  A4: Object.freeze({ widthMm: 210, heightMm: 297 }),
  A5: Object.freeze({ widthMm: 148, heightMm: 210 }),
  Letter: Object.freeze({ widthMm: 215.9, heightMm: 279.4 })
})

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

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
