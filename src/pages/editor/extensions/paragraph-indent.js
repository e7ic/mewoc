import { Extension } from "@tiptap/core"
import { TextSelection, AllSelection } from "@tiptap/pm/state"
import { FIRST_LINE_INDENTS, LEFT_INDENTS } from "../constants/editor-constants.js"

export function parseParagraphIndent(value, allowed) {
  if (!/^\d+em$/.test(value)) return 0
  const indent = Number(value.slice(0, -2))
  return allowed.includes(indent) ? indent : 0
}

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
        if (!editor.isEditable || editor.view.composing || !attrs || typeof attrs !== "object" || Array.isArray(attrs)) return false
        const keys = Object.keys(attrs)
        if (!keys.length || keys.some(key => !["firstLineIndent", "leftIndent"].includes(key))) return false
        if (keys.includes("firstLineIndent") && !FIRST_LINE_INDENTS.includes(attrs.firstLineIndent)) return false
        if (keys.includes("leftIndent") && !LEFT_INDENTS.includes(attrs.leftIndent)) return false
        const paragraphs = getIndentParagraphs(state)
        if (!paragraphs.length) return false
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
