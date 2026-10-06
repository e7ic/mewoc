/** 表格外观的默认值、校验和 HTML 适配；只处理样式，不改变合并跨度或列宽结构。 */
import { Extension } from "@tiptap/core"

// 缺省属性使旧文档获得一致外观；底色为 null 时允许表头 CSS 提供默认背景。
export const TABLE_CELL_DEFAULTS = Object.freeze({
  backgroundColor: null, verticalAlign: "top", paddingX: 10, paddingY: 8,
  borderColor: "#d9dbe5", borderWidth: 1, borderStyle: "solid"
})

const verticalAligns = ["top", "middle", "bottom"]
const borderStyles = ["solid", "dashed", "dotted", "none"]

// 从 CSSOM 恢复边框枚举，兼容部分实现对 none 的空值回读。
export function getTableBorderStyle(element) {
  const style = element.style.borderTopStyle
  if (borderStyles.includes(style)) return style
  // 部分 CSSOM 实现把 none 读成空值；仅回读这个完整声明，不能接受任意原始样式。
  return /(?:^|;)\s*border-style\s*:\s*none\s*(?:;|$)/i.test(element.getAttribute("style") || "") ? "none" : "solid"
}

// 只接受不含透明度的纯色，HTML 导入和导出共用同一个白名单，不能把任意 CSS 放入正文。
export function normalizeTableColor(value, fallback = null) {
  if (typeof value !== "string") return fallback
  const color = value.trim().toLowerCase()
  if (/^#[\da-f]{6}$/.test(color)) return color
  if (/^#[\da-f]{3}$/.test(color)) return `#${[...color.slice(1)].map(char => char + char).join("")}`
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(1(?:\.0+)?))?\s*\)$/.exec(color)
  if (rgb && rgb.slice(1, 4).every(channel => Number(channel) <= 255)) {
    return `#${rgb.slice(1, 4).map(channel => Number(channel).toString(16).padStart(2, "0")).join("")}`
  }
  return fallback
}

// 共用整数范围判断，拒绝小数与隐式字符串转换，使面板、剪贴板和协议校验一致。
export function isTableInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum
}

// 返回的只有外观属性；调用方合并原有 colspan/rowspan/colwidth，避免破坏表格结构。
export function normalizeTableCellAppearance(attrs = {}) {
  return {
    backgroundColor: normalizeTableColor(attrs.backgroundColor),
    verticalAlign: verticalAligns.includes(attrs.verticalAlign) ? attrs.verticalAlign : "top",
    paddingX: isTableInteger(attrs.paddingX, 0, 40) ? attrs.paddingX : 10,
    paddingY: isTableInteger(attrs.paddingY, 0, 40) ? attrs.paddingY : 8,
    borderColor: normalizeTableColor(attrs.borderColor, "#d9dbe5"),
    borderWidth: isTableInteger(attrs.borderWidth, 0, 6) ? attrs.borderWidth : 1,
    borderStyle: borderStyles.includes(attrs.borderStyle) ? attrs.borderStyle : "solid"
  }
}

// null 表示随内容自然撑高；显式最小高度限制在可保存和可导出的范围内。
export function normalizeTableRowAppearance(attrs = {}) {
  return { minHeight: isTableInteger(attrs.minHeight, 1, 1000) ? attrs.minHeight : null }
}

// 持久化校验严格检查已声明字段；与容错归一化不同，这里不静默替换非法保存数据。
export function isValidTableCellAppearance(attrs = {}) {
  return Object.keys(TABLE_CELL_DEFAULTS).every(key => {
    if (!(key in attrs)) return true
    const value = attrs[key]
    if (key === "backgroundColor") return value === null || typeof value === "string" && /^#[\da-fA-F]{6}$/.test(value)
    if (key === "borderColor") return typeof value === "string" && /^#[\da-fA-F]{6}$/.test(value)
    if (key === "verticalAlign") return verticalAligns.includes(value)
    if (key === "borderStyle") return borderStyles.includes(value)
    return isTableInteger(value, 0, key === "borderWidth" ? 6 : 40)
  })
}

