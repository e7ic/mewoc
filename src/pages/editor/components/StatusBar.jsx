/**
 * 持续显示正文字符数、资源读取/只读状态和大纲入口，并提供页面视图缩放控制。
 * 缩放和侧栏都属于视图状态，不改变文档内容与正文撤销记录。
 */
import { useMemo } from "react"
import { useEditorState } from "@tiptap/react"
import { Slider } from "antd"
import { IconListTree, IconMinus, IconPlus } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import styles from "../sass/status-bar.module.scss"

export function StatusBar() {
  const { editor, store, uploading } = useDocumentEditor()
  const zoom = useEditorStore(state => state.zoom)
  const readOnly = useEditorStore(state => state.readOnly)
  const outlineOpen = useEditorStore(state => state.outlineOpen)
  const pagination = useEditorStore(state => state.pagination)
  const doc = useEditorState({ editor, selector: ({ editor: current }) => current.state.doc, equalityFn: (a, b) => a === b })
  // 排除空白后按 Unicode 码点计数；这是正文文本字符数，不是中文分词或可见字形数量。
  // 只在 doc 变化时重算，光标移动和缩放不重复遍历全文。
  const count = useMemo(() => [...doc.textBetween(0, doc.content.size, "\n").replace(/\s/g, "")].length, [doc])

  // 手动调节退出自动适宽，否则下一次尺寸观察会覆盖用户选定的缩放值。
  const handleZoom = value => store.getState().updateView({ zoom: Math.min(1.5, Math.max(0.5, value)), fitWidth: false })

  // 滑块使用百分数展示，store 保存比例值；加减按钮与滑块共享 50%–150% 的缩放范围。
  return (
    <footer className={styles.container}>
      <div className={styles.info}>
        <button
          type="button"
          aria-label="切换文档大纲"
          aria-pressed={outlineOpen}
          onClick={() => store.getState().updateView({ outlineOpen: !outlineOpen })}
        ><IconListTree aria-hidden="true" /></button>
        <span>{count.toLocaleString()} 字符（不含空白）</span>
        {pagination?.pageCount > 0 && <span data-pagination-status="" title={`${pagination.overflowCount ? "超高内容页完整显示尚未拆分的长段落或表格。" : ""}${pagination.constraintCount ? "连续的同页设置超出一页，可减少段间距或关闭部分与下段同页设置。" : ""}此处页数用于编辑视图，打印和 Word 会独立排版。`}>
          {pagination.overflowCount ? `${pagination.pageCount} 张纸面 · ${pagination.overflowCount} 张超高内容页` : `共 ${pagination.pageCount} 页`}
          {pagination.constraintCount > 0 && " · 同页设置待调整"}
        </span>}
        <span>{uploading ? "正在读取资源…" : readOnly ? "只读模式" : "编辑模式"}</span>
      </div>
      <div className={styles.zoom}>
        <button type="button" onClick={() => store.getState().updateView({ fitWidth: true })}>适应宽度</button>
        <button type="button" aria-label="缩小" disabled={zoom <= 0.5} onClick={() => handleZoom(zoom - 0.1)}><IconMinus aria-hidden="true" /></button>
        <Slider
          className={styles.slider}
          ariaLabelForHandle="页面缩放"
          min={50}
          max={150}
          value={Math.round(zoom * 100)}
          tooltip={{ formatter: value => `${value}%` }}
          onChange={value => handleZoom(value / 100)}
        />
        <button type="button" aria-label="放大" disabled={zoom >= 1.5} onClick={() => handleZoom(zoom + 0.1)}><IconPlus aria-hidden="true" /></button>
        <span>{Math.round(zoom * 100)}%</span>
      </div>
    </footer>
  )
}
