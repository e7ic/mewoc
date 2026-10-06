/**
 * 组装文档唯一的节点、文字标记、编辑行为和渲染规则。
 * 资源解析器由调用场景注入，扩展本身只通过 assetId 访问资源；schema 校验与导出复用同一结构。
 */
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { TextStyleKit } from "@tiptap/extension-text-style"
import TextAlign from "@tiptap/extension-text-align"
import FindAndReplace from "@tiptap/extension-find-and-replace"
import { Placeholder } from "@tiptap/extensions"
import { ParagraphSpacing } from "../extensions/paragraph-spacing.js"
import { ParagraphLayout } from "../extensions/paragraph-layout.js"
import { EditorFocus } from "../extensions/editor-focus.js"
import { FormattingMarks } from "../extensions/formatting-marks.js"
import { PageBreak } from "../extensions/page-break.js"
import { DocumentImage } from "../extensions/document-image.js"
import { TableColumnResize } from "../extensions/table-column-resize.js"
import { TableAppearance } from "../extensions/table-appearance.js"
import { FormatPainter } from "../extensions/format-painter.js"
import { ParagraphIndent } from "../extensions/paragraph-indent.js"
import { InlineMath, BlockMath } from "../extensions/formula.js"
import { DocumentCodeBlock } from "../extensions/code-block.js"
import { DocumentAttachment } from "../extensions/document-attachment.js"
import { FontWeight } from "../extensions/font-weight.js"
import { DocumentComments, CommentAnchor } from "../extensions/document-comments.js"
import { Superscript, Subscript } from "../extensions/text-scripts.js"
import { DocumentTaskList, DocumentTaskItem } from "../extensions/document-task-list.js"
import { EditingHistory } from "../extensions/editing-history.js"
import { DocumentTextBox, DocumentDetails } from "../extensions/block-containers.js"
import { DocumentNavigation, TableOfContents } from "../extensions/document-navigation.js"
import { isSafeDocumentLink } from "./document-navigation.js"

/**
 * 编辑、校验和静态导出共用的扩展入口，保证三者理解同一份文档节点与属性。
 * 编辑时注入会话 URL，导出时注入内嵌数据；纯 schema 校验无需提供资源解析器。
 */
export function createExtensions(getAssetUrl = () => "", getAsset = () => null) {
  return [
    // 基础编辑能力保留官方模型，代码块改用自定义实现；链接点击由界面控制，编辑时不自动跳转。
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, isAllowedUri: isSafeDocumentLink, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }
    }),
    // 行距属于段落属性；关闭文字 mark 层的行距，避免同一个功能出现两种存储方式。
    TextStyleKit.configure({ lineHeight: false }),
    FontWeight,
    Superscript,
    Subscript,
    DocumentTaskList,
    DocumentTaskItem,
    EditingHistory,
    DocumentComments,
    CommentAnchor,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    // 官方列宽拖动使用屏幕增量；由本模块处理缩放坐标，保留官方表格模型和视图。
    TableKit.configure({ table: { resizable: false } }),
    TableAppearance,
    TableColumnResize,
    // 图片解析器拒绝附件资源，附件则同时读取元数据和地址，避免同 ID 的错误种类被渲染成图片。
    DocumentImage.configure({ getAssetUrl: id => getAsset(id)?.kind === "attachment" ? "" : getAssetUrl(id) }),
    DocumentAttachment.configure({ getAssetUrl, getAsset }),
    // 段落布局、格式刷与插入节点在基础模型之后注册，给同一正文添加持久属性和交互命令。
    ParagraphSpacing,
    ParagraphLayout,
    EditorFocus,
    FormattingMarks,
    ParagraphIndent,
    FormatPainter,
    PageBreak,
    InlineMath,
    BlockMath,
    DocumentCodeBlock,
    DocumentTextBox,
    DocumentDetails,
    DocumentNavigation,
    TableOfContents,
    // 查找只注入行为，外观由项目样式负责；输入防抖降低连续输入时重复扫描正文的成本。
    FindAndReplace.configure({ injectCSS: false, searchDebounceMs: 150 }),
    Placeholder.configure({ placeholder: "在这里写下你的想法…" })
  ]
}
