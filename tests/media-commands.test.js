/**
 * 使用真实 Tiptap/ProseMirror 事务检查文件选择前书签、完整追加事务映射、永久取消与一步撤销。
 * 注入读取 Promise 只控制原生媒体解码的等待时点；节点、资源、容量与历史不模拟。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { Plugin, TextSelection } from "@tiptap/pm/state"
import { DocumentMedia } from "../src/pages/editor/extensions/document-media.js"
import { canInsertMedia, captureMediaInsertionTarget, insertDocumentMedia, insertMediaNode, removeMedia } from "../src/pages/editor/tools/media-commands.js"
import { getReferencedAssetIds } from "../src/pages/editor/tools/document-schema.js"
import { MAX_ASSET_BYTES } from "../src/pages/editor/constants/editor-constants.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
// JSDOM 无音视频解码器；这里只让生产 NodeView 可创建/销毁，原生播放另由浏览器验收。
DOM.window.HTMLMediaElement.prototype.load = () => {}
DOM.window.HTMLMediaElement.prototype.pause = () => {}
const file = new File([new Uint8Array(244)], "声音.wav", { type: "audio/wav" })
const paragraph = text => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] })
const media = assetId => ({ type: "media", attrs: { assetId } })
const asset = (id = "media-new", byteLength = file.size) => ({ id, kind: "audio", fileName: file.name,
  mimeType: file.type, byteLength, blob: new Blob([new Uint8Array(byteLength)], { type: file.type }), url: `blob:${id}` })
const session = (content = [paragraph("正文"), paragraph("下一段")], assets = new Map()) => ({ assets, editor: new Editor({
  element: document.createElement("div"),
  extensions: [StarterKit.configure({ trailingNode: false }), DocumentMedia.configure({ getAsset: id => assets.get(id), getAssetUrl: id => assets.get(id)?.url || "" })],
  content: { type: "doc", content }
}) })
const capture = (editor, options) => {
  editor.commands.setTextSelection(2)
  return captureMediaInsertionTarget(editor, options)
}
const deferredReader = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { readFile: () => promise, resolve: value => resolve(value || asset()) }
}
const trackRevoke = () => {
  const revoke = URL.revokeObjectURL
  const released = []
  URL.revokeObjectURL = url => { released.push(url) }
  return { released, restore: () => { URL.revokeObjectURL = revoke } }
}
const observablePermission = () => {
  let allowed = true
  const listeners = new Set()
  return { canEdit: () => allowed, listeners,
    subscribeSession: callback => { listeners.add(callback); return () => listeners.delete(callback) },
    update: value => { allowed = value; for (const callback of listeners) callback() }
  }
}

test("媒体插入恢复文件框前选区，保留原字节和旧资源，与前后文字分别一次撤销", async () => {
  const old = asset("old-resource")
  const { editor, assets } = session([paragraph("正文"), paragraph("下一段")], new Map([[old.id, old]]))
  const target = capture(editor)
  const tracker = trackRevoke()
  try {
    const result = asset()
    editor.commands.insertContentAt(1, "之前输入")
    const before = editor.getJSON()
    assert.equal(await insertDocumentMedia({ editor, assets, target, file, kind: "audio", readFile: async () => result }), true)
    assert.deepEqual(getReferencedAssetIds(editor.getJSON()), [result.id])
    assert.equal(assets.get(old.id).blob, old.blob)
    assert.equal(assets.get(result.id).blob, result.blob)
    assert.equal(editor.view.dom.querySelector("[data-media-player]").getAttribute("src"), result.url)
    editor.commands.insertContent("后续输入")
    assert.equal(editor.commands.undo(), true)
    assert.equal(editor.getText().includes("后续输入"), false)
    assert.deepEqual(getReferencedAssetIds(editor.getJSON()), [result.id])
    assert.equal(editor.commands.undo(), true)
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(editor.commands.redo(), true)
    assert.deepEqual(getReferencedAssetIds(editor.getJSON()), [result.id])
    assert.deepEqual(tracker.released, [])
    assert.equal(target.isCancelled(), true)
  } finally { tracker.restore(); target.dispose(); editor.destroy() }
})

test("文件读取期间改选区/前方输入仍映射到原段落，选择文本仅在提交时替换", async () => {
  const { editor, assets } = session()
  editor.commands.setTextSelection({ from: 1, to: 3 })
  const target = captureMediaInsertionTarget(editor)
  const pending = deferredReader()
  try {
    const operation = insertDocumentMedia({ editor, assets, target, file, kind: "audio", readFile: pending.readFile })
    editor.commands.insertContentAt(0, paragraph("前置段落"))
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    assert.equal(editor.getText().includes("正文"), true)
    assert.equal(assets.size, 0)
    pending.resolve()
    assert.equal(await operation, true)
    assert.equal(editor.state.doc.firstChild.textContent, "前置段落")
    assert.equal(editor.getText().includes("正文"), false)
    assert.equal(editor.state.doc.lastChild.textContent, "下一段")
    assert.deepEqual(getReferencedAssetIds(editor.getJSON()), ["media-new"])
  } finally { target.dispose(); editor.destroy() }
})

test("追加事务完整映射原目标，追加删除再重插相同段落不能复活目标", async () => {
  for (const deletes of [false, true]) {
    const { editor, assets } = session()
    editor.registerPlugin(new Plugin({ appendTransaction(transactions, _old, state) {
      if (!transactions.some(transaction => transaction.getMeta("media-appended"))) return null
      return deletes ? state.tr.replaceWith(0, state.doc.firstChild.nodeSize, state.schema.nodes.paragraph.create(null, state.schema.text("正文")))
        : state.tr.insert(0, state.schema.nodes.paragraph.create(null, state.schema.text("追加段落")))
    } }))
    const target = capture(editor)
    const pending = deferredReader()
    const tracker = trackRevoke()
    try {
      const operation = insertDocumentMedia({ editor, assets, target, file, kind: "audio", readFile: pending.readFile })
      editor.view.dispatch(editor.state.tr.setMeta("media-appended", true))
      pending.resolve()
      assert.equal(await operation, !deletes)
      assert.equal(assets.size, deletes ? 0 : 1)
      assert.deepEqual(tracker.released, deletes ? ["blob:media-new"] : [])
      if (!deletes) assert.equal(editor.state.doc.firstChild.textContent, "追加段落")
    } finally { tracker.restore(); target.dispose(); editor.destroy() }
  }
})

test("捕获后文件框期间只读/切换再恢复已永久取消，不开始解码", async () => {
  const { editor, assets } = session()
  const permission = observablePermission()
  const target = capture(editor, permission)
  let reads = 0
  try {
    permission.update(false)
    permission.update(true)
    assert.equal(await insertDocumentMedia({ editor, assets, target, file, kind: "audio", ...permission, readFile: async () => { reads += 1; return asset() } }), false)
    assert.equal(reads, 0)
    assert.equal(permission.listeners.size, 0)
    assert.equal(assets.size, 0)
  } finally { target.dispose(); editor.destroy() }
})

test("等待解码时只读恢复、IME、目标删除恢复、销毁、会话关闭与 abort 都取消并回收", async () => {
  for (const reason of ["readonly", "composition", "delete-restore", "destroy", "session-end", "abort"]) {
    const { editor, assets } = session()
    const permission = observablePermission()
    const target = capture(editor, permission)
    const pending = deferredReader()
    const tracker = trackRevoke()
    const controller = new AbortController()
    let active = true
    try {
      const operation = insertDocumentMedia({ editor, assets, target, file, kind: "audio", readFile: pending.readFile,
        ...permission, signal: controller.signal, isActive: () => active })
      if (reason === "readonly") { permission.update(false); permission.update(true) }
      if (reason === "composition") editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionstart", { bubbles: true }))
      if (reason === "delete-restore") {
        const old = editor.state.doc.firstChild
        editor.view.dispatch(editor.state.tr.delete(0, old.nodeSize))
        editor.view.dispatch(editor.state.tr.insert(0, old))
      }
      if (reason === "destroy") editor.destroy()
      if (reason === "session-end") active = false
      if (reason === "abort") controller.abort()
      pending.resolve()
      assert.equal(await operation, false, reason)
      assert.equal(assets.size, 0, reason)
      assert.deepEqual(tracker.released, ["blob:media-new"], reason)
      assert.equal(permission.listeners.size, 0)
      if (!editor.isDestroyed) assert.deepEqual(getReferencedAssetIds(editor.getJSON()), [])
    } finally { tracker.restore(); target.dispose(); if (!editor.isDestroyed) editor.destroy() }
  }
})

test("引用媒体与图片/附件共用 20 MiB，等待期间新增资源超限不登记迟到资源", async () => {
  const filler = asset("full", MAX_ASSET_BYTES)
  const { editor, assets } = session([paragraph("正文"), media(filler.id)], new Map([[filler.id, filler]]))
  let target = capture(editor)
  let reads = 0
  const pending = deferredReader()
  const tracker = trackRevoke()
  try {
    await assert.rejects(insertDocumentMedia({ editor, assets, target, file, kind: "audio", readFile: async () => { reads += 1; return asset() } }), /20 MiB/)
    assert.equal(reads, 0)
    editor.commands.setContent({ type: "doc", content: [paragraph("正文")] })
    target = capture(editor)
    const operation = insertDocumentMedia({ editor, assets, target, file, kind: "audio", readFile: pending.readFile })
    editor.commands.insertContentAt(editor.state.doc.content.size, media(filler.id))
    pending.resolve()
    await assert.rejects(operation, /20 MiB/)
    assert.equal(assets.has("media-new"), false)
    assert.deepEqual(tracker.released, ["blob:media-new"])
    assert.equal(assets.has("full"), true)
  } finally { tracker.restore(); target.dispose(); editor.destroy() }
})

test("容量按正文唯一媒体引用计费，删除保留 Blob/URL 且可一步撤销重做", async () => {
  const original = asset("existing", 5 * 1024 * 1024)
  const { editor, assets } = session([paragraph("正文"), media(original.id), media(original.id)], new Map([[original.id, original]]))
  const tracker = trackRevoke()
  try {
    const target = capture(editor)
    assert.equal(await insertDocumentMedia({ editor, assets, target, file, kind: "audio", readFile: async () => asset() }), true)
    let position
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "media" && node.attrs.assetId === "media-new") position = pos })
    editor.commands.setNodeSelection(position)
    assert.equal(removeMedia(editor), true)
    assert.equal(assets.has("media-new"), true)
    assert.deepEqual(getReferencedAssetIds(editor.getJSON()), ["existing"])
    assert.equal(editor.commands.undo(), true)
    assert.equal(getReferencedAssetIds(editor.getJSON()).includes("media-new"), true)
    assert.equal(editor.commands.redo(), true)
    assert.deepEqual(getReferencedAssetIds(editor.getJSON()), ["existing"])
    assert.deepEqual(tracker.released, [])
  } finally { tracker.restore(); editor.destroy() }
})

test("无效目标、标题/代码/跨段选区和只读/组合输入拒绝插入，来源错误不污染资源", async () => {
  const { editor, assets } = session()
  const other = session()
  const tracker = trackRevoke()
  try {
    const foreign = capture(other.editor)
    assert.equal(await insertDocumentMedia({ editor, assets, target: foreign, file, kind: "audio", readFile: async () => asset() }), false)
    for (const content of [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "标题" }] },
      { type: "codeBlock", content: [{ type: "text", text: "code" }] }]) {
      editor.commands.setContent({ type: "doc", content: [content] })
      editor.commands.setTextSelection(1)
      assert.equal(canInsertMedia(editor, editor.state.selection), false)
      assert.equal(captureMediaInsertionTarget(editor), null)
      assert.equal(insertMediaNode(editor, editor.state.selection, "id"), false)
    }
    editor.commands.setContent({ type: "doc", content: [paragraph("a"), paragraph("b")] })
    assert.equal(canInsertMedia(editor, TextSelection.create(editor.state.doc, 1, 4)), false)
    editor.commands.setTextSelection(1)
    editor.setEditable(false, false)
    assert.equal(captureMediaInsertionTarget(editor), null)
    editor.setEditable(true, false)
    let target = captureMediaInsertionTarget(editor)
    await assert.rejects(insertDocumentMedia({ editor, assets, target, file, kind: "audio", readFile: async () => { throw new Error("媒体无法播放") } }), /无法播放/)
    target = captureMediaInsertionTarget(editor)
    await assert.rejects(insertDocumentMedia({ editor, assets, target, file, kind: "audio", readFile: async () => ({ ...asset(), byteLength: 1 }) }), /声明不匹配/)
    assert.equal(assets.size, 0)
    assert.deepEqual(tracker.released, ["blob:media-new"])
  } finally { tracker.restore(); editor.destroy(); other.editor.destroy() }
})

test("迟到资源 ID 与既有资源冲突时保留原 Blob，回收未登记的新 URL", async () => {
  const old = asset("existing")
  const { editor, assets } = session([paragraph("正文"), media(old.id)], new Map([[old.id, old]]))
  const target = capture(editor)
  const tracker = trackRevoke()
  try {
    const duplicate = { ...asset(old.id), url: "blob:duplicate" }
    await assert.rejects(insertDocumentMedia({ editor, assets, target, file, kind: "audio", readFile: async () => duplicate }), /声明不匹配/)
    assert.equal(assets.get(old.id), old)
    assert.deepEqual(getReferencedAssetIds(editor.getJSON()), [old.id])
    assert.deepEqual(tracker.released, ["blob:duplicate"])
  } finally { tracker.restore(); target.dispose(); editor.destroy() }
})
