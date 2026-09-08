import { useEditorState } from "@tiptap/react"
import { Select } from "antd"
import { AlignLeftOutlined, AlignCenterOutlined, AlignRightOutlined, MenuOutlined, OrderedListOutlined, UnorderedListOutlined, MenuUnfoldOutlined, MenuFoldOutlined } from "@ant-design/icons"
import { ToolbarButton } from "./ToolbarButton.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { LINE_HEIGHTS } from "../constants/editor-constants.js"
import { getTextAppearance } from "../tools/text-appearance.js"
import styles from "../sass/toolbar.module.scss"

export function ParagraphControls() {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({
    ...getParagraphStyle(current),
    bullet: current.isActive("bulletList"), ordered: current.isActive("orderedList"),
    indent: current.can().sinkListItem("listItem"), outdent: current.can().liftListItem("listItem")
  }) })

  const handleHeading = level => {
    if (level) editor.chain().focus().setHeading({ level }).run()
    else editor.chain().focus().setParagraph().run()
  }

  return (
    <div className={styles.group}>
      <div className={styles.row}>
        <Select
          aria-label="段落样式"
          className={styles.paragraph}
          size="small"
          value={state.heading}
          disabled={readOnly}
          options={[...(state.heading === "mixed" ? [{ value: "mixed", label: "混合样式", disabled: true }] : []), ...[0, 1, 2, 3].map(level => ({ value: level, label: level ? `标题 ${level}` : "正文" }))]}
          onChange={handleHeading}
        />
        <Select
          aria-label="段落行距"
          className={styles.spacing}
          size="small"
          value={state.lineHeight}
          disabled={readOnly}
          options={[...(state.lineHeight === "mixed" ? [{ value: "mixed", label: "混合行距", disabled: true }] : []), ...LINE_HEIGHTS.map(height => ({ value: height, label: `${height} 倍` }))]}
          onChange={value => editor.chain().focus().setParagraphSpacing(value).run()}
        />
        <ToolbarButton
          label="无序列表"
          active={state.bullet}
          disabled={readOnly}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        ><UnorderedListOutlined /></ToolbarButton>
        <ToolbarButton
          label="有序列表"
          active={state.ordered}
          disabled={readOnly}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        ><OrderedListOutlined /></ToolbarButton>
      </div>
      <div className={styles.row}>
        <AlignmentControls editor={editor} align={state.align} readOnly={readOnly} />
        <ToolbarButton
          label="列表增加缩进"
          disabled={readOnly || !state.indent}
          onClick={() => editor.chain().focus().sinkListItem("listItem").run()}
        ><MenuUnfoldOutlined /></ToolbarButton>
        <ToolbarButton
          label="列表减少缩进"
          disabled={readOnly || !state.outdent}
          onClick={() => editor.chain().focus().liftListItem("listItem").run()}
        ><MenuFoldOutlined /></ToolbarButton>
      </div>
    </div>
  )
}

const AlignmentControls = ({ editor, align, readOnly }) => (
  <>
    <ToolbarButton
      label="左对齐"
      active={align === "left"}
      disabled={readOnly}
      onClick={() => editor.chain().focus().setTextAlign("left").run()}
    ><AlignLeftOutlined /></ToolbarButton>
    <ToolbarButton
      label="居中对齐"
      active={align === "center"}
      disabled={readOnly}
      onClick={() => editor.chain().focus().setTextAlign("center").run()}
    ><AlignCenterOutlined /></ToolbarButton>
    <ToolbarButton
      label="右对齐"
      active={align === "right"}
      disabled={readOnly}
      onClick={() => editor.chain().focus().setTextAlign("right").run()}
    ><AlignRightOutlined /></ToolbarButton>
    <ToolbarButton
      label="两端对齐"
      active={align === "justify"}
      disabled={readOnly}
      onClick={() => editor.chain().focus().setTextAlign("justify").run()}
    ><MenuOutlined /></ToolbarButton>
  </>
)

function getParagraphStyle(editor) {
  const { selection, doc } = editor.state
  const blocks = []
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (["paragraph", "heading"].includes(node.type.name)) blocks.push({ node, pos })
  })
  const headings = new Set(blocks.map(({ node }) => node.type.name === "heading" ? node.attrs.level : 0))
  const heights = new Set(blocks.map(({ pos }) => getTextAppearance(editor, pos + 1).lineHeight))
  const alignments = new Set(blocks.map(({ node }) => node.attrs.textAlign || "left"))
  return {
    heading: headings.size > 1 ? "mixed" : [...headings][0] || 0,
    lineHeight: heights.size > 1 ? "mixed" : [...heights][0] || 1.75,
    align: alignments.size > 1 ? "mixed" : [...alignments][0] || "left"
  }
}
