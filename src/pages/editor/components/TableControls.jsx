/**
 * 表格上下文工具集合，提供结构命令、表头、导航、快捷对齐/背景与整表删除确认。
 * 快捷弹层和删除确认各自捕获原表格目标，正文选区变化不会让动作误作用于另一张表。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { TableMap } from "@tiptap/pm/tables"
import { closeHistory } from "@tiptap/pm/history"
import { Modal, Popover } from "antd"
import { IconAlignLeft, IconAlignCenter, IconAlignRight, IconAlignJustified, IconAlignBoxTopCenter, IconAlignBoxCenterMiddle, IconAlignBoxBottomCenter, IconBucketDroplet, IconChevronDown, IconRowInsertTop, IconRowInsertBottom, IconColumnInsertLeft, IconColumnInsertRight, IconRowRemove, IconColumnRemove, IconTableMinus, IconArrowsJoin2, IconArrowsSplit2, IconTableRow, IconTableColumn, IconTable, IconChevronLeft, IconChevronRight } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { TableSettings } from "./TableSettings.jsx"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import { normalizeTableColor } from "../extensions/table-appearance.js"
import { applyTableSettings, captureTableTarget, mapTableTarget, readTableSettings, restoreTableTargetSelection, TABLE_MIXED } from "../tools/table-settings.js"
import styles from "../sass/table-ribbon.module.scss"

// 对齐、色板及命令配置集中驱动工具按钮；命令能力与实际选区同步，避免硬编码可操作假设。
const horizontal = [["left", "左对齐", IconAlignLeft], ["center", "居中对齐", IconAlignCenter], ["right", "右对齐", IconAlignRight], ["justify", "两端对齐", IconAlignJustified]]
const vertical = [["top", "顶部", IconAlignBoxTopCenter], ["middle", "居中", IconAlignBoxCenterMiddle], ["bottom", "底部", IconAlignBoxBottomCenter]]
const colors = ["#ffffff", "#000000", "#fff3cd", "#f8d7da", "#d1e7dd", "#cfe2ff", "#e2d9f3", "#ffe5d0", "#e9ecef", "#f1f8ff", "#e8f5e9", "#fce4ec"]
const commands = ["addRowBefore", "addRowAfter", "addColumnBefore", "addColumnAfter", "deleteRow", "deleteColumn", "deleteTable", "mergeCells", "splitCell", "toggleHeaderRow", "toggleHeaderColumn", "toggleHeaderCell", "goToPreviousCell", "goToNextCell"]
const targetLost = "原表格或选中的单元格已被删除或替换，请关闭后重新选择。"

// 按 TableMap 的逻辑行列判断表头状态，兼容合并单元格；同时读取当前目标值和各命令可执行性。
function getTableState(editor) {
  const target = captureTableTarget(editor)
  const table = target && editor.state.doc.nodeAt(target.tablePos)
  const map = table && TableMap.get(table)
  const header = pos => table.nodeAt(pos)?.type.spec.tableRole === "header_cell"
  return {
    can: Object.fromEntries(commands.map(command => [command, editor.can()[command]() ])),
    values: target && readTableSettings(editor, target),
    headerRow: !!map && map.map.slice(0, map.width).every(header),
    headerColumn: !!map && map.map.filter((_pos, index) => index % map.width === 0).every(header),
    headerCell: !!target && target.cells.every(pos => editor.state.doc.nodeAt(pos)?.type.spec.tableRole === "header_cell")
  }
}

export function TableControls({ active = true, layoutKey = "" }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const state = useEditorState({ editor, selector: ({ editor: current }) => getTableState(current) })
  // 快捷设置与删除拥有两个独立目标 ref；UI 草稿和错误也分别保存，避免确认过程被其他面板覆盖。
  const quickTarget = useRef(null)
  const deleteTarget = useRef(null)
  const [openControl, setOpenControl] = useState("")
  const [values, setValues] = useState(null)
  const [customColor, setCustomColor] = useState("#fff3cd")
  const [error, setError] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState("")

  // 快捷关闭只释放快捷目标；不影响仍待确认的删除目标或正文撤销历史。
  const closeQuickControl = useCallback(() => {
    quickTarget.current = null
    setOpenControl("")
    setError("")
  }, [])
  useEffect(() => { if (!active || readOnly) closeQuickControl() }, [active, readOnly, closeQuickControl])
  useEffect(() => { closeQuickControl() }, [layoutKey, closeQuickControl])
  // 两个目标逐个映射根事务和插件追加事务，映射失败只显示错误；卸载清空目标并解除订阅。
  useEffect(() => {
    // 弹层与删除确认各自保留打开时的表格；正文换选区不会把待执行动作重定向到另一张表。
    const handleTransaction = ({ transaction, appendedTransactions = [] }) => {
      for (const target of [quickTarget.current, deleteTarget.current].filter(Boolean)) {
        for (const current of [transaction, ...appendedTransactions]) mapTableTarget(target, current)
      }
      if (quickTarget.current) {
        setValues(readTableSettings(editor, quickTarget.current))
        if (!quickTarget.current.valid) setError(targetLost)
      }
      if (deleteTarget.current && !deleteTarget.current.valid) setDeleteError(targetLost)
    }
    editor.on("transaction", handleTransaction)
    return () => {
      editor.off("transaction", handleTransaction)
      quickTarget.current = null
      deleteTarget.current = null
    }
  }, [editor])

  // 操作发生时再次读取会话可编辑状态，保护浮层打开后切换只读或文档的情况。
  const blocked = () => {
    const current = store.getState()
    return !canEditRibbon(editor, current.readOnly || current.switching)
  }
  // 打开快捷设置时捕获当前单元格范围并读取其属性，混合背景用占位色初始化自定义输入。
  const handleOpenChange = (control, open) => {
    if (!open) { closeQuickControl(); return }
    if (!active || blocked()) return
    const target = captureTableTarget(editor)
    const current = target && readTableSettings(editor, target)
    if (!current) return
    quickTarget.current = target
    setValues(current)
    setCustomColor(normalizeTableColor(current.cell.backgroundColor) || "#fff3cd")
    setError("")
    setOpenControl(control)
  }
  // 只提交指定属性补丁，并应用到打开时单元格；错误保留面板，成功关闭并回到正文。
  const handleQuickApply = patch => {
    if (!active || blocked()) return
    const result = applyTableSettings(editor, quickTarget.current, patch, blocked())
    if (!result.ok) { setError(result.error); return }
    closeQuickControl()
    editor.commands.focus()
  }
  // 自定义色码先规范化校验，再进入统一表格补丁流程，非法输入不会写入节点。
  const handleColorApply = () => {
    const color = normalizeTableColor(customColor)
    if (!color) { setError("请输入 #RRGGBB 格式的背景颜色。"); return }
    handleQuickApply({ cell: { backgroundColor: color } })
  }
  // 结构变化前后关闭历史合并边界，使行列/合并操作可独立撤销；单元格导航不产生内容历史边界。
  const handleCommand = command => {
    if (!active || blocked() || !editor.can()[command]()) return
    closeQuickControl()
    const navigation = ["goToPreviousCell", "goToNextCell"].includes(command)
    const chain = editor.chain().focus()
    if (!navigation) chain.command(({ tr }) => { closeHistory(tr); return true })
    const applied = chain[command]().run()
    if (applied && !navigation) editor.view.dispatch(closeHistory(editor.state.tr))
  }
  // 整表删除先捕获并确认目标，关闭快捷设置避免两个浮层同时编辑同一上下文。
  const handleDeleteOpen = () => {
    if (!active || blocked() || !state.can.deleteTable) return
    deleteTarget.current = captureTableTarget(editor)
    if (!deleteTarget.current) return
    closeQuickControl()
    setDeleteError("")
    setDeleteOpen(true)
  }
  // 取消或删除成功后统一释放确认目标和错误，下一次删除必须重新选择表格。
  const handleDeleteClose = () => {
    deleteTarget.current = null
    setDeleteOpen(false)
    setDeleteError("")
  }
  // 确认时先恢复原目标选区，再独立执行删除；目标已经被替换/删除时只提示，不追随当前光标。
  const handleDelete = () => {
    if (blocked()) return
    if (!restoreTableTargetSelection(editor, deleteTarget.current)) { setDeleteError(targetLost); return }
    const applied = editor.chain().focus().command(({ tr }) => { closeHistory(tr); return true }).deleteTable().run()
    if (applied) {
      editor.view.dispatch(closeHistory(editor.state.tr))
      handleDeleteClose()
    }
  }
  // 普通结构按钮共享命令可用性和正文选区保留行为，表头按钮额外回显选中语义。
  const button = (command, label, Icon, pressed = false, title = label) => <button key={command} type="button" className={styles.button}
    title={title} aria-label={label} aria-pressed={pressed} disabled={readOnly || !state.can[command]}
    onMouseDown={event => event.preventDefault()} onClick={() => handleCommand(command)}><Icon aria-hidden="true" /><span>{label}</span></button>
  const disabledQuick = readOnly || !values || quickTarget.current?.valid === false
  // 垂直对齐作用于单元格，水平对齐作用于单元格内段落，两者作为同一补丁提交。
  const alignmentPanel = <div className={styles.alignPanel} role="group" aria-label="单元格对齐方式">
    <p className={styles.hint}>应用到打开面板时选中的单元格；水平对齐作用于其中的段落。</p>
    {vertical.map(([verticalAlign, verticalLabel, VerticalIcon]) => <div className={styles.alignRow} key={verticalAlign}>
      <span className={styles.verticalLabel}><VerticalIcon aria-hidden="true" />{verticalLabel}</span>
      {horizontal.map(([textAlign, horizontalLabel, Icon]) => <button type="button" key={textAlign} className={styles.alignOption}
        aria-label={`${verticalLabel}${horizontalLabel}`} title={`${verticalLabel}${horizontalLabel}`}
        aria-pressed={values?.cell.verticalAlign === verticalAlign && values?.paragraph.textAlign === textAlign} disabled={disabledQuick}
        onMouseDown={event => event.preventDefault()} onClick={() => handleQuickApply({ cell: { verticalAlign }, paragraph: { textAlign } })}><Icon aria-hidden="true" /></button>)}
    </div>)}
    {(values?.cell.verticalAlign === TABLE_MIXED || values?.paragraph.textAlign === TABLE_MIXED) && <p className={styles.hint}>当前对齐方式为混合值。</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>
  // 色板、自定义色与无背景共享单元格范围；mixed 仅提示差异，未经选择不会覆盖多单元格原色。
  const colorPanel = <div className={styles.colorPanel} role="group" aria-label="单元格背景颜色">
    <p className={styles.hint}>应用到打开面板时选中的单元格。</p>
    <div className={styles.swatches}>{colors.map(color => <button type="button" key={color} className={styles.swatch}
      style={{ backgroundColor: color }} aria-label={`背景颜色 ${color}`} title={color} aria-pressed={values?.cell.backgroundColor === color}
      disabled={disabledQuick} onMouseDown={event => event.preventDefault()} onClick={() => handleQuickApply({ cell: { backgroundColor: color } })} />)}</div>
    <button type="button" className={styles.reset} disabled={disabledQuick} onClick={() => handleQuickApply({ cell: { backgroundColor: null } })}>无背景</button>
    <label className={styles.colorField}>自定义背景颜色
      <span><input type="color" aria-label="选取背景颜色" value={normalizeTableColor(customColor) || "#fff3cd"} disabled={disabledQuick} onChange={event => setCustomColor(event.target.value)} />
        <input type="text" aria-label="自定义背景颜色" value={customColor} placeholder="#RRGGBB" maxLength={7} disabled={disabledQuick} onChange={event => setCustomColor(event.target.value)} /></span>
    </label>
    <button type="button" className={styles.apply} disabled={disabledQuick} onClick={handleColorApply}>应用颜色</button>
    {values?.cell.backgroundColor === TABLE_MIXED && <p className={styles.hint}>当前背景颜色为混合值。</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>

  // 工具组按插入、设置、删除、合并、表头、导航分区；详细设置与删除确认保持自身草稿和目标。
  return <>
    <fieldset className={styles.ribbon} disabled={readOnly} hidden={!active} style={active ? undefined : { display: "none" }}>
      <legend>表格操作</legend>
      <div className={styles.group} data-ribbon-group="table-appearance">
        <div className={styles.row} data-ribbon-row="primary">
          <Popover title="对齐方式" trigger="click" placement="bottomLeft" open={openControl === "alignment"} onOpenChange={open => handleOpenChange("alignment", open)} content={alignmentPanel} destroyOnHidden>
            <button type="button" className={styles.button} aria-label="对齐方式" title="对齐方式" aria-expanded={openControl === "alignment"}
              disabled={readOnly || !state.values?.paragraph.textAlign} onMouseDown={event => event.preventDefault()}><IconAlignLeft aria-hidden="true" /><span>对齐方式</span><IconChevronDown className={styles.arrow} aria-hidden="true" /></button>
          </Popover>
          <Popover title="背景颜色" trigger="click" placement="bottomLeft" open={openControl === "background"} onOpenChange={open => handleOpenChange("background", open)} content={colorPanel} destroyOnHidden>
            <button type="button" className={styles.button} aria-label="背景颜色" title="背景颜色" aria-expanded={openControl === "background"}
              disabled={readOnly || !state.values} onMouseDown={event => event.preventDefault()}><IconBucketDroplet aria-hidden="true" /><span>背景颜色</span><IconChevronDown className={styles.arrow} aria-hidden="true" /></button>
          </Popover>
        </div>
        <div className={styles.row} data-ribbon-row="secondary"><TableSettings visible={active} triggerClassName={styles.button} /></div>
      </div>
      <div className={styles.group} data-ribbon-group="table-insert">
        <div className={styles.row} data-ribbon-row="primary">{button("addRowBefore", "上方插入行", IconRowInsertTop)}{button("addRowAfter", "下方插入行", IconRowInsertBottom)}</div>
        <div className={styles.row} data-ribbon-row="secondary">{button("addColumnBefore", "左侧插入列", IconColumnInsertLeft)}{button("addColumnAfter", "右侧插入列", IconColumnInsertRight)}</div>
      </div>
      <div className={styles.group} data-ribbon-group="table-delete">
        <div className={styles.row} data-ribbon-row="primary">{button("deleteRow", "删除行", IconRowRemove)}{button("deleteColumn", "删除列", IconColumnRemove)}</div>
        <div className={styles.row} data-ribbon-row="secondary"><button type="button" className={`${styles.button} ${styles.danger}`} aria-label="删除表格" disabled={readOnly || !state.can.deleteTable}
          onMouseDown={event => event.preventDefault()} onClick={handleDeleteOpen}><IconTableMinus aria-hidden="true" /><span>删除表格</span></button></div>
      </div>
      <div className={styles.group} data-ribbon-group="table-merge">
        <div className={styles.row} data-ribbon-row="primary">{button("mergeCells", "合并单元格", IconArrowsJoin2)}</div>
        <div className={styles.row} data-ribbon-row="secondary">{button("splitCell", "拆分单元格", IconArrowsSplit2)}</div>
      </div>
      <div className={styles.group} data-ribbon-group="table-header">
        <div className={styles.row} data-ribbon-row="primary">{button("toggleHeaderRow", "表头行", IconTableRow, state.headerRow, "切换首行表头")}{button("toggleHeaderColumn", "表头列", IconTableColumn, state.headerColumn, "切换首列表头")}</div>
        <div className={styles.row} data-ribbon-row="secondary">{button("toggleHeaderCell", "表头单元格", IconTable, state.headerCell, "切换选中单元格为表头")}</div>
      </div>
      <div className={styles.group} data-ribbon-group="table-navigation">
        <div className={styles.row} data-ribbon-row="primary">{button("goToPreviousCell", "上一单元格", IconChevronLeft)}</div>
        <div className={styles.row} data-ribbon-row="secondary">{button("goToNextCell", "下一单元格", IconChevronRight)}</div>
      </div>
    </fieldset>
    <Modal title="删除整张表格？" open={deleteOpen} onCancel={handleDeleteClose} onOk={handleDelete} okText="删除表格" cancelText="取消"
      okButtonProps={{ danger: true, disabled: readOnly || deleteTarget.current?.valid === false }}>
      <p>表格及其中内容将被删除，之后可以通过撤销恢复。</p>
      {deleteError && <p className={styles.error} role="alert">{deleteError}</p>}
    </Modal>
  </>
}
