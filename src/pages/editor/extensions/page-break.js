/** 手动分页符的最小文档节点：保留用户指定边界，具体编辑提示和打印换页交给内容样式。 */
import { Node } from "@tiptap/core"

// 仅保存用户边界；编辑分页插件解释为强制换页，静态打印由 CSS 解释，不保存自动分页结果。
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  // 以整体选中和删除，避免光标进入无文字的分页标记内部。
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: "div[data-page-break]" }],
  renderHTML: () => ["div", { "data-page-break": "true", "aria-label": "手动分页符" }]
})
