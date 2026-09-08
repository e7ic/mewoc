import { Node } from "@tiptap/core"

// 仅表示用户插入的分页边界；编辑时显示标记，打印 CSS 解释为换页，不负责实时自动分页。
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: "div[data-page-break]" }],
  renderHTML: () => ["div", { "data-page-break": "true", "aria-label": "手动分页符" }]
})
