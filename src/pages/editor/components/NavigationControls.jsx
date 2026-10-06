/**
 * 目录与命名书签的工具入口；所有表单绑定打开时捕获并持续映射的原节点。
 * 管理列表使用当前正文派生的普通数据，只读时仍允许查看和定位，写入始终检查实时权限。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { Button, Modal } from "antd"
import { IconBookmark, IconListTree, IconAdjustmentsHorizontal, IconRefresh, IconTrash, IconMapPin } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import {
  listNavigationTargets, supportsNavigationInsertSelection, captureNavigationInsertTarget, mapNavigationInsertTarget,
  insertTableOfContentsAtTarget, captureNavigationBlockTarget, mapNavigationBlockTarget, readNavigationBlockTarget,
  setBookmarkName, removeBookmarkName, navigateToTarget, getTableOfContentsTarget, captureTableOfContentsTarget,
  mapTableOfContentsTarget, readTableOfContentsSettings, applyTableOfContentsSettings, refreshTableOfContents, removeTableOfContents
} from "../tools/navigation-commands.js"
import styles from "../sass/navigation.module.scss"

// 目标在捕获后立即加入监听集合，完整映射主事务和附加事务，避免弹窗打开的 effect 空隙。
function useNavigationTargetTracking(editor) {
  const targetsRef = useRef(new Map())
  const [version, setVersion] = useState(0)
  const track = useCallback((target, map, inspect) => {
    if (target) targetsRef.current.set(target, { map, inspect })
    return target
  }, [])
  const release = useCallback(target => { targetsRef.current.delete(target) }, [])
  useEffect(() => {
    const targets = targetsRef.current
    const handleTransaction = ({ transaction, appendedTransactions = [] }) => {
      for (const [target, record] of targets) {
        for (const current of [transaction, ...appendedTransactions]) record.map(target, current)
        record.inspect?.(target)
      }
      if (targets.size) setVersion(current => current + 1)
    }
    editor.on("transaction", handleTransaction)
    return () => { editor.off("transaction", handleTransaction); targets.clear() }
  }, [editor])
  return { track, release, version }
}

export function NavigationInsertActions({ active = true }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const switching = useEditorStore(state => state.switching)
  const supported = useEditorState({ editor, selector: ({ editor: current }) => supportsNavigationInsertSelection(current) })
  const targets = useEditorState({ editor, selector: ({ editor: current }) => listNavigationTargets(current) })
  const [tocDraft, setTocDraft] = useState(null)
  const [tocError, setTocError] = useState("")
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [name, setName] = useState("")
  const [editing, setEditing] = useState(null)
  const [bookmarkError, setBookmarkError] = useState("")
  const insertRef = useRef(null)
  const addRef = useRef(null)
  const renameRef = useRef(null)
  const { track, release } = useNavigationTargetTracking(editor)
  const getBlocked = () => {
    const state = store.getState()
    return !canEditRibbon(editor, state.readOnly || state.switching)
  }
  const closeToc = () => { release(insertRef.current); insertRef.current = null; setTocDraft(null); setTocError("") }
  const openToc = () => {
    if (!active || getBlocked()) return
    closeToc()
    const target = captureNavigationInsertTarget(editor)
    if (!target) return
    insertRef.current = track(target, mapNavigationInsertTarget)
    setTocDraft({ title: "目录", maxLevel: 3 })
  }
  const insertToc = event => {
    event.preventDefault()
    if (getBlocked()) { setTocError("当前文档不可编辑，目录草稿已保留。"); return }
    const result = insertTableOfContentsAtTarget(editor, insertRef.current, tocDraft, getBlocked())
    if (!result.ok) { setTocError(result.error || "原插入位置已变化，请关闭后重新选择。"); return }
    closeToc()
    editor.commands.focus()
  }
  const closeRename = () => { release(renameRef.current); renameRef.current = null; setEditing(null) }
  const closeBookmarks = () => {
    release(addRef.current)
    addRef.current = null
    closeRename()
    setBookmarksOpen(false)
    setName("")
    setBookmarkError("")
  }
  const captureAdd = () => {
    release(addRef.current)
    addRef.current = null
    if (!getBlocked()) addRef.current = track(captureNavigationBlockTarget(editor), mapNavigationBlockTarget)
    setName("")
    setBookmarkError("")
  }
  const openBookmarks = () => {
    if (!active || editor.isDestroyed || store.getState().switching || editor.view.composing) return
    closeBookmarks()
    captureAdd()
    setBookmarksOpen(true)
  }
  const addBookmark = event => {
    event.preventDefault()
    if (getBlocked()) { setBookmarkError("当前文档不可编辑，书签草稿已保留。"); return }
    const result = setBookmarkName(editor, addRef.current, name, getBlocked())
    if (!result.ok) { setBookmarkError(result.error || "原段落已被删除或替换，请重新选择。"); return }
    setName("")
    setBookmarkError("")
  }
  const startRename = item => {
    if (getBlocked()) return
    closeRename()
    const target = captureNavigationBlockTarget(editor, item.pos)
    if (!target || !readNavigationBlockTarget(editor, target)?.attrs.bookmarkName) return
    // 删除书签后即使撤销恢复名称，也不能复活这一轮已失效的重命名草稿。
    renameRef.current = track(target, mapNavigationBlockTarget, current => {
      if (!readNavigationBlockTarget(editor, current)?.attrs.bookmarkName) current.bookmarkRemoved = true
    })
    setEditing({ id: item.id, name: item.name })
    setBookmarkError("")
  }
  const saveRename = event => {
    event.preventDefault()
    if (getBlocked()) { setBookmarkError("当前文档不可编辑，重命名草稿已保留。"); return }
    if (renameRef.current?.bookmarkRemoved) { setBookmarkError("原书签已被删除，请取消后重新选择。"); return }
    const result = setBookmarkName(editor, renameRef.current, editing.name, getBlocked())
    if (!result.ok) { setBookmarkError(result.error || "原书签已变化，请取消后重新选择。"); return }
    closeRename()
    setBookmarkError("")
  }
  const removeBookmark = item => {
    if (getBlocked()) return
    const target = captureNavigationBlockTarget(editor, item.pos)
    const result = removeBookmarkName(editor, target, getBlocked())
    if (!result.ok) setBookmarkError(result.error || "原书签已变化，请重新选择。")
    else setBookmarkError("")
  }
  const locateBookmark = item => {
    const result = navigateToTarget(editor, item.id, store.getState().switching)
    if (!result.ok) setBookmarkError(result.error || "该书签位置已不存在。")
  }
  const addRecord = addRef.current && readNavigationBlockTarget(editor, addRef.current)
  const bookmarks = targets.filter(item => item.type === "bookmark")

  return <>
    <button type="button" aria-label="插入目录" title="插入随标题自动更新的目录" disabled={!active || readOnly || !supported}
      onMouseDown={event => event.preventDefault()} onClick={openToc}><IconListTree aria-hidden="true" /><span>目录</span></button>
    <button type="button" aria-label="管理书签" title="为段落或标题命名，供文档内链接定位" disabled={!active || switching}
      onMouseDown={event => event.preventDefault()} onClick={openBookmarks}><IconBookmark aria-hidden="true" /><span>书签</span></button>
    <TocDialog draft={tocDraft} setDraft={setTocDraft} readOnly={readOnly} error={tocError} onCancel={closeToc} onSubmit={insertToc} />
    <Modal title="书签" className={styles.modal} style={{ top: 24 }} width={580} open={bookmarksOpen} onCancel={closeBookmarks} footer={null} destroyOnHidden>
      <div className={styles.bookmarks}>
        <form className={styles.form} noValidate onSubmit={addBookmark}>
          <label className={styles.field}><span>书签名称</span><input aria-label="书签名称" type="text" maxLength={80} value={name}
            disabled={readOnly || !addRecord} onChange={event => { if (!getBlocked()) { setName(event.target.value); setBookmarkError("") } }} /></label>
          <p className={styles.hint}>{addRecord ? `绑定打开面板时的${addRecord.type === "heading" ? "标题" : "段落"}：${addRecord.text || "空段落"}` : "请将光标放入一个段落或标题，再点击「使用当前段落」。"}</p>
          <div className={styles.actions}>
            <Button disabled={readOnly} onClick={captureAdd}>使用当前段落</Button>
            <Button type="primary" htmlType="submit" disabled={readOnly || !addRecord}>添加书签</Button>
          </div>
          <p className={styles.hint}>名称为 1–80 个字符。书签绑定整段或标题；删除书签保留原文字。</p>
        </form>
        <div className={styles.list} role="list" aria-label="文档书签">
          {bookmarks.map(item => <div key={item.id} className={styles.item} role="listitem">
            <span className={styles.itemText}><strong>{item.name}</strong><small>{item.text || "空段落"}</small></span>
            <div className={styles.itemActions}>
              <Button icon={<IconMapPin aria-hidden="true" />} aria-label={`定位书签：${item.name}`} onClick={() => locateBookmark(item)}>定位</Button>
              <Button aria-label={`重命名书签：${item.name}`} disabled={readOnly} onClick={() => startRename(item)}>重命名</Button>
              <Button aria-label={`删除书签：${item.name}`} disabled={readOnly} onClick={() => removeBookmark(item)}>删除</Button>
            </div>
          </div>)}
          {!bookmarks.length && <p className={styles.hint}>文档中还没有命名书签。</p>}
        </div>
        {editing && <form className={styles.form} noValidate onSubmit={saveRename}>
          <label className={styles.field}><span>重命名书签</span><input aria-label="重命名书签" type="text" maxLength={80} value={editing.name}
            disabled={readOnly || renameRef.current?.bookmarkRemoved} onChange={event => { if (!getBlocked()) setEditing({ ...editing, name: event.target.value }) }} autoFocus /></label>
          <div className={styles.actions}><Button onClick={closeRename}>取消重命名</Button><Button type="primary" htmlType="submit"
            disabled={readOnly || renameRef.current?.bookmarkRemoved}>保存书签名称</Button></div>
        </form>}
        {readOnly && <p className={styles.hint} role="status">当前文档不可编辑，可以查看和定位书签。</p>}
        {bookmarkError && <p className={styles.error} role="alert">{bookmarkError}</p>}
        <div className={styles.footer}><Button onClick={closeBookmarks}>关闭</Button></div>
      </div>
    </Modal>
  </>
}

export function TableOfContentsControls({ active = true }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const selected = useEditorState({ editor, selector: ({ editor: current }) => Boolean(getTableOfContentsTarget(current)) })
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState({})
  const [error, setError] = useState("")
  const targetRef = useRef(null)
  const { track, release } = useNavigationTargetTracking(editor)
  const getBlocked = () => {
    const state = store.getState()
    return !canEditRibbon(editor, state.readOnly || state.switching)
  }
  const close = () => { release(targetRef.current); targetRef.current = null; setDraft(null); setDirty({}); setError("") }
  const open = () => {
    if (!active || getBlocked()) return
    close()
    const target = captureTableOfContentsTarget(editor)
    const record = target && readTableOfContentsSettings(editor, target)
    if (!record) return
    targetRef.current = track(target, mapTableOfContentsTarget)
    setDraft({ title: record.attrs.title, maxLevel: record.attrs.maxLevel })
  }
  const save = event => {
    event.preventDefault()
    if (getBlocked()) { setError("当前文档不可编辑，目录设置草稿已保留。"); return }
    const patch = Object.fromEntries(Object.keys(dirty).map(key => [key, draft[key]]))
    const result = applyTableOfContentsSettings(editor, targetRef.current, patch, getBlocked())
    if (!result.ok) { setError(result.error || "原目录已被删除或替换，请关闭后重新选择。"); return }
    close()
    editor.commands.focus()
  }
  const act = command => {
    if (!active || getBlocked()) return
    const target = captureTableOfContentsTarget(editor)
    const result = command(editor, target, getBlocked())
    if (!result.ok) setError(result.error || "原目录已变化，请重新选择。")
    else { setError(""); editor.commands.focus() }
  }
  return <>
    {selected && <div className={styles.context} role="group" aria-label="目录操作">
      <Button icon={<IconAdjustmentsHorizontal aria-hidden="true" />} disabled={!active || readOnly} onMouseDown={event => event.preventDefault()} onClick={open}>目录设置</Button>
      <Button icon={<IconRefresh aria-hidden="true" />} disabled={!active || readOnly} onMouseDown={event => event.preventDefault()} onClick={() => act(refreshTableOfContents)}>更新目录</Button>
      <Button icon={<IconTrash aria-hidden="true" />} disabled={!active || readOnly} onMouseDown={event => event.preventDefault()} onClick={() => act(removeTableOfContents)}>删除目录</Button>
      {error && !draft && <p className={styles.error} role="alert">{error}</p>}
    </div>}
    <TocDialog editing draft={draft} setDraft={setDraft} onChangeField={field => setDirty(current => ({ ...current, [field]: true }))}
      readOnly={readOnly} error={error} onCancel={close} onSubmit={save} />
  </>
}

// 插入和设置复用同一表单；输入只是草稿，标题变化前由核心命令生成当前目录条目。
function TocDialog({ draft, setDraft, onChangeField = () => {}, editing = false, readOnly, error, onCancel, onSubmit }) {
  return <Modal title={editing ? "目录设置" : "插入目录"} className={styles.modal} style={{ top: 24 }} width={440} open={Boolean(draft)}
    onCancel={onCancel} footer={null} destroyOnHidden>
    {draft && <form className={styles.form} noValidate onSubmit={onSubmit}>
      <label className={styles.field}><span>目录标题</span><input aria-label="目录标题" type="text" maxLength={80} value={draft.title} disabled={readOnly}
        onChange={event => { setDraft({ ...draft, title: event.target.value }); onChangeField("title") }} autoFocus /></label>
      <label className={styles.field}><span>最大标题级别</span><select aria-label="最大标题级别" value={draft.maxLevel} disabled={readOnly}
        onChange={event => { setDraft({ ...draft, maxLevel: Number(event.target.value) }); onChangeField("maxLevel") }}>
        {[1, 2, 3, 4, 5, 6].map(level => <option value={level} key={level}>标题 1–{level}</option>)}
      </select></label>
      <p className={styles.hint}>目录标题为 1–80 个字符。条目随正文标题自动更新；编辑时按 ⌘ / Ctrl 并点击可跳转，只读时直接点击。</p>
      {readOnly && <p className={styles.hint} role="status">当前文档不可编辑，目录草稿已保留。</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.footer}><Button onClick={onCancel}>取消</Button><Button type="primary" htmlType="submit" disabled={readOnly}>{editing ? "应用目录设置" : "确认插入目录"}</Button></div>
    </form>}
  </Modal>
}
