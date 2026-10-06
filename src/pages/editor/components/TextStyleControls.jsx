/**
 * 文字外观工具集中管理字体、字号、前景色和背景色，同时接纳基础格式按钮作为子内容。
 * 显示格式从正文选区派生，菜单状态留在 UI；执行命令时再次验证活动面板与会话可编辑性。
 */
import { useEffect, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Select } from "antd"
import { IconHighlight, IconTextColor, IconTextIncrease, IconTextDecrease, IconChevronDown } from "@tabler/icons-react"
import { ToolbarButton } from "./ToolbarButton.jsx"
import { TextColorPicker } from "./TextColorPicker.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { FONT_FAMILIES, FONT_SIZES } from "../constants/editor-constants.js"
import { getSelectionTextStyle } from "../tools/text-appearance.js"
import { canEditRibbon, getSteppedFontSize, stepFontSize } from "../tools/ribbon-commands.js"
import styles from "../sass/ribbon-controls.module.scss"

export function TextStyleControls({ active = true, resetKey = "", children }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const [openControl, setOpenControl] = useState("")
  // 从正文选区派生回显，不在组件保存第二份格式；默认标题样式和混合选区由同一读取器处理。
  const format = useEditorState({ editor, selector: ({ editor: current }) => getSelectionTextStyle(current) })
  // 按钮禁用只是视觉反馈，事件处理还需查实时 store 与输入法状态，防止隐藏面板继续提交。
  const getBlocked = () => {
    const current = store.getState()
    return !active || !canEditRibbon(editor, current.readOnly || current.switching)
  }
  // 同一时刻只打开一个字体/字号/颜色浮层，新的入口自动取代旧入口。
  const handleOpen = (control, open) => setOpenControl(open && !getBlocked() ? control : "")
  // 字体和字号选择直接写回当前正文选区，成功后收起列表，避免持续遮挡编辑区。
  const handleFontChange = (command, value) => {
    if (getBlocked()) return
    editor.chain().focus()[command](value).run()
    setOpenControl("")
  }
  // 字号加减使用预设档位和有效范围；只有命令成功才把焦点还给正文。
  const handleStep = direction => {
    if (stepFontSize(editor, direction, getBlocked())) editor.commands.focus()
  }
  // 颜色控件可能正在输入通道数值，提交时不额外抢回正文焦点，以便连续编辑颜色。
  const handleColorChange = (command, color) => {
    if (getBlocked()) return
    editor.chain()[command](color.toHexString()).run()
  }

  // 隐藏的工具栏仍挂载，显式关闭 portal，避免切换页签后弹层遮住其他工具栏。
  useEffect(() => { if (!active || readOnly) setOpenControl("") }, [active, readOnly])
  useEffect(() => { setOpenControl("") }, [resetKey])

  // 混合字体/字号保留独立禁选提示，颜色使用展示占位但由 mixed 标记确保用户明确选择会实际应用。
  return <div className={`${styles.group} ${styles.fontGroup}`} data-ribbon-group="font">
    <div className={styles.row} data-ribbon-row="primary">
      <Select suffixIcon={<IconChevronDown aria-hidden="true" />} aria-label="字体" className={styles.font} size="small" value={format.fontFamily} disabled={readOnly}
        open={openControl === "font"} onOpenChange={open => handleOpen("font", open)} popupMatchSelectWidth={190}
        options={[...(format.fontFamily === "mixed" ? [{ value: "mixed", label: "混合字体", disabled: true }] : []), ...FONT_FAMILIES]}
        onChange={value => handleFontChange("setFontFamily", value)} />
      <Select suffixIcon={<IconChevronDown aria-hidden="true" />} aria-label="字号" className={styles.fontSize} size="small" value={format.fontSize} disabled={readOnly}
        open={openControl === "size"} onOpenChange={open => handleOpen("size", open)}
        options={[...(format.fontSize === "mixed" ? [{ value: "mixed", label: "混合", disabled: true }] : []), ...FONT_SIZES.map(size => ({ value: size, label: size.replace("pt", "") }))]}
        onChange={value => handleFontChange("setFontSize", value)} />
      <ToolbarButton label="增大字号" disabled={readOnly || !getSteppedFontSize(format.fontSize, 1)} onClick={() => handleStep(1)}>
        <IconTextIncrease aria-hidden="true" />
      </ToolbarButton>
      <ToolbarButton label="减小字号" disabled={readOnly || !getSteppedFontSize(format.fontSize, -1)} onClick={() => handleStep(-1)}>
        <IconTextDecrease aria-hidden="true" />
      </ToolbarButton>
    </div>
    <div className={styles.row} data-ribbon-row="secondary">
      {children}
      <TextColorPicker label="文字颜色" mixed={format.color === "mixed"} value={format.color === "mixed" ? "#252837" : format.color} disabled={readOnly} isBlocked={getBlocked}
        open={openControl === "color"} onOpenChange={open => handleOpen("color", open)}
        onChange={color => handleColorChange("setColor", color)}>
        <Button type="text" size="small" className={styles.color} aria-label="文字颜色" title="文字颜色" disabled={readOnly}
          onMouseDown={event => event.preventDefault()}>
          <span className={styles.colorIcon} style={{ borderBottomColor: format.color === "mixed" ? "#252837" : format.color }}><IconTextColor aria-hidden="true" /></span>
        </Button>
      </TextColorPicker>
      <TextColorPicker label="文字背景色" mixed={format.backgroundColor === "mixed"} value={format.backgroundColor === "mixed" ? "#fff1ad" : format.backgroundColor} disabled={readOnly} isBlocked={getBlocked}
        open={openControl === "highlight"} onOpenChange={open => handleOpen("highlight", open)}
        onChange={color => handleColorChange("setBackgroundColor", color)}>
        <Button type="text" size="small" className={styles.color} aria-label="文字背景色" title="文字背景色" disabled={readOnly}
          onMouseDown={event => event.preventDefault()}>
          <span className={styles.colorIcon} style={{ borderBottomColor: format.backgroundColor === "mixed" ? "#fff1ad" : format.backgroundColor }}><IconHighlight aria-hidden="true" /></span>
        </Button>
      </TextColorPicker>
    </div>
  </div>
}
