/**
 * 提供全文选择与正文/选区字符统计，统计弹窗根据当前不可变文档实时更新。
 * 读取统计与选择不要求退出只读，但会阻止在文档切换、销毁或输入法组合期间启动操作。
 */
import { useMemo, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Modal } from "antd"
import { IconChartBar, IconSelectAll } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { getDocumentStatistics, selectDocumentContents } from "../tools/document-statistics.js"
import styles from "../sass/document-tools.module.scss"

export function DocumentTools() {
  const { editor, store } = useDocumentEditor()
  const switching = useEditorStore(state => state.switching)
  const [open, setOpen] = useState(false)
  // 订阅 doc 和逻辑相同的 selection；自定义比较避免相同选区的新引用触发无效统计计算。
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({ doc: current.state.doc, selection: current.state.selection }),
    equalityFn: (a, b) => a.doc === b.doc && a.selection.eq(b.selection) })
  // 统计弹窗关闭时无需随每次光标移动遍历全文；打开后仍同步正文和选区变化。
  const statistics = useMemo(() => open ? getDocumentStatistics(state.doc, state.selection) : null, [open, state.doc, state.selection])
  // 操作入口读取实时 store，而不依赖上一次 React 渲染的 switching，防止切换开始后的延迟点击。
  const getBlocked = () => store.getState().switching || editor.isDestroyed || editor.view.composing
  const handleSelectAll = () => selectDocumentContents(editor, getBlocked())
  const handleOpen = () => { if (!getBlocked()) setOpen(true) }
  const handleCancel = () => setOpen(false)

  // 有实际选区时才增加选区统计列；统计仅展示字符和段落，不修改正文或选区内容。
  return <>
    <div className={styles.toolbar} data-document-tools>
      <Button type="text" size="small" aria-label="全选" title="全选" disabled={switching}
        icon={<IconSelectAll aria-hidden="true" />} onMouseDown={event => event.preventDefault()} onClick={handleSelectAll}>全选</Button>
      <Button type="text" size="small" aria-label="字数统计" title="字数统计" disabled={switching}
        icon={<IconChartBar aria-hidden="true" />} onMouseDown={event => event.preventDefault()} onClick={handleOpen}>字数统计</Button>
    </div>
    <Modal title="字数统计" open={open} onCancel={handleCancel} width={460}
      footer={<Button onClick={handleCancel}>关闭</Button>} destroyOnHidden>
      <p className={styles.hint}>按文字字符统计；段落数包括标题、代码块和表格内段落。</p>
      {statistics && <table className={styles.statistics} aria-label="文档字符和段落统计">
        <thead><tr><th scope="col">统计项</th><th scope="col">正文</th>{statistics.selection && <th scope="col">当前选区</th>}</tr></thead>
        <tbody>{[
          ["characters", "字符（含空白）"], ["charactersWithoutWhitespace", "字符（不含空白）"], ["paragraphs", "段落"]
        ].map(([key, label]) => <tr key={key}><th scope="row">{label}</th>
          <td data-statistics-scope="document" data-statistics-field={key}>{statistics.document[key].toLocaleString()}</td>
          {statistics.selection && <td data-statistics-scope="selection" data-statistics-field={key}>{statistics.selection[key].toLocaleString()}</td>}
        </tr>)}</tbody>
      </table>}
    </Modal>
  </>
}
