/** 根据实时文字选区和 DOM 焦点生成当前段落背景，交互反馈不写入正文或导出内容。 */
import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

export const EDITOR_FOCUS_KEY = new PluginKey("mewocEditorFocus")
export const EDITOR_FOCUS_CLASS = "mewoc-focused-paragraph"

// 只装饰文字选区的 anchor 段落。NodeSelection/CellSelection 已有节点框或单元格选区反馈，
// 不能根据它们的边界位置把旁边的段落误判为当前段，也不把跨段选择的全部段落染色。
function focusedParagraph(selection) {
  if (!(selection instanceof TextSelection)) return null
  const { $anchor } = selection
  // 从 anchor 向外查找最近的正文/标题段落，列表和表格内也能定位到实际文字容器。
  for (let depth = $anchor.depth; depth > 0; depth -= 1) {
    const node = $anchor.node(depth)
    if (["paragraph", "heading"].includes(node.type.name)) return { node, pos: $anchor.before(depth) }
  }
  return null
}

// Tiptap 的内建 focusEvents 已在 focus/blur 时发出无历史事务，直接复用这条更新链。
// 官方 Focus 的 deepest/all 会装饰 inline atom、列表或单元格，本需求只允许 p/heading。
// 不写节点 attrs，不注册额外 DOM listener：交互装饰不会影响保存 revision、撤销或 HTML 导出。
export const EditorFocus = Extension.create({
  name: "editorFocus",
  addProseMirrorPlugins() {
    const { editor } = this
    return [new Plugin({
      key: EDITOR_FOCUS_KEY,
      props: {
        decorations: ({ doc, selection }) => {
          // isFocused 与实际 DOM 焦点双重核验，工具栏抢走焦点后不能显示残留的段落背景。
          if (editor.isDestroyed || !editor.isFocused || !editor.isEditable || !editor.view.hasFocus()) return DecorationSet.empty
          const paragraph = focusedParagraph(selection)
          return paragraph ? DecorationSet.create(doc, [Decoration.node(paragraph.pos, paragraph.pos + paragraph.node.nodeSize, { class: EDITOR_FOCUS_CLASS })]) : DecorationSet.empty
        }
      }
    })]
  }
})
