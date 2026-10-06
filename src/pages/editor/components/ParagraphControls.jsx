/**
 * 组合段落对齐、列表、行距、缩进和详细设置，回显当前选区的实际段落样式。
 * 文字段落与标题的默认显示值统一读取，多段落差异展示混合态而不自动覆盖原值。
 */
import { useEffect, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Select } from "antd"
import { IconAlignLeft, IconAlignCenter, IconAlignRight, IconAlignJustified, IconListNumbers, IconList, IconListCheck, IconIndentIncrease, IconIndentDecrease, IconCode, IconBlockquote, IconChevronDown } from "@tabler/icons-react"
import { ToolbarButton } from "./ToolbarButton.jsx"
import { ParagraphIndentControls } from "./ParagraphIndentControls.jsx"
import { ParagraphSettings } from "./ParagraphSettings.jsx"
import { ListNumberingControls } from "./ListNumberingControls.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { LINE_HEIGHTS } from "../constants/editor-constants.js"
import { getTextAppearance } from "../tools/text-appearance.js"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import { getCurrentListType, supportsDocumentListSelection } from "../extensions/document-task-list.js"
import styles from "../sass/ribbon-controls.module.scss"

export function ParagraphControls({ active = true, resetKey = "" }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const [lineHeightOpen, setLineHeightOpen] = useState(false)
  // 列表层级、行内代码、引用及命令能力从编辑器读取，结构不支持的操作对应禁用。
  const state = useEditorState({ editor, selector: ({ editor: current }) => {
    // 只读取光标所在的最近列表，嵌套普通列表不能继承外层待办的项目类型。
    const listType = getCurrentListType(current)
    const itemType = listType === "taskList" ? "taskItem" : "listItem"
    return {
      ...getParagraphStyle(current),
      bullet: listType === "bulletList", ordered: listType === "orderedList", task: listType === "taskList",
      supportsList: supportsDocumentListSelection(current),
      code: current.isActive("code"), quote: current.isActive("blockquote"),
      canCode: current.can().toggleCode(), canQuote: current.can().toggleBlockquote(),
      itemType,
      indent: current.can().sinkListItem(itemType),
      outdent: current.can().liftListItem(itemType)
    }
  } })
  // 正文命令使用实时状态保护，active 限制隐藏面板，canEditRibbon 同时处理可编辑与组合输入条件。
  const getBlocked = () => {
    const current = store.getState()
    return !active || !canEditRibbon(editor, current.readOnly || current.switching)
  }
  // 统一参数化与无参数命令，恢复正文焦点后执行，避免每个按钮建立不同的命令路径。
  const handleCommand = (command, value) => {
    if (getBlocked()) return
    const chain = editor.chain().focus()
    if (value === undefined) chain[command]().run()
    else chain[command](value).run()
  }
  // 选择行距通过段落扩展命令应用，再关闭下拉；多段落混合状态只用于展示。
  const handleSpacing = value => {
    handleCommand("setParagraphSpacing", value)
    setLineHeightOpen(false)
  }
  const handleOpenChange = open => setLineHeightOpen(open && !getBlocked())
  // 失活、只读或布局重排时关闭行距下拉，避免保持挂载的隐藏工具栏留下浮层。
  useEffect(() => { if (!active || readOnly) setLineHeightOpen(false) }, [active, readOnly])
  useEffect(() => { setLineHeightOpen(false) }, [resetKey])

  // 列表缩进与普通段落缩进分别由对应命令处理；详细段落弹窗负责段前后距与分页选项。
  return <div className={`${styles.group} ${styles.paragraphGroup}`} data-ribbon-group="paragraph">
    <div className={styles.row} data-ribbon-row="primary">
      <div className={styles.split}>
        <ToolbarButton label="有序列表" active={state.ordered} disabled={readOnly || !state.supportsList} onClick={() => handleCommand("toggleDocumentList", "orderedList")}><IconListNumbers aria-hidden="true" /></ToolbarButton>
        <ListNumberingControls active={active} resetKey={resetKey} />
      </div>
      <ToolbarButton label="无序列表" active={state.bullet} disabled={readOnly || !state.supportsList} onClick={() => handleCommand("toggleDocumentList", "bulletList")}><IconList aria-hidden="true" /></ToolbarButton>
      <ToolbarButton label="待办清单" active={state.task} disabled={readOnly || !state.supportsList} onClick={() => handleCommand("toggleDocumentList", "taskList")}><IconListCheck aria-hidden="true" /></ToolbarButton>
      <ToolbarButton label="列表减少缩进" disabled={readOnly || !state.outdent} onClick={() => handleCommand("liftListItem", state.itemType)}><IconIndentDecrease aria-hidden="true" /></ToolbarButton>
      <ToolbarButton label="列表增加缩进" disabled={readOnly || !state.indent} onClick={() => handleCommand("sinkListItem", state.itemType)}><IconIndentIncrease aria-hidden="true" /></ToolbarButton>
      <Select suffixIcon={<IconChevronDown aria-hidden="true" />} aria-label="段落行距" className={styles.lineHeight} size="small" value={state.lineHeight} disabled={readOnly}
        open={lineHeightOpen} onOpenChange={handleOpenChange}
        options={[...(state.lineHeight === "mixed" ? [{ value: "mixed", label: "混合行距", disabled: true }] : []), ...LINE_HEIGHTS.map(height => ({ value: height, label: `${height} 倍` }))]}
        onChange={handleSpacing} />
      <ParagraphIndentControls active={active} resetKey={resetKey} />
    </div>
    <div className={styles.row} data-ribbon-row="secondary">
      {[
        ["left", "左对齐", <IconAlignLeft aria-hidden="true" key="left" />],
        ["center", "居中对齐", <IconAlignCenter aria-hidden="true" key="center" />],
        ["right", "右对齐", <IconAlignRight aria-hidden="true" key="right" />],
        ["justify", "两端对齐", <IconAlignJustified aria-hidden="true" key="justify" />]
      ].map(([align, label, icon]) => <ToolbarButton key={align} label={label} active={state.align === align}
        disabled={readOnly} onClick={() => handleCommand("setTextAlign", align)}>{icon}</ToolbarButton>)}
      <ToolbarButton label="行内代码" active={state.code} disabled={readOnly || !state.canCode} onClick={() => handleCommand("toggleCode")}><IconCode aria-hidden="true" /></ToolbarButton>
      <ToolbarButton label="引用块" active={state.quote} disabled={readOnly || !state.canQuote} onClick={() => handleCommand("toggleBlockquote")}><IconBlockquote aria-hidden="true" /></ToolbarButton>
      <ParagraphSettings compact />
    </div>
  </div>
}

// 汇总选区涉及的段落，逐属性判断混合态；行距读取实际 CSS，包含标题未显式设置的默认值。
function getParagraphStyle(editor) {
  const { selection, doc } = editor.state
  const blocks = []
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (["paragraph", "heading"].includes(node.type.name)) blocks.push({ node, pos })
  })
  const heights = new Set(blocks.map(({ pos }) => getTextAppearance(editor, pos + 1).lineHeight))
  const alignments = new Set(blocks.map(({ node }) => node.attrs.textAlign || "left"))
  return {
    lineHeight: heights.size > 1 ? "mixed" : [...heights][0] || 1.75,
    align: alignments.size > 1 ? "mixed" : [...alignments][0] || "left"
  }
}
