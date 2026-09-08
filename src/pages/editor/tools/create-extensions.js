import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { TextStyleKit } from "@tiptap/extension-text-style"
import TextAlign from "@tiptap/extension-text-align"
import FindAndReplace from "@tiptap/extension-find-and-replace"
import { Placeholder } from "@tiptap/extensions"
import { ParagraphSpacing } from "../extensions/paragraph-spacing.js"
import { PageBreak } from "../extensions/page-break.js"
import { DocumentImage } from "../extensions/document-image.js"
import { TableColumnResize } from "../extensions/table-column-resize.js"
import { FormatPainter } from "../extensions/format-painter.js"
import { ParagraphIndent } from "../extensions/paragraph-indent.js"
import { InlineMath, BlockMath } from "../extensions/formula.js"
import { DocumentCodeBlock } from "../extensions/code-block.js"
import { DocumentAttachment } from "../extensions/document-attachment.js"
import { FontWeight } from "../extensions/font-weight.js"

export function createExtensions(getAssetUrl = () => "", getAsset = () => null) {
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }
    }),
    TextStyleKit.configure({ lineHeight: false }),
    FontWeight,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    // 官方列宽拖动使用屏幕增量；由本模块处理缩放坐标，保留官方表格模型和视图。
    TableKit.configure({ table: { resizable: false } }),
    TableColumnResize,
    DocumentImage.configure({ getAssetUrl: id => getAsset(id)?.kind === "attachment" ? "" : getAssetUrl(id) }),
    DocumentAttachment.configure({ getAssetUrl, getAsset }),
    ParagraphSpacing,
    ParagraphIndent,
    FormatPainter,
    PageBreak,
    InlineMath,
    BlockMath,
    DocumentCodeBlock,
    FindAndReplace.configure({ injectCSS: false, searchDebounceMs: 150 }),
    Placeholder.configure({ placeholder: "在这里写下你的想法…" })
  ]
}
