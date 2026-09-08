import { useMemo } from "react"
import { useEditorState } from "@tiptap/react"
import { Slider } from "antd"
import { AlignLeftOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/status-bar.module.scss"

export function StatusBar() {
  const { editor, store, uploading } = useDocumentEditor()
  const zoom = useEditorStore(state => state.zoom)
  const readOnly = useEditorStore(state => state.readOnly)
  const outlineOpen = useEditorStore(state => state.outlineOpen)
  const doc = useEditorState({ editor, selector: ({ editor: current }) => current.state.doc, equalityFn: (a, b) => a === b })
  const count = useMemo(() => [...doc.textBetween(0, doc.content.size, "\n").replace(/\s/g, "")].length, [doc])

  const handleZoom = value => store.getState().updateView({ zoom: Math.min(1.5, Math.max(0.5, value)), fitWidth: false })

  return (
    <footer className={styles.container}>
      <div className={styles.info}>
        <button
          type="button"
          aria-label="切换文档大纲"
          aria-pressed={outlineOpen}
          onClick={() => store.getState().updateView({ outlineOpen: !outlineOpen })}
        ><AlignLeftOutlined /></button>
        <span>{count.toLocaleString()} 字符（不含空白）</span>
        <span>{uploading ? "正在读取资源…" : readOnly ? "只读模式" : "编辑模式"}</span>
      </div>
      <div className={styles.zoom}>
        <button type="button" onClick={() => store.getState().updateView({ fitWidth: true })}>适应宽度</button>
        <button type="button" aria-label="缩小" disabled={zoom <= 0.5} onClick={() => handleZoom(zoom - 0.1)}><MinusOutlined /></button>
        <Slider
          className={styles.slider}
          ariaLabelForHandle="页面缩放"
          min={50}
          max={150}
          value={Math.round(zoom * 100)}
          tooltip={{ formatter: value => `${value}%` }}
          onChange={value => handleZoom(value / 100)}
        />
        <button type="button" aria-label="放大" disabled={zoom >= 1.5} onClick={() => handleZoom(zoom + 0.1)}><PlusOutlined /></button>
        <span>{Math.round(zoom * 100)}%</span>
      </div>
    </footer>
  )
}
