import { Extension } from "@tiptap/core"
import { FONT_WEIGHTS } from "../constants/editor-constants.js"

export const FontWeight = Extension.create({
  name: "fontWeight",
  addGlobalAttributes() {
    return [{ types: ["textStyle"], attributes: {
      fontWeight: {
        default: null,
        parseHTML: element => FONT_WEIGHTS.includes(element.style.fontWeight) ? element.style.fontWeight : null,
        renderHTML: attrs => attrs.fontWeight ? { style: `font-weight: ${attrs.fontWeight}`, "data-font-weight": attrs.fontWeight } : {}
      }
    } }]
  },
  addCommands() {
    return {
      toggleTextBold: () => ({ editor, chain }) => {
        if (!editor.isEditable || editor.view.composing) return false
        const weight = editor.getAttributes("textStyle").fontWeight
        if (!weight) return chain().toggleBold().run()
        // 格式刷可能带来标题的 600 字重，显式字重不能遮住后续的加粗操作。
        return Number(weight) >= 600
          ? chain().unsetBold().setMark("textStyle", { fontWeight: "400" }).run()
          : chain().setMark("textStyle", { fontWeight: null }).removeEmptyTextStyle().setBold().run()
      }
    }
  },
  addKeyboardShortcuts() {
    return { "Mod-b": () => this.editor.commands.toggleTextBold() }
  },
  priority: 110
})
