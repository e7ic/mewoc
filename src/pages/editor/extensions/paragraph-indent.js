/** 首行与整段缩进的文档属性及批量命令；解析、界面设置和格式刷共用同一组允许值。 */
import { Extension } from "@tiptap/core"
import { TextSelection, AllSelection } from "@tiptap/pm/state"
import { FIRST_LINE_INDENTS, LEFT_INDENTS } from "../constants/editor-constants.js"

// 用 em 表达“字符数”式缩进，随字号变化；只接纳菜单允许的整数，外部任意 CSS 不直接入库。
export function parseParagraphIndent(value, allowed) {
  if (!/^\d+em$/.test(value)) return 0
  const indent = Number(value.slice(0, -2))
  return allowed.includes(indent) ? indent : 0
}

// 获取文字/全选涉及的正文与标题；节点选区和单元格选区不按文字范围推断段落。
export function getIndentParagraphs(state) {
  const { selection, doc } = state
  const paragraphs = []
  if (!(selection instanceof TextSelection || selection instanceof AllSelection)) return paragraphs
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!["paragraph", "heading"].includes(node.type.name)) return
    // 文字选区是半开区间；下一段只有起点被选到时，不把整段算入批量修改。
    if (!selection.empty && pos + 1 === selection.to) return
    paragraphs.push({ node, pos })
  })
  return paragraphs
}

// 段落属性保存逻辑字符数，渲染为 em；修改时保留节点类型、其他属性及所有文字标记。
export const ParagraphIndent = Extension.create({
  name: "paragraphIndent",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: {
        firstLineIndent: {
          default: 0,
          parseHTML: element => parseParagraphIndent(element.style.textIndent, FIRST_LINE_INDENTS),
          renderHTML: attrs => attrs.firstLineIndent ? { style: `text-indent: ${attrs.firstLineIndent}em` } : {}
        },
        leftIndent: {
          default: 0,
          parseHTML: element => parseParagraphIndent(element.style.marginLeft, LEFT_INDENTS),
          renderHTML: attrs => attrs.leftIndent ? { style: `margin-left: ${attrs.leftIndent}em` } : {}
        }
      }
    }]
  },
  addCommands() {
    return {
      setParagraphIndent: attrs => ({ state, tr, dispatch, editor }) => {
        // 拒绝只读、组合输入、未知字段及菜单外值，避免命令绕过界面校验写入异常属性。
        if (!editor.isEditable || editor.view.composing || !attrs || typeof attrs !== "object" || Array.isArray(attrs)) return false
        const keys = Object.keys(attrs)
        if (!keys.length || keys.some(key => !["firstLineIndent", "leftIndent"].includes(key))) return false
        if (keys.includes("firstLineIndent") && !FIRST_LINE_INDENTS.includes(attrs.firstLineIndent)) return false
        if (keys.includes("leftIndent") && !LEFT_INDENTS.includes(attrs.leftIndent)) return false
        const paragraphs = getIndentParagraphs(state)
        if (!paragraphs.length) return false
        // can() 探测命令时没有 dispatch，只判断是否适用；执行时在同一事务批量写入。
        if (dispatch) paragraphs.forEach(({ node, pos }) => {
          if (keys.some(key => (node.attrs[key] ?? 0) !== attrs[key])) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
          }
        })
        return true
      }
    }
  }
})
