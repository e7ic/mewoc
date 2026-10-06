/** 协调显式 textStyle 字重与原生 bold 标记，使格式刷后的加粗按钮和快捷键保持一致。 */
import { Extension } from "@tiptap/core"
import { FONT_WEIGHTS } from "../constants/editor-constants.js"

// 显式字重用于保留格式刷带来的标题外观；data-font-weight 配合内容样式防止嵌套 strong 再增粗。
export const FontWeight = Extension.create({
  name: "fontWeight",
  addGlobalAttributes() {
    // 只把允许的字重读入 textStyle；输出额外标记供 CSS 阻止嵌套 strong 重复增粗。
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
    // 让键盘入口复用与工具栏相同的字重切换逻辑。
    return { "Mod-b": () => this.editor.commands.toggleTextBold() }
  },
  priority: 110
})
