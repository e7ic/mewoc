/**
 * 为正文选中文字创建批注，同时提供批注侧栏开关与数量/选区限制说明。
 * 批注草稿独立于正文，提交时通过映射书签重新校验原选区，失败保留输入。
 */
import { useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Checkbox, Form, Input, Modal } from "antd"
import { IconMessage } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { useSelectionBookmark } from "../hooks/use-selection-bookmark.js"
import { addDocumentComment, getCommentEntries, getCommentSelectionError, MAX_COMMENT_LENGTH, MAX_COMMENTS } from "../tools/document-comments.js"
import { selectCommentViewState } from "../tools/comment-view.js"
import styles from "../sass/comments.module.scss"

export function ReviewToolbar() {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const commentsOpen = useEditorStore(state => state.commentsOpen)
  // selector 只返回可比较的普通数据，正文扫描由共享缓存复用，不暴露含循环引用的 PM 对象。
  const state = useEditorState({ editor, selector: selectCommentViewState })
  const count = state.entries.length
  const selectionError = getCommentSelectionError(editor)
  // text/quote/error 是弹窗草稿；composingRef 阻止中文输入法确认键同时触发批注提交。
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const [quote, setQuote] = useState("")
  const [error, setError] = useState("")
  const composingRef = useRef(false)
  const { captureSelection, getSelection, clearSelection } = useSelectionBookmark(editor, open)
  const unavailable = readOnly || !!selectionError || count >= MAX_COMMENTS
  const hint = readOnly ? "只读模式下可以查看批注" : count >= MAX_COMMENTS ? `批注已达到 ${MAX_COMMENTS} 条上限` : selectionError || "为选中的文字添加批注，方便继续修改"

  const handleOpen = () => {
    if (readOnly || editor.isDestroyed || editor.view.composing) return
    const currentError = getCommentSelectionError(editor)
    if (currentError || getCommentEntries(editor.state.doc).length >= MAX_COMMENTS) return
    // 弹窗会夺走正文焦点，先捕获可随正文事务映射的书签；展示摘录只用于帮助用户辨认原文。
    captureSelection()
    setQuote(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n", " "))
    setText("")
    setError("")
    setOpen(true)
  }
  // 取消会释放正文书签并结束组合输入标记，避免下次弹窗沿用旧目标。
  const handleCancel = () => {
    clearSelection()
    composingRef.current = false
    setOpen(false)
  }
  // 提交时再次检查只读、销毁和组合输入状态，并验证映射选区、非空内容及命令结果。
  // 失败保留草稿供用户处理；成功展开批注面板后统一关闭弹窗。
  const handleSave = () => {
    if (readOnly || editor.isDestroyed || editor.view.composing || composingRef.current) return
    const selection = getSelection()
    if (!selection) {
      setError("原选区已变化，请关闭后重新选择文字。已输入的批注仍保留在这里。")
      return
    }
    const currentError = getCommentSelectionError(editor, selection)
    if (currentError) {
      setError(currentError)
      return
    }
    if (!text.trim()) {
      setError("请填写批注内容")
      return
    }
    try {
      if (!addDocumentComment(editor, selection, text)) {
        setError("未能保存批注，原选区或可编辑状态可能已变化，请重新选择后再试。")
        return
      }
      store.getState().updateView({ commentsOpen: true, searchOpen: false })
      handleCancel()
    } catch (failure) {
      setError(failure.message || "未能保存批注，请稍后重试")
    }
  }

  // 工具栏展示实时可用性；弹窗显示打开时摘录，让焦点离开正文后仍可辨认批注对象。
  return <>
    <div className={styles.toolbar}>
      <Button aria-label="添加批注" icon={<IconMessage aria-hidden="true" />} disabled={unavailable} title={hint}
        onMouseDown={event => event.preventDefault()} onClick={handleOpen}>添加批注</Button>
      <Checkbox checked={commentsOpen} onChange={event => store.getState().updateView({ commentsOpen: event.target.checked, ...(event.target.checked ? { searchOpen: false } : {}) })}>批注面板</Checkbox>
      <span className={styles.toolbarHint}>{hint}{count > 0 && ` · 共 ${count} 条批注`}</span>
    </div>
    <Modal title="添加批注" open={open} onCancel={handleCancel} footer={null} destroyOnHidden>
      <Form layout="vertical" onFinish={handleSave} className={styles.dialog}>
        <div className={styles.dialogQuote}><strong>选中的文字</strong><blockquote>{quote}</blockquote></div>
        <Form.Item label="批注内容">
          <Input.TextArea aria-label="批注内容" value={text} rows={5} maxLength={MAX_COMMENT_LENGTH} showCount autoFocus disabled={readOnly}
            onCompositionStart={() => { composingRef.current = true }} onCompositionEnd={() => { composingRef.current = false }}
            onChange={event => { setText(event.target.value); setError("") }} />
        </Form.Item>
        {readOnly && <p className={styles.caption}>当前文档只读或正在切换，批注内容会保留，暂时无法保存。</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.dialogActions}><Button type="primary" htmlType="submit" disabled={readOnly || !text.trim()}>保存批注</Button><Button onClick={handleCancel}>取消</Button></div>
      </Form>
    </Modal>
  </>
}
