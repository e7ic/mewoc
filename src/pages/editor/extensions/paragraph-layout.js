/** 段前段后间距与分页约束的统一契约，供设置面板、剪贴板、格式刷和导入导出共用。 */
import { Extension } from "@tiptap/core"

export const PARAGRAPH_LAYOUT_ATTRIBUTES = Object.freeze(["spaceBefore", "spaceAfter", "keepWithNext", "keepTogether"])
const SPACING_ATTRIBUTES = ["spaceBefore", "spaceAfter"]

// 间距以 pt 保存，支持 0.5 pt 步进；有限数与范围检查排除 NaN、Infinity 和越界输入。
function isParagraphSpacing(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 120 && Number.isInteger(value * 2)
}

// null 沿用正文/标题 CSS 与 Word 段落样式；0 和 false 则是用户明确要求关闭，不能用 truthy 判断。
export function normalizeParagraphLayout(attrs = {}) {
  const values = attrs && typeof attrs === "object" && !Array.isArray(attrs) ? attrs : {}
  return {
    spaceBefore: isParagraphSpacing(values.spaceBefore) ? values.spaceBefore : null,
    spaceAfter: isParagraphSpacing(values.spaceAfter) ? values.spaceAfter : null,
    keepWithNext: typeof values.keepWithNext === "boolean" ? values.keepWithNext : null,
    keepTogether: typeof values.keepTogether === "boolean" ? values.keepTogether : null
  }
}

// 验证已声明字段而不补默认值，允许旧文档缺省属性；存在的非法值由文档校验直接拒绝。
export function isValidParagraphLayout(attrs = {}) {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return false
  return PARAGRAPH_LAYOUT_ATTRIBUTES.every(key => {
    if (!(key in attrs)) return true
    const value = attrs[key]
    if (value === null) return true
    return SPACING_ATTRIBUTES.includes(key) ? isParagraphSpacing(value) : typeof value === "boolean"
  })
}

// 仅接受本项目输出的 pt 单位；未知单位返回 null，继续沿用段落样式默认间距。
function parseSpacing(value) {
  const match = /^(\d+(?:\.\d+)?)pt$/i.exec((value || "").trim())
  if (match) {
    const number = Number(match[1])
    return isParagraphSpacing(number) ? number : null
  }
  // 部分 CSSOM 将无单位的零标准化为 0px；只有零与 pt 无关，非零 px 不能偷偷转换为 pt。
  return ["0", "0px"].includes(value) ? 0 : null
}

// 兼容新旧分页 CSS 名称，显式 avoid/auto 分别恢复 true/false，其余值保持默认。
function parsePageBreak(style, modern, legacy) {
  const value = style?.getPropertyValue(modern)?.trim() || style?.getPropertyValue(legacy)?.trim()
  return value === "avoid" ? true : value === "auto" ? false : null
}

// 从段落元素恢复逻辑属性；此处不写 DOM，属性输出由下面的全局属性定义负责。
export function parseParagraphLayout(element) {
  const style = element?.style
  return {
    spaceBefore: parseSpacing(style?.marginTop),
    spaceAfter: parseSpacing(style?.marginBottom),
    keepWithNext: parsePageBreak(style, "break-after", "page-break-after"),
    keepTogether: parsePageBreak(style, "break-inside", "page-break-inside")
  }
}

// 外观属于段落节点，而不是文字 mark；标题/列表/表格中的段落都共享属性且保留各自样式默认值。
export const ParagraphLayout = Extension.create({
  name: "paragraphLayout",
  addGlobalAttributes() {
    // 四个属性独立输出内联规则；null 不输出，确保标题/正文原有默认排版仍能生效。
    return [{
      types: ["paragraph", "heading"],
      attributes: {
        spaceBefore: {
          default: null,
          parseHTML: element => parseParagraphLayout(element).spaceBefore,
          renderHTML: attrs => {
            const value = normalizeParagraphLayout(attrs).spaceBefore
            return value === null ? {} : { style: `margin-top: ${value}pt` }
          }
        },
        spaceAfter: {
          default: null,
          parseHTML: element => parseParagraphLayout(element).spaceAfter,
          renderHTML: attrs => {
            const value = normalizeParagraphLayout(attrs).spaceAfter
            return value === null ? {} : { style: `margin-bottom: ${value}pt` }
          }
        },
        keepWithNext: {
          default: null,
          parseHTML: element => parseParagraphLayout(element).keepWithNext,
          renderHTML: attrs => {
            const value = normalizeParagraphLayout(attrs).keepWithNext
            return value === null ? {} : { style: `break-after: ${value ? "avoid" : "auto"}` }
          }
        },
        keepTogether: {
          default: null,
          parseHTML: element => parseParagraphLayout(element).keepTogether,
          renderHTML: attrs => {
            const value = normalizeParagraphLayout(attrs).keepTogether
            return value === null ? {} : { style: `break-inside: ${value ? "avoid" : "auto"}` }
          }
        }
      }
    }]
  }
})
