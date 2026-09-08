import { useMemo } from "react"
import { useEditorState } from "@tiptap/react"
import { AlignLeftOutlined, CloseOutlined } from "@ant-design/icons"
import { useDocumentEditor } from "./EditorProvider.jsx"
import styles from "../sass/panels.module.scss"

export function OutlinePanel() {
  const { editor, store } = useDocumentEditor()
  // 只订阅不可变 doc 引用，移动光标无需重新扫描大纲；正文变更后重建位置，避免缓存旧 pos。
  const doc = useEditorState({ editor, selector: ({ editor: current }) => current.state.doc, equalityFn: (a, b) => a === b })
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

  return (
    <aside className={styles.container} aria-label="文档大纲">
      <div className={styles.header}>
        <strong><AlignLeftOutlined /> 文档大纲</strong>
        <button type="button" aria-label="收起大纲" onClick={() => store.getState().updateView({ outlineOpen: false })}><CloseOutlined /></button>
      </div>
      <p className={styles.caption}>用标题，理清每一个思路</p>
      <nav className={styles.outline}>
        {headings.map(heading => (
          <button key={heading.pos} type="button" style={{ paddingLeft: 16 + (heading.level - 1) * 12 }} onClick={() => handleLocate(heading)}>
            <span className={styles.dot} />{heading.text || "未命名标题"}
          </button>
        ))}
        {!headings.length && <p className={styles.empty}>为段落设置标题，<br />即可在这里快速定位。</p>}
      </nav>
      <div className={styles.note}><span>一点写作提示</span><p>先记录想法，<br />再慢慢雕琢。</p><small>⌘ / Ctrl + S 保存文档</small></div>
    </aside>
  )
}
