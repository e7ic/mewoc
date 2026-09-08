import { useEditorState } from "@tiptap/react"
import { Button, ColorPicker, Select } from "antd"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { FONT_FAMILIES, FONT_SIZES } from "../constants/editor-constants.js"
import { getSelectionTextStyle } from "../tools/text-appearance.js"
import styles from "../sass/toolbar.module.scss"

export function TextStyleControls() {
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const format = useEditorState({ editor, selector: ({ editor: current }) => getSelectionTextStyle(current) })

  return (
    <div className={styles.row}>
      <Select
        aria-label="字体"
        className={styles.font}
        size="small"
        value={format.fontFamily}
        disabled={readOnly}
        popupMatchSelectWidth={190}
        options={[...(format.fontFamily === "mixed" ? [{ value: "mixed", label: "混合字体", disabled: true }] : []), ...FONT_FAMILIES]}
        onChange={value => editor.chain().focus().setFontFamily(value).run()}
      />
      <Select
        aria-label="字号"
        className={styles.fontSize}
        size="small"
        value={format.fontSize}
        disabled={readOnly}
        options={[...(format.fontSize === "mixed" ? [{ value: "mixed", label: "混合", disabled: true }] : []), ...FONT_SIZES.map(size => ({ value: size, label: size.replace("pt", "") }))]}
        onChange={value => editor.chain().focus().setFontSize(value).run()}
      />
      <ColorPicker
        value={format.color === "mixed" ? "#252837" : format.color}
        disabled={readOnly}
        disabledAlpha
        onChange={color => { if (editor.isEditable) editor.chain().setColor(color.toHexString()).run() }}
      >
        <Button type="text" size="small" className={styles.color} aria-label="文字颜色" title="文字颜色" disabled={readOnly}>
          <span style={{ borderBottomColor: format.color === "mixed" ? "#252837" : format.color }}>A</span>
        </Button>
      </ColorPicker>
      <ColorPicker
        value={format.backgroundColor === "mixed" ? "#fff1ad" : format.backgroundColor}
        disabled={readOnly}
        disabledAlpha
        onChange={color => { if (editor.isEditable) editor.chain().setBackgroundColor(color.toHexString()).run() }}
      >
        <Button type="text" size="small" className={styles.color} aria-label="文字背景色" title="文字背景色" disabled={readOnly}>
          <span style={{ borderBottomColor: format.backgroundColor === "mixed" ? "#fff1ad" : format.backgroundColor }}>▰</span>
        </Button>
      </ColorPicker>
    </div>
  )
}
