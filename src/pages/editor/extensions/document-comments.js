/** 将批注内容与正文锚点分开存储，同时让两者参与同一份文档快照和原生撤销。 */
import { Extension, Mark, mergeAttributes } from "@tiptap/core"

// 批注正文放在文档根节点，锚点随原生文字标记一起映射位置、撤销和保存。
// 根节点属性不进入 HTML，粘贴 HTML 也不接纳锚点，避免复制出孤立的批注引用。
export const DocumentComments = Extension.create({
  name: "documentComments",
  addGlobalAttributes() {
    return [{
      types: ["doc"],
      attributes: { commentThreads: { default: null, rendered: false, parseHTML: () => null } }
    }]
  }
})

// 锚点引用根节点中的批注 ID；边界外输入和拆段不自动继承，避免意见范围持续扩张。
export const CommentAnchor = Mark.create({
  name: "commentAnchor",
  inclusive: false,
  keepOnSplit: false,
  addAttributes() {
    return {
      id: {
        default: null,
        renderHTML: attrs => ({ "data-mewoc-comment-id": attrs.id })
      }
    }
  },
  // 静态输出可显示锚点颜色，HTML 粘贴不能反向恢复批注关系，完整传递需使用文档协议。
  parseHTML() { return [] },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "mewoc-comment-anchor" }), 0]
  }
})
