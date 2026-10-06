/**
 * 表格详细设置弹窗编辑单元格、整表边框及逻辑行列尺寸，草稿与原目标范围独立维护。
 * 仅提交已修改字段，保留混合单元格各自值；均分列宽和手动列宽互斥。
 */
import { useEffect, useRef, useState } from "react"
import { Button, Modal } from "antd"
import { IconSettings } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { applyTableSettings, captureTableTarget, mapTableTarget, readTableSettings, TABLE_MIXED } from "../tools/table-settings.js"
import styles from "../sass/table-settings.module.scss"

// 数字输入边界和字段标签集中定义，UI 范围用于提示，最终提交仍由工具层整体校验。
const numericFields = {
  paddingX: [0, 40], paddingY: [0, 40], borderWidth: [0, 6],
  columnWidth: [35, 2000], rowMinHeight: [1, 1000]
}
const labels = {
  backgroundColor: "背景颜色", verticalAlign: "垂直对齐", paddingX: "水平内边距", paddingY: "垂直内边距",
  borderColor: "边框颜色", borderWidth: "边框粗细", borderStyle: "边框线型", columnWidth: "选中列宽", rowMinHeight: "选中行最小高度"
}

export function TableSettings({ visible = true, triggerClassName }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  // targetRef 保存打开时的表格/单元格范围，draft 控制弹窗，dirty 决定提交哪些属性。
  const targetRef = useRef(null)
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState({})
  const [error, setError] = useState("")

  // 正文事务只映射目标不重读草稿，原表格或单元格丢失时显示错误；卸载解除监听。
  useEffect(() => {
    if (!editor) return
    const handleTransaction = ({ transaction, appendedTransactions = [] }) => {
      // Tiptap 将 tableEditing/fixTables 的追加事务合并成同一次事件，必须逐个映射完整链。
      const transactions = [transaction, ...appendedTransactions]
      if (targetRef.current && transactions.some(current => !mapTableTarget(targetRef.current, current))) {
        setError("原表格或选中的单元格已被删除或替换，请关闭后重新选择。")
      }
    }
    editor.on("transaction", handleTransaction)
    return () => editor.off("transaction", handleTransaction)
  }, [editor])

  // 捕获并汇总目标属性，复制为独立草稿并清脏标记；范围计数用于解释各设置的应用范围。
  const handleOpen = () => {
    if (readOnly || !editor?.isEditable || editor.isDestroyed || editor.view.composing) return
    const target = captureTableTarget(editor)
    const values = target && readTableSettings(editor, target)
    if (!values) return
    // 状态只初始化一次，后续正文事务仅映射 target；焦点、只读切换都不会重置正在编辑的草稿。
    targetRef.current = target
    setDraft({ ...values.cell, ...values.border, ...values.dimensions, distributeColumns: false, scope: values.scope })
    setDirty({})
    setError("")
  }
  // 取消或保存成功统一清空目标与草稿，避免下次打开沿用已映射的旧范围。
  const handleCancel = () => {
    targetRef.current = null
    setDraft(null)
    setDirty({})
    setError("")
  }
  // 单字段更新与脏标记同步；手动改列宽自动退出均分状态，保留其他未触碰属性。
  const change = (key, value) => {
    setDraft(previous => ({ ...previous, [key]: value, ...(key === "columnWidth" ? { distributeColumns: false } : {}) }))
    setDirty(previous => ({ ...previous, [key]: true, ...(key === "columnWidth" ? { distributeColumns: false } : {}) }))
  }
  // 实时检查只读/切换，再按单元格、边框、尺寸组装最小补丁；均分启用时不同时提交手动列宽。
  const save = event => {
    event.preventDefault()
    const state = store.getState()
    if (state.readOnly || state.switching) {
      setError("当前文档不可编辑，请恢复编辑后再应用。")
      return
    }
    const patch = { cell: {}, border: {}, dimensions: {} }
    for (const key of Object.keys(dirty).filter(key => dirty[key] && !(key === "columnWidth" && draft.distributeColumns))) {
      const group = ["backgroundColor", "verticalAlign", "paddingX", "paddingY"].includes(key) ? "cell" : ["borderColor", "borderWidth", "borderStyle"].includes(key) ? "border" : "dimensions"
      patch[group][key] = draft[key]
    }
    const result = applyTableSettings(editor, targetRef.current, patch, state.readOnly || state.switching)
    if (!result.ok) {
      setError(result.error)
      return
    }
    handleCancel()
    editor.commands.focus()
  }

  // null 展示自动尺寸，mixed 展示范围差异，清空输入恢复默认；原始数值交给最终命令验证。
  const numericInput = key => {
    const value = draft[key]
    return <label className={styles.field} key={key}>
      <span>{labels[key]} <small>px</small></span>
      <input aria-label={labels[key]} type="number" min={numericFields[key][0]} max={numericFields[key][1]} step={1}
        value={value === TABLE_MIXED || value === null ? "" : value}
        placeholder={value === TABLE_MIXED ? "混合（保持各自设置）" : "自动"}
        onChange={event => change(key, event.target.value === "" ? null : Number(event.target.value))} />
    </label>
  }
  // 无背景与混合颜色在输入框中都为空但通过占位区分；背景清空提交 null，边框保持文本供校验。
  const colorInput = key => <label className={styles.field}>
    <span>{labels[key]}</span>
    <input aria-label={labels[key]} type="text" value={draft[key] === TABLE_MIXED || draft[key] === null ? "" : draft[key]}
      placeholder={draft[key] === TABLE_MIXED ? "混合（保持各自设置）" : "无背景"} maxLength={7}
      onChange={event => change(key, key === "backgroundColor" && !event.target.value ? null : event.target.value)} />
  </label>
  // 混合值是不可选占位，只有用户选择真实选项才标脏，避免覆盖其他单元格原属性。
  const selectInput = (key, options) => <label className={styles.field}>
    <span>{labels[key]}</span>
    <select aria-label={labels[key]} value={draft[key]} onChange={event => change(key, event.target.value)}>
      {draft[key] === TABLE_MIXED && <option value={TABLE_MIXED} disabled>混合（保持各自设置）</option>}
      {options.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
    </select>
  </label>

  // visible 只控制工具入口，弹窗由 draft 保持；只读保留输入，目标失效阻止应用但允许关闭。
  return <>
    {visible && <button type="button" className={triggerClassName} disabled={readOnly} aria-label="表格设置" onMouseDown={event => event.preventDefault()} onClick={handleOpen}><IconSettings aria-hidden="true" /><span>表格设置</span></button>}
    <Modal className={styles.modal} style={{ top: 24 }} title="表格设置" open={!!draft} onCancel={handleCancel} footer={null} width={600} destroyOnHidden>
      {draft && <form className={styles.form} onSubmit={save}>
        <p className={styles.hint}>混合值表示所选范围内设置不同。只有你修改的字段会应用，其他字段保持各自设置。</p>
        <fieldset disabled={readOnly} className={styles.section}>
          <legend>选中单元格</legend>
          <p>应用到打开弹窗时选中的 {draft.scope.cells} 个单元格。</p>
          <div className={styles.grid}>
            {colorInput("backgroundColor")}
            {selectInput("verticalAlign", [["top", "顶部"], ["middle", "居中"], ["bottom", "底部"]])}
            {numericInput("paddingX")}{numericInput("paddingY")}
          </div>
          <button type="button" className={styles.reset} onClick={() => change("backgroundColor", null)}>无背景</button>
          <small className={styles.hint}>颜色使用 #RRGGBB，例如 #fff3cd。</small>
        </fieldset>
        <fieldset disabled={readOnly} className={styles.section}>
          <legend>整表边框</legend>
          <p>修改的边框字段应用到原表格的所有单元格，包括表头。</p>
          <div className={styles.grid}>
            {colorInput("borderColor")}{numericInput("borderWidth")}
            {selectInput("borderStyle", [["solid", "实线"], ["dashed", "虚线"], ["dotted", "点线"], ["none", "无边框"]])}
          </div>
        </fieldset>
        <fieldset disabled={readOnly} className={styles.section}>
          <legend>尺寸</legend>
          <p>列宽同步到整表对应的 {draft.scope.columns} 个逻辑列；合并单元格包含其覆盖的全部列。行高应用到选中的 {draft.scope.rows} 行，内容较多时仍会自动撑高。</p>
          <div className={styles.grid}>
            {numericInput("columnWidth")}{numericInput("rowMinHeight")}
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.reset} onClick={() => change("rowMinHeight", null)}>自动行高</button>
            <label className={styles.checkbox}><input aria-label="均分整表列宽" type="checkbox" checked={draft.distributeColumns}
              onChange={event => {
                setDraft(previous => ({ ...previous, distributeColumns: event.target.checked }))
                // 均分与手动列宽互斥；取消均分时仍保留此前输入的列宽草稿和 dirty 状态。
                setDirty(previous => ({ ...previous, distributeColumns: event.target.checked }))
              }} />均分整表列宽</label>
          </div>
          {draft.distributeColumns && <small className={styles.hint}>保存时按整表当前宽度，均分全部 {draft.scope.tableColumns} 列。</small>}
        </fieldset>
        {readOnly && <p role="status" className={styles.hint}>当前文档为只读或正在切换，草稿已保留。恢复编辑后可以应用。</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.footer}><Button onClick={handleCancel}>取消</Button><Button type="primary" htmlType="submit" disabled={readOnly || targetRef.current?.valid === false}>应用设置</Button></div>
      </form>}
    </Modal>
  </>
}
