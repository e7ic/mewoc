import { Extension } from "@tiptap/core"
import { LINE_HEIGHTS } from "../constants/editor-constants.js"

// 行距持久化为无单位倍数，null 表示沿用正文/标题 CSS 默认值；整段生效，不属于文字 mark。
export const ParagraphSpacing = Extension.create({
  name: "paragraphSpacing",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: element => {
            const value = Number(element.style.lineHeight)
            return LINE_HEIGHTS.includes(value) ? value : null
          },
          renderHTML: attrs => attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {}
        }
      }
    }]
  },
  addCommands() {
    return {
      setParagraphSpacing: lineHeight => ({ tr, dispatch }) => {
        if (!LINE_HEIGHTS.includes(lineHeight)) return false
        if (dispatch) {
          tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
            if (["paragraph", "heading"].includes(node.type.name)) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, lineHeight })
            }
          })
        }
        return true
      }
    }
  }
})
