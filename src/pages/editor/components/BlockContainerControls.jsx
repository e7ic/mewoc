/**
 * 文本框与折叠详情的插入入口、容器设置及退出操作。
 * 插入使用按钮按下时的正文书签；设置弹窗单独持有原容器目标与草稿，改选区不会误改其他容器。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Modal, message } from "antd"
import { IconAdjustmentsHorizontal, IconInfoCircle, IconListDetails, IconLogout2, IconSquareOff, IconTextCaption } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import {
  TEXT_BOX_DEFAULTS, DETAILS_DEFAULTS, supportsBlockContainerInsertSelection,
  captureBlockContainerInsertTarget, mapBlockContainerInsertTarget, insertBlockContainerAtTarget,
  getBlockContainerTarget, captureBlockContainerTarget, mapBlockContainerTarget, readBlockContainerSettings,
  applyBlockContainerSettings, validateBlockContainerAttrs, unwrapBlockContainer, exitBlockContainer
} from "../tools/block-containers.js"
import styles from "../sass/block-containers.module.scss"

const CONTAINERS = [
  { type: "textBox", label: "文本框", Icon: IconTextCaption, defaults: TEXT_BOX_DEFAULTS },
  { type: "details", label: "折叠详情", Icon: IconListDetails, defaults: DETAILS_DEFAULTS }
]
// 预设只修改颜色，保留用户独立设置的边框宽度与内边距。
const BOX_PRESETS = [
  { label: "简洁", backgroundColor: "#ffffff", borderColor: "#d5d7e3" },
  { label: "提示", backgroundColor: TEXT_BOX_DEFAULTS.backgroundColor, borderColor: TEXT_BOX_DEFAULTS.borderColor },
  { label: "提醒", backgroundColor: "#fff8e6", borderColor: "#e6c46c" }
]

export function BlockContainerInsertActions({ active = true, layoutKey = "" }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const supported = useEditorState({ editor, selector: ({ editor: current }) => supportsBlockContainerInsertSelection(current) })
  const targetRef = useRef(null)
  const stopTrackingRef = useRef(null)

  // 两个事件间仍可能有正文事务；释放订阅后才能捕获下一次目标，避免旧书签重定向新入口。
  const clearTarget = useCallback(() => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    targetRef.current = null
  }, [])
  const getBlocked = () => {
    const state = store.getState()
    return !active || !canEditRibbon(editor, state.readOnly || state.switching)
  }
  const captureTarget = type => {
    clearTarget()
    if (getBlocked()) return null
    const target = captureBlockContainerInsertTarget(editor)
    if (!target) return null
    targetRef.current = { type, target }
    const track = ({ transaction, appendedTransactions = [] }) => {
      if (targetRef.current?.target !== target) return
      for (const current of [transaction, ...appendedTransactions]) mapBlockContainerInsertTarget(target, current)
    }
    editor.on("transaction", track)
    stopTrackingRef.current = () => editor.off("transaction", track)
    return target
  }
  const handleInsert = container => {
    // 键盘激活没有 mousedown，由 click 捕获；鼠标激活始终使用此前捕获的原选区。
    const target = targetRef.current?.type === container.type ? targetRef.current.target : captureTarget(container.type)
    if (getBlocked()) { clearTarget(); return }
    const result = insertBlockContainerAtTarget(editor, target, container.type, container.defaults, getBlocked())
    clearTarget()
    if (result.ok) editor.commands.focus()
    else message.info({ content: result.error || "请在普通段落中插入，或选中完整的段落内容。", icon: <IconInfoCircle aria-hidden="true" /> })
  }

  // 模式、分组或权限变化终止尚未提交的按钮目标；恢复编辑后必须重新取得有效的正文书签。
  useEffect(() => { clearTarget() }, [active, readOnly, layoutKey, clearTarget])
  useEffect(() => () => { clearTarget() }, [editor, clearTarget])

  return <>{CONTAINERS.map(container => <button key={container.type} type="button" aria-label={`插入${container.label}`}
    title={supported ? `插入${container.label}；选中完整段落可将原内容放入其中` : "请在普通段落中插入；列表、表格或容器内部暂不支持嵌套"}
    disabled={!active || readOnly || !supported}
    onMouseDown={event => { event.preventDefault(); captureTarget(container.type) }} onClick={() => handleInsert(container)}>
    <container.Icon aria-hidden="true" /><span>{container.label}</span>
  </button>)}</>
}

export function BlockContainerSettings({ active = true }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  // 选择器只返回普通数据；不能把包含 schema 循环引用的 ProseMirror 节点交给 React 比较。
  const selectionType = useEditorState({ editor, selector: ({ editor: current }) => getBlockContainerTarget(current)?.type || null })
  const [draft, setDraft] = useState(null)
  const [type, setType] = useState(null)
  const [dirty, setDirty] = useState({})
  const [valid, setValid] = useState(true)
  const [error, setError] = useState("")
  const targetRef = useRef(null)
  const stopTrackingRef = useRef(null)

  // 弹窗持有原容器：工具栏分组或正文选区改变不清草稿，实时写入权限仍在提交时复核。
  const getBlocked = () => {
    const state = store.getState()
    return !canEditRibbon(editor, state.readOnly || state.switching)
  }
  const clearTarget = useCallback(() => {
    stopTrackingRef.current?.()
    stopTrackingRef.current = null
    targetRef.current = null
  }, [])
  const handleCancel = () => {
    clearTarget()
    setDraft(null)
    setType(null)
    setDirty({})
    setValid(true)
    setError("")
  }
  const handleOpen = () => {
    if (!active || getBlocked()) return
    const target = captureBlockContainerTarget(editor)
    const record = target && readBlockContainerSettings(editor, target)
    if (!record) return
    clearTarget()
    targetRef.current = target
    const track = ({ transaction, appendedTransactions = [] }) => {
      if (targetRef.current !== target) return
      for (const current of [transaction, ...appendedTransactions]) mapBlockContainerTarget(target, current)
      const available = Boolean(readBlockContainerSettings(editor, target))
      setValid(available)
      if (!available) setError("原容器已被删除或替换，请关闭弹窗后重新选择。")
    }
    editor.on("transaction", track)
    stopTrackingRef.current = () => editor.off("transaction", track)
    setType(record.type)
    // 数字框保存原始字符串，空值或未完成输入不会被悄悄当作零值提交。
    setDraft(record.type === "textBox" ? { ...record.attrs, borderWidth: String(record.attrs.borderWidth), padding: String(record.attrs.padding) } : { ...record.attrs })
    setDirty({})
    setValid(true)
    setError("")
  }
  const changeFields = patch => {
    if (getBlocked() || !valid) return
    setDraft(current => ({ ...current, ...patch }))
    setDirty(current => ({ ...current, ...Object.fromEntries(Object.keys(patch).map(field => [field, true])) }))
    setError("")
  }
  const handleRestore = () => {
    if (type === "textBox") changeFields({ ...TEXT_BOX_DEFAULTS, borderWidth: String(TEXT_BOX_DEFAULTS.borderWidth), padding: String(TEXT_BOX_DEFAULTS.padding) })
    else changeFields({ ...DETAILS_DEFAULTS })
  }
  const handleSave = event => {
    event.preventDefault()
    if (getBlocked()) { setError("当前文档不可编辑，设置草稿已保留。恢复编辑后可以应用。"); return }
    const values = type === "textBox" ? { ...draft,
      borderWidth: draft.borderWidth.trim() ? Number(draft.borderWidth) : NaN,
      padding: draft.padding.trim() ? Number(draft.padding) : NaN
    } : draft
    const validationError = validateBlockContainerAttrs(type, values)
    if (validationError) { setError(validationError); return }
    // 未触碰的字段不进入补丁，保留弹窗打开期间其他事务对同一容器属性的修改。
    const patch = Object.fromEntries(Object.keys(dirty).filter(field => dirty[field]).map(field => [field, values[field]]))
    const result = applyBlockContainerSettings(editor, targetRef.current, patch, getBlocked())
    if (!result.ok) { setError(result.error || "原容器已变化，请关闭弹窗后重新选择。"); return }
    handleCancel()
    editor.commands.focus()
  }
  const handleAction = command => {
    if (!active || getBlocked()) return
    const target = captureBlockContainerTarget(editor)
    const result = command(editor, target, getBlocked())
    if (result.ok) { setError(""); editor.commands.focus() }
    else message.info({ content: result.error || "当前容器已变化，请重新选择。", icon: <IconInfoCircle aria-hidden="true" /> })
  }

  // 文档会话更换或编辑器卸载释放映射监听；不会把旧弹窗目标带到新文档。
  useEffect(() => () => { clearTarget() }, [editor, clearTarget])

  const selectedName = selectionType === "textBox" ? "文本框" : "详情"
  const settingsName = type === "textBox" ? "文本框设置" : "折叠详情设置"
  return <>
    {selectionType && <div className={styles.context} role="group" aria-label={`${selectedName}操作`}>
      <Button icon={<IconAdjustmentsHorizontal aria-hidden="true" />} disabled={!active || readOnly}
        onMouseDown={event => event.preventDefault()} onClick={handleOpen}>{selectionType === "textBox" ? "文本框设置" : "折叠详情设置"}</Button>
      <Button icon={<IconLogout2 aria-hidden="true" />} disabled={!active || readOnly} title="将光标移到容器之后，继续正文"
        onMouseDown={event => event.preventDefault()} onClick={() => handleAction(exitBlockContainer)}>退出{selectedName}</Button>
      <Button icon={<IconSquareOff aria-hidden="true" />} disabled={!active || readOnly} title="移除容器边框或折叠结构，保留其中的全部正文内容"
        onMouseDown={event => event.preventDefault()} onClick={() => handleAction(unwrapBlockContainer)}>移除{selectedName}</Button>
    </div>}
    <Modal className={styles.modal} style={{ top: 24 }} title={settingsName} open={Boolean(draft)} onCancel={handleCancel} footer={null} width={480} destroyOnHidden>
      {draft && <form className={styles.form} noValidate onSubmit={handleSave}>
        {type === "textBox" ? <>
          <div className={styles.presets} role="group" aria-label="文本框颜色预设">
            {BOX_PRESETS.map(preset => <button key={preset.label} type="button" disabled={readOnly || !valid}
              onClick={() => changeFields({ backgroundColor: preset.backgroundColor, borderColor: preset.borderColor })}>
              <span className={styles.swatch} style={{ backgroundColor: preset.backgroundColor, borderColor: preset.borderColor }} aria-hidden="true" />{preset.label}
            </button>)}
          </div>
          <div className={styles.grid}>
            <ContainerColor label="背景颜色" name="文本框背景颜色" value={draft.backgroundColor} disabled={readOnly || !valid}
              onChange={value => changeFields({ backgroundColor: value })} />
            <ContainerColor label="边框颜色" name="文本框边框颜色" value={draft.borderColor} disabled={readOnly || !valid}
              onChange={value => changeFields({ borderColor: value })} />
            <ContainerNumber label="边框宽度" name="文本框边框宽度" value={draft.borderWidth} max={6} disabled={readOnly || !valid}
              onChange={value => changeFields({ borderWidth: value })} />
            <ContainerNumber label="内边距" name="文本框内边距" value={draft.padding} max={40} disabled={readOnly || !valid}
              onChange={value => changeFields({ padding: value })} />
          </div>
          <p className={styles.hint}>边框宽度 0–6 px，内边距 0–40 px。设置应用到打开弹窗时的文本框。</p>
        </> : <label className={styles.field}>
          <span>详情标题</span>
          <input type="text" aria-label="详情标题" value={draft.summary} maxLength={120} disabled={readOnly || !valid}
            onChange={event => changeFields({ summary: event.target.value })} autoFocus />
          <small>标题为 1–120 个字符。展开和收起只改变浏览状态。</small>
        </label>}
        <Button disabled={readOnly || !valid} onClick={handleRestore}>恢复默认</Button>
        {readOnly && <p role="status" className={styles.hint}>当前文档为只读或正在切换，设置草稿已保留。</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.footer}>
          <Button onClick={handleCancel}>取消</Button>
          <Button type="primary" htmlType="submit" disabled={readOnly || !valid}>应用设置</Button>
        </div>
      </form>}
    </Modal>
  </>
}

// 颜色输入与数值文本并排显示，图标/文字按中心对齐；原生取色器不引入第二套弹层状态。
const ContainerColor = ({ label, name, value, disabled, onChange }) => <label className={styles.field}>
  <span>{label}</span>
  <span className={styles.color}><input type="color" aria-label={name} value={value} disabled={disabled}
    onChange={event => onChange(event.target.value)} /><span>{value}</span></span>
</label>

// 原生数字框保留非法/越界草稿供提交校验；禁止裁切步进器，避免边框焦点覆盖输入内容。
const ContainerNumber = ({ label, name, value, max, disabled, onChange }) => <label className={styles.field}>
  <span>{label} <small>px</small></span>
  <input type="number" aria-label={name} min={0} max={max} step={1} value={value} disabled={disabled}
    onChange={event => onChange(event.target.value)} />
</label>
