/** 手动分页符的最小文档节点：保留用户指定边界，具体编辑提示和打印换页交给内容样式。 */
import { Node } from "@tiptap/core"

// 仅表示用户插入的分页边界；编辑时显示标记，打印 CSS 解释为换页，不负责实时自动分页。
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  // 以整体选中和删除，避免光标进入无文字的分页标记内部。
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: "div[data-page-break]" }],
  renderHTML: () => ["div", { "data-page-break": "true", "aria-label": "手动分页符" }]
})
