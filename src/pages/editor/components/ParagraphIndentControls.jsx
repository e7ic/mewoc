import { useEditorState } from "@tiptap/react"
import { Select } from "antd"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { getIndentParagraphs } from "../extensions/paragraph-indent.js"
import { FIRST_LINE_INDENTS, LEFT_INDENTS } from "../constants/editor-constants.js"
import styles from "../sass/toolbar.module.scss"

export function ParagraphIndentControls() {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const state = useEditorState({ editor, selector: ({ editor: current }) => {
    // 回显与执行共用段落范围算法，避免选区边缘在控件和命令中被解释成不同段落。
    const paragraphs = getIndentParagraphs(current.state)
    const firstLines = new Set(paragraphs.map(({ node }) => node.attrs.firstLineIndent ?? 0))
    const lefts = new Set(paragraphs.map(({ node }) => node.attrs.leftIndent ?? 0))
    return {
      disabled: !paragraphs.length,
      firstLine: firstLines.size > 1 ? "mixed" : [...firstLines][0] ?? 0,
      left: lefts.size > 1 ? "mixed" : [...lefts][0] ?? 0
    }
  } })

  return (
    <div className={styles.group}>
      <Select
        aria-label="首行缩进" className={styles.indentation} size="small"
        value={state.firstLine} disabled={readOnly || state.disabled}
        options={[...(state.firstLine === "mixed" ? [{ value: "mixed", label: "首行：混合", disabled: true }] : []),
          ...FIRST_LINE_INDENTS.map(value => ({ value, label: `首行：${value} 字符` }))]}
        onChange={value => editor.chain().focus().setParagraphIndent({ firstLineIndent: value }).run()}
      />
      <Select
        aria-label="左侧缩进" className={styles.indentation} size="small"
        value={state.left} disabled={readOnly || state.disabled}
        options={[...(state.left === "mixed" ? [{ value: "mixed", label: "左侧：混合", disabled: true }] : []),
          ...LEFT_INDENTS.map(value => ({ value, label: `左侧：${value} 字符` }))]}
        onChange={value => editor.chain().focus().setParagraphIndent({ leftIndent: value }).run()}
      />
    </div>
  )
}
