/**
 * 从正文标题构建可点击的大纲，按标题层级缩进并定位回正文。
 * 大纲是当前不可变文档的派生视图，正文变化后重新生成位置，避免缓存失效节点坐标。
 */
import { useMemo } from "react"
import { useEditorState } from "@tiptap/react"
import { IconListTree, IconX } from "@tabler/icons-react"
import { useDocumentEditor } from "./EditorProvider.jsx"
import styles from "../sass/panels.module.scss"

export function OutlinePanel() {
  const { editor, store } = useDocumentEditor()
  // 只订阅不可变 doc 引用，移动光标无需重新扫描大纲；正文变更后重建位置，避免缓存旧 pos。
  const doc = useEditorState({ editor, selector: ({ editor: current }) => current.state.doc, equalityFn: (a, b) => a === b })
  // 遍历标题节点采集 pos、级别与纯文本，计算结果仅在 doc 更新时重建。
  const headings = useMemo(() => {
    const items = []
    doc.descendants((node, pos) => {
      if (node.type.name === "heading") items.push({ pos, level: node.attrs.level, text: node.textContent })
    })
    return items
  }, [doc])

  const handleLocate = heading => {
    // 标题节点位置在内容起点之前，+1 才落入可编辑文字；滚动定位仍使用节点自身位置。
    editor.chain().focus().setTextSelection(heading.pos + 1).run()
    editor.view.nodeDOM(heading.pos)?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  // 列表按钮根据标题级别增加左侧留白；无标题时展示空态，收起操作只改变视图状态。
  return (
    <aside className={styles.container} aria-label="文档大纲">
      <div className={styles.header}>
        <strong><IconListTree aria-hidden="true" /> 文档大纲</strong>
        <button type="button" aria-label="收起大纲" onClick={() => store.getState().updateView({ outlineOpen: false })}><IconX aria-hidden="true" /></button>
      </div>
      <nav className={styles.outline}>
        {headings.map(heading => (
          <button key={heading.pos} type="button" style={{ paddingLeft: 16 + (heading.level - 1) * 12 }} onClick={() => handleLocate(heading)}>
            <span className={styles.dot} />{heading.text || "未命名标题"}
          </button>
        ))}
        {!headings.length && <p className={styles.empty}>暂无标题</p>}
      </nav>
    </aside>
  )
}
