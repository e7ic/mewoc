/**
 * 页眉页脚的单行普通文字契约。独立于正文 schema 与 UI，保存、预览和各导出入口共用。
 * 页码占位预算以五位数字保守估算；字号向下舍入，使 HTML 与 Word 使用完全相同的值。
 */
import { getPageDimensions } from "./page-paper.js"

export const DEFAULT_PAGE_FURNITURE = Object.freeze({ text: "", alignment: "center", pageNumber: "none" })
const FIELDS = ["text", "alignment", "pageNumber"]
const SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const INVALID_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

// 显式空白设置保留对齐偏好，但不产生装饰层、边距要求或导出中的空白页眉。
export function isPageFurnitureActive(furniture) {
  return Boolean(furniture && (typeof furniture.text === "string" && furniture.text.trim() || furniture.pageNumber !== "none"))
}

export function validatePageFurniture(furniture, label = "页眉页脚") {
  const prototype = furniture && typeof furniture === "object" && Object.getPrototypeOf(furniture)
  if (!furniture || typeof furniture !== "object" || Array.isArray(furniture)
    || ![Object.prototype, null].includes(prototype)
    || Reflect.ownKeys(furniture).length !== FIELDS.length
    || !FIELDS.every(key => Object.hasOwn(furniture, key) && Object.getOwnPropertyDescriptor(furniture, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(furniture, key), "value"))) {
    throw new Error(`${label}设置无效或包含未知字段`)
  }
  if (typeof furniture.text !== "string" || furniture.text.length > 160 || Array.from(furniture.text).length > 80
    || SINGLE_LINE_CONTROLS.test(furniture.text) || INVALID_SURROGATES.test(furniture.text)) throw new Error(`${label}文字应为最多 80 个字符的有效 Unicode 单行文字`)
  if (!["left", "center", "right"].includes(furniture.alignment)) throw new Error(`${label}对齐方式无效`)
  if (!["none", "page", "page-total"].includes(furniture.pageNumber)) throw new Error(`${label}页码格式无效`)
  return furniture
}

// 字段只决定字符串，不计算或虚构编辑画布的分页。屏幕用省略号，Word 用实际字段，打印由浏览器生成。
export function getPageFurnitureText(furniture, { pageNumber = "1", pageTotal = "…" } = {}) {
  if (!isPageFurnitureActive(furniture)) return ""
  const text = furniture.text.trim()
  const number = furniture.pageNumber === "page" ? `第 ${pageNumber} 页`
    : furniture.pageNumber === "page-total" ? `第 ${pageNumber} / ${pageTotal} 页` : ""
  return [text, number].filter(Boolean).join(" · ")
}

/**
 * 普通码点按一个 em 估算；兼容合字按展开的码点数，‱ 等宽字形至少两个 em，再留 5% 余量。
 * 这里只估算宽度，不改变原文或把兼容字符规范化保存；不是任意字体的精确测量。
 * 页面验证调用本函数时已校验边距；导出入口同样先验证完整文档，不以静默缩字掩盖损坏设置。
 */
export function getPageFurnitureFontPt(page, furniture) {
  validatePageFurniture(furniture)
  if (!isPageFurnitureActive(furniture)) return 9
  const { widthMm } = getPageDimensions(page)
  const widthPt = (widthMm - page.marginsMm.left - page.marginsMm.right) * 72 / 25.4
  const text = getPageFurnitureText(furniture, { pageNumber: "99999", pageTotal: "99999" })
  const units = Array.from(text).reduce((sum, character) => {
    const point = character.codePointAt(0)
    return sum + Math.max(Array.from(character.normalize("NFKC")).length, point === 0x2031 || point >= 0xfb50 && point <= 0xfdff ? 2 : 1)
  }, 0) * 1.05
  const fitting = Math.min(9, Math.floor(widthPt / Math.max(1, units) * 2) / 2)
  if (!Number.isFinite(fitting) || fitting < 6) throw new Error("页眉页脚文字过长，请缩短文字或增加正文宽度，以保留至少 6pt 的单行字号")
  return fitting
}
