/**
 * 本地音视频的目标书签、历史边界和异步资源接纳。目标从打开文件选择器之前开始跟踪，
 * 只读、切换、组合输入、删除或销毁一旦发生便永久失效，不会在状态恢复后复活旧任务。
 */
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { checkAssetCapacity } from "./document-schema.js"
import { getMediaFileMetadata, readMediaFile, validateMediaMetadata } from "./media-assets.js"

const editable = (editor, canEdit = () => true) => Boolean(editor && !editor.isDestroyed && editor.isEditable && !editor.view.composing && canEdit())

// 媒体是独立正文块；仅接受同一个普通段落中的文字选区，不在标题/代码块/跨段选区插入。
export function canInsertMedia(editor, selection, canEdit) {
  return Boolean(editable(editor, canEdit) && selection instanceof TextSelection && selection.$from.doc === editor.state.doc &&
    selection.$from.sameParent(selection.$to) && selection.$from.parent.type.name === "paragraph")
}

export function captureMediaInsertionTarget(editor, { canEdit = () => true, subscribeSession = () => () => {} } = {}) {
  if (!canInsertMedia(editor, editor?.state.selection, canEdit)) return null
  let selection = editor.state.selection
  let bookmark = selection.getBookmark()
  let cancelled = false
  let disposed = false
  const inspect = () => { if (!editable(editor, canEdit)) cancelled = true }
  const cancel = () => { cancelled = true }
  const mapTarget = ({ transaction, appendedTransactions = [] }) => {
    inspect()
    for (const current of [transaction, ...appendedTransactions]) {
      if (!current.docChanged || cancelled || disposed) continue
      const from = current.mapping.mapResult(selection.from)
      const to = current.mapping.mapResult(selection.to)
      cancelled ||= from.deleted || to.deleted
      bookmark = bookmark.map(current.mapping)
      try { selection = bookmark.resolve(current.doc) } catch { cancelled = true }
    }
  }
  const dom = editor.view.dom
  const unsubscribe = subscribeSession(inspect)
  editor.on("transaction", mapTarget)
  editor.on("destroy", cancel)
  dom.addEventListener("compositionstart", cancel)
  return {
    isForEditor: candidate => candidate === editor,
    isCancelled() { inspect(); return cancelled || disposed },
    getSelection() {
      inspect()
      if (cancelled || disposed || editor.isDestroyed) return null
      try { return bookmark.resolve(editor.state.doc) } catch { cancelled = true; return null }
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelled = true
      unsubscribe()
      editor.off("transaction", mapTarget)
      editor.off("destroy", cancel)
      dom.removeEventListener("compositionstart", cancel)
    }
  }
}

// 恢复原书签后一次插入；两端关闭历史分组，使相邻文字输入与媒体插入分别一次撤销。
export function insertMediaNode(editor, selection, assetId, canEdit) {
  if (!canInsertMedia(editor, selection, canEdit) || !editor.schema.nodes.media || typeof assetId !== "string" || !assetId) return false
  const inserted = editor.chain().command(({ tr }) => {
    closeHistory(tr)
    tr.setSelection(selection)
    return true
  }).insertContent({ type: "media", attrs: { assetId } }).run()
  if (inserted) editor.view.dispatch(closeHistory(editor.state.tr))
  return inserted
}

// 删除仅移除引用；原始 Blob 与 URL 留在会话中，使撤销可恢复可播放资源。
export function removeMedia(editor, canEdit) {
  if (!editable(editor, canEdit)) return false
  const selection = editor.state.selection
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "media") return false
  editor.view.dispatch(closeHistory(editor.state.tr).delete(selection.from, selection.to))
  editor.view.dispatch(closeHistory(editor.state.tr))
  return true
}

/**
 * 读取完成后根据当前正文重新检查总额度，资源登记与节点事务按顺序完成。
 * readFile 是测试原生读取等待时点的依赖入口；命令、真实书签与容量仍执行产品实现。
 */
export async function insertDocumentMedia({ editor, assets, file, kind, target,
  signal, canEdit = () => true, isActive = () => true, subscribeSession = () => () => {}, readFile = readMediaFile }) {
  const permitted = () => isActive() && !signal?.aborted && editable(editor, canEdit)
  if (!file || !permitted()) { target?.dispose(); return false }
  const tracked = target || captureMediaInsertionTarget(editor, { canEdit, subscribeSession })
  if (!tracked || !tracked.isForEditor(editor) || tracked.isCancelled() || !canInsertMedia(editor, tracked.getSelection(), canEdit)) {
    tracked?.dispose()
    return false
  }
  let invalidated = false
  let committing = false
  let asset = null
  let committed = false
  let registered = false
  const inspect = () => { if (!committing && (!permitted() || tracked.isCancelled())) invalidated = true }
  const cancel = () => { invalidated = true }
  const unsubscribe = subscribeSession(inspect)
  const dom = editor.view.dom
  editor.on("transaction", inspect)
  editor.on("destroy", cancel)
  dom.addEventListener("compositionstart", cancel)
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    getMediaFileMetadata(file, kind)
    checkAssetCapacity(editor.getJSON(), assets, file.size)
    asset = await readFile(file, kind, { signal })
    if (invalidated || !permitted() || tracked.isCancelled()) return false
    const selection = tracked.getSelection()
    if (!canInsertMedia(editor, selection, canEdit)) return false
    validateMediaMetadata(asset)
    if (asset.kind !== kind || !asset.blob || asset.blob.type !== asset.mimeType || asset.blob.size !== asset.byteLength || !asset.url || assets.has(asset.id)) {
      throw new Error("媒体资源与声明不匹配，请重新选择文件")
    }
    checkAssetCapacity(editor.getJSON(), assets, asset.byteLength)
    assets.set(asset.id, asset)
    registered = true
    committing = true
    // 停止目标监听再提交自己的替换事务；该事务可能替换打开文件框前选中的文字。
    tracked.dispose()
    committed = insertMediaNode(editor, selection, asset.id, permitted)
    if (!committed) throw new Error("媒体未能插入，请重新选择插入位置")
    return true
  } finally {
    tracked.dispose()
    unsubscribe()
    editor.off("transaction", inspect)
    editor.off("destroy", cancel)
    dom.removeEventListener("compositionstart", cancel)
    signal?.removeEventListener("abort", cancel)
    if (asset && !committed) {
      // 事务监听器抛错时正文仍可能已接纳新节点；这种情况保留资源，避免悬空引用。
      let referenced = false
      if (!editor.isDestroyed) editor.state.doc.descendants(node => {
        if (["image", "attachment", "media"].includes(node.type.name) && node.attrs.assetId === asset.id) referenced = true
      })
      if (!registered || assets.get(asset.id) !== asset || !referenced) {
        if (registered) assets.delete(asset.id)
        if (asset.url) URL.revokeObjectURL(asset.url)
      }
    }
  }
}
