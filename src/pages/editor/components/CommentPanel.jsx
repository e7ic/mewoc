/**
 * 展示批注、筛选处理状态，并通过稳定批注 ID 执行编辑、解决、删除和正文定位。
 * 正文锚点与批注草稿分离，原文删除后仍保留批注记录，定位失败不会丢失批注内容。
 */
import { useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Form, Input, Modal, Tag } from "antd"
import { IconCheck, IconX, IconMessage, IconTrash, IconPencil, IconMapPin, IconArrowBackUp } from "@tabler/icons-react"
import clsx from "clsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { focusDocumentComment, MAX_COMMENT_LENGTH, removeDocumentComment, setCommentResolved, updateDocumentComment } from "../tools/document-comments.js"
import { selectCommentViewState } from "../tools/comment-view.js"
import styles from "../sass/comments.module.scss"

// 固定筛选项同时提供按钮文字和可访问标签，筛选只改变列表呈现，不更新批注状态。
const FILTERS = [{ value: "all", label: "全部", ariaLabel: "全部批注" }, { value: "unresolved", label: "待处理", ariaLabel: "待处理批注" }, { value: "resolved", label: "已解决", ariaLabel: "已解决批注" }]

export function CommentPanel() {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const switching = useEditorStore(state => state.switching)
  // 与工具栏共享纯数据投影和 doc 缓存；选区只投影数字坐标，不参与 PM 对象的递归比较。
  const state = useEditorState({ editor, selector: selectCommentViewState })
  const entries = state.entries
  // draft 是独立编辑副本；error 服务弹窗，panelError 服务列表操作，避免错误提示互相覆盖。
  // composingRef 防止输入法确认时提交尚未结束的批注文本。
  const [filter, setFilter] = useState("all")
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState("")
  const [panelError, setPanelError] = useState("")
  const composingRef = useRef(false)
  const visibleEntries = entries.filter(entry => filter === "all" || entry.resolved === (filter === "resolved"))
  const unresolvedCount = entries.filter(entry => !entry.resolved).length
  // 按正文选区与各锚点的交集高亮卡片；空光标使用左闭右开范围，避免边界同时匹配相邻批注。
  const activeIds = new Set(entries.filter(entry => entry.ranges.some(range => state.selection.empty
    ? state.selection.from >= range.from && state.selection.from < range.to
    : state.selection.from < range.to && state.selection.to > range.from)).map(entry => entry.id))

  // 打开时复制批注 ID、正文摘录和内容；之后编辑草稿不直接改变文档中的批注。
  const handleEdit = entry => {
    if (readOnly || editor.isDestroyed || editor.view.composing) return
    setDraft({ id: entry.id, text: entry.text, quote: entry.anchorText || entry.quote, orphaned: entry.orphaned })
    setError("")
    composingRef.current = false
  }
  // 取消和保存成功共用清理路径，清空草稿、错误与组合输入标记。
  const handleCancel = () => {
    setDraft(null)
    setError("")
    composingRef.current = false
  }
  // 每次提交都检查当前编辑状态与非空文本；失败保留输入，成功才销毁临时草稿。
  const handleSave = () => {
    if (!draft || readOnly || editor.isDestroyed || editor.view.composing || composingRef.current) return
    if (!draft.text.trim()) {
      setError("请填写批注内容")
      return
    }
    try {
      // 通过稳定批注 ID 在当前正文中重新定位，避免弹窗打开期间文档变化后写错另一条批注。
      if (!updateDocumentComment(editor, draft.id, draft.text)) {
        setError("这条批注已变化或当前不可编辑，输入内容仍保留，请关闭后重试。")
        return
      }
      handleCancel()
    } catch (failure) {
      setError(failure.message || "未能保存批注，请稍后重试")
    }
  }
  // 列表中的删除/解决动作走正文命令，进入撤销历史；执行失败在列表中反馈，避免误报成功。
  const handleChange = (action, entry) => {
    if (readOnly || editor.isDestroyed || editor.view.composing) return
    setPanelError("")
    try {
      const changed = action === "remove" ? removeDocumentComment(editor, entry.id) : setCommentResolved(editor, entry.id, !entry.resolved)
      if (!changed) setPanelError("这条批注已变化或当前不可编辑，请重试")
    } catch (failure) {
      setPanelError(failure.message || "未能更新批注，请稍后重试")
    }
  }
  // 定位允许在只读模式进行，因为它只移动选区；切换、销毁或输入法组合时暂停定位。
  const handleLocate = entry => {
    if (switching || editor.isDestroyed || editor.view.composing) return
    setPanelError("")
    if (!focusDocumentComment(editor, entry.id)) setPanelError("原文已删除，无法定位这条批注")
  }

  // 列表与编辑弹窗共享文档状态；失去锚点的批注明确展示原文已删除，并禁用无效定位按钮。
  return <>
    <aside className={styles.panel} aria-label="批注面板">
      <div className={styles.header}><strong><IconMessage aria-hidden="true" /> 批注 <span>{entries.length}</span></strong>
        <button type="button" aria-label="关闭批注面板" onClick={() => store.getState().updateView({ commentsOpen: false })}><IconX aria-hidden="true" /></button></div>
      <div className={styles.filters} aria-label="批注筛选">{FILTERS.map(item => <button key={item.value} type="button" aria-label={item.ariaLabel}
        aria-pressed={filter === item.value} className={clsx(filter === item.value && styles.activeFilter)} onClick={() => setFilter(item.value)}>{item.label}{item.value === "unresolved" ? ` ${unresolvedCount}` : item.value === "resolved" ? ` ${entries.length - unresolvedCount}` : ""}</button>)}</div>
      {panelError && <p className={styles.error} role="alert">{panelError}</p>}
      <div className={styles.list}>{visibleEntries.map(entry => <article key={entry.id} data-comment-id={entry.id}
        className={clsx(styles.card, activeIds.has(entry.id) && styles.activeCard, entry.resolved && styles.resolvedCard)} aria-label="文档批注">
        <div className={styles.cardHeading}><time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>{entry.resolved && <Tag color="success">已解决</Tag>}</div>
        <button type="button" className={styles.quote} aria-label="定位批注" disabled={entry.orphaned || switching}
          onMouseDown={event => event.preventDefault()} onClick={() => handleLocate(entry)} title={entry.orphaned ? "原文已删除，无法定位" : "定位到正文中的文字"}>
          <span>{entry.anchorText || entry.quote}</span><IconMapPin aria-hidden="true" /></button>
        {entry.orphaned && <p className={styles.orphaned}>原文已删除 · 无法定位</p>}
        <p className={styles.commentText}>{entry.text}</p>
        <div className={styles.cardActions}>
          <Button size="small" aria-label="编辑批注" icon={<IconPencil aria-hidden="true" />} disabled={readOnly} onClick={() => handleEdit(entry)}>编辑</Button>
          <Button size="small" aria-label={entry.resolved ? "重新打开批注" : "解决批注"} icon={entry.resolved ? <IconArrowBackUp aria-hidden="true" /> : <IconCheck aria-hidden="true" />}
            disabled={readOnly} onClick={() => handleChange("resolve", entry)}>{entry.resolved ? "重新打开" : "解决"}</Button>
          <Button size="small" aria-label="删除批注" title="删除批注后可以撤销" icon={<IconTrash aria-hidden="true" />} disabled={readOnly} onClick={() => handleChange("remove", entry)} />
        </div>
      </article>)}</div>
      {!visibleEntries.length && <div className={styles.empty}><IconMessage aria-hidden="true" /><p>{entries.length ? filter === "resolved" ? "还没有已解决的批注" : "所有批注都已处理" : "选中正文文字，在「工具」中添加批注"}</p></div>}
      <p className={styles.caption}>{readOnly ? "只读模式下可查看与定位批注" : "批注修改、解决和删除均可撤销"}</p>
    </aside>
    <Modal title="编辑批注" open={!!draft} onCancel={handleCancel} footer={null} destroyOnHidden>
      {draft && <Form layout="vertical" onFinish={handleSave} className={styles.dialog}>
        <div className={styles.dialogQuote}><strong>{draft.orphaned ? "原文已删除" : "关联的文字"}</strong><blockquote>{draft.quote}</blockquote></div>
        <Form.Item label="批注内容"><Input.TextArea aria-label="批注内容" value={draft.text} rows={5} maxLength={MAX_COMMENT_LENGTH} showCount autoFocus disabled={readOnly}
          onCompositionStart={() => { composingRef.current = true }} onCompositionEnd={() => { composingRef.current = false }}
          onChange={event => { setDraft({ ...draft, text: event.target.value }); setError("") }} /></Form.Item>
        {readOnly && <p className={styles.caption}>当前文档只读或正在切换，批注内容会保留，暂时无法保存。</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.dialogActions}><Button type="primary" htmlType="submit" disabled={readOnly || !draft.text.trim()}>保存批注</Button><Button onClick={handleCancel}>取消</Button></div>
      </Form>}
    </Modal>
  </>
}

// 格式化保存时间仅用于展示；无效日期显示为空，避免错误日期干扰批注列表。
function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
}