// 缺省与 null 均兼容旧文档，有值时必须满足最小行高约束。
export function isValidTableRowAppearance(attrs = {}) {
  return !("minHeight" in attrs) || attrs.minHeight === null || isTableInteger(attrs.minHeight, 1, 1000)
}

// CSS 解析只接受整数 px；不推测百分比或其他单位，无法恢复时使用对应默认值。
function pixelInteger(value, minimum, maximum, fallback) {
  const match = /^(\d+)px$/.exec(value || "")
  const number = match ? Number(match[1]) : NaN
  return isTableInteger(number, minimum, maximum) ? number : fallback
}

// 单元格自己持有 inline 样式，TableView 的 colgroup 更新不会遮蔽这些属性。
// 不在 table 节点写样式：Tiptap 的 TableView 不会重新读取 table attrs，且重写 renderHTML 会丢列宽。
export const TableAppearance = Extension.create({
  name: "tableAppearance",
  addGlobalAttributes() {
    // 普通格与表头共用单元格属性，行高单独挂在 tableRow，输出时重新归一化所有值。
    return [{
      types: ["tableCell", "tableHeader"],
      attributes: {
        backgroundColor: {
          default: null,
          parseHTML: element => normalizeTableColor(element.style.backgroundColor),
          renderHTML: attrs => {
            const color = normalizeTableColor(attrs.backgroundColor)
            return color ? { style: `background-color: ${color}` } : {}
          }
        },
        verticalAlign: {
          default: "top",
          parseHTML: element => verticalAligns.includes(element.style.verticalAlign) ? element.style.verticalAlign : "top",
          renderHTML: attrs => ({ style: `vertical-align: ${normalizeTableCellAppearance(attrs).verticalAlign}` })
        },
        paddingX: {
          default: 10,
          parseHTML: element => pixelInteger(element.style.paddingLeft, 0, 40, 10),
          renderHTML: attrs => ({ style: `padding-left: ${normalizeTableCellAppearance(attrs).paddingX}px; padding-right: ${normalizeTableCellAppearance(attrs).paddingX}px` })
        },
        paddingY: {
          default: 8,
          parseHTML: element => pixelInteger(element.style.paddingTop, 0, 40, 8),
          renderHTML: attrs => ({ style: `padding-top: ${normalizeTableCellAppearance(attrs).paddingY}px; padding-bottom: ${normalizeTableCellAppearance(attrs).paddingY}px` })
        },
        borderColor: {
          default: "#d9dbe5",
          parseHTML: element => normalizeTableColor(element.style.borderTopColor, "#d9dbe5"),
          renderHTML: attrs => ({ style: `border-color: ${normalizeTableCellAppearance(attrs).borderColor}` })
        },
        borderWidth: {
          default: 1,
          parseHTML: element => pixelInteger(element.style.borderTopWidth, 0, 6, 1),
          renderHTML: attrs => ({ style: `border-width: ${normalizeTableCellAppearance(attrs).borderWidth}px` })
        },
        borderStyle: {
          default: "solid",
          parseHTML: getTableBorderStyle,
          renderHTML: attrs => ({ style: `border-style: ${normalizeTableCellAppearance(attrs).borderStyle}` })
        }
      }
    }, {
      types: ["tableRow"],
      attributes: {
        minHeight: {
          default: null,
          parseHTML: element => pixelInteger(element.style.height || element.style.minHeight, 1, 1000, null),
          renderHTML: attrs => {
            const { minHeight } = normalizeTableRowAppearance(attrs)
            // CSS 表格的 height 是最小高度，文字换行仍能把实际行高撑大。
            return minHeight === null ? {} : { style: `height: ${minHeight}px` }
          }
        }
      }
    }]
  }
})
