/**
 * 图片替换验收：读取期间使用真实事务移动/删除原图，提交仅替换资源引用并保留一步撤销。
 * 解码作为异步依赖控制等待时点，容量与 Blob/URL 生命周期仍走产品实现，不把断言写成实现复刻。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { Plugin } from "@tiptap/pm/state"
import { DocumentImage } from "../src/pages/editor/extensions/document-image.js"
import { captureImageSettingsTarget } from "../src/pages/editor/tools/image-settings.js"
import { applyImageReplacement, checkImageReplacementCapacity, getImageReplacementTarget,
  replaceDocumentImage } from "../src/pages/editor/tools/image-replacement.js"
import { validateImageBlob } from "../src/pages/editor/tools/image-assets.js"
import { MAX_ASSET_BYTES } from "../src/pages/editor/constants/editor-constants.js"

const dom = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const originalAttrs = { assetId: "image-a", width: 310.5, height: 150.25, align: "right", lockAspectRatio: false,
  alt: "原替代文本", title: "原说明" }
const image = attrs => ({ type: "image", attrs: { ...originalAttrs, ...attrs } })
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const replacement = () => ({ id: "image-new", url: "blob:image-new", byteLength: 1024,
  mimeType: "image/png", width: 520, height: 260, blob: new Blob(["new"], { type: "image/png" }) })
const file = { size: 1024, name: "new.png", type: "image/png" }
const createSession = (content = [paragraph("前"), image(), paragraph("后")], assets = new Map([
  ["image-a", { id: "image-a", url: "blob:image-a", byteLength: 4096, blob: new Blob(["old"], { type: "image/png" }) }]
])) => ({ assets, editor: new Editor({
  element: document.createElement("div"),
  extensions: [StarterKit.configure({ trailingNode: false }), TableKit, DocumentImage.configure({ getAssetUrl: id => assets.get(id)?.url || "" })],
  content: { type: "doc", content }
}) })
const positions = editor => {
  const result = []
  editor.state.doc.descendants((node, position) => { if (node.type.name === "image") result.push(position) })
  return result
}
const attrsAt = (editor, index = 0) => ({ ...editor.state.doc.nodeAt(positions(editor)[index]).attrs })
const capture = (editor, index = 0) => {
  editor.commands.setNodeSelection(positions(editor)[index])
  return captureImageSettingsTarget(editor)
}
// Promise 暂停的是文件解码，不暂停正文；测试用真实编辑器操作复现读取期间用户继续编辑的情况。
const deferredReader = () => {
  let resolve
  const promise = new Promise(complete => { resolve = complete })
  return { readFile: () => promise, resolve: value => resolve(value || replacement()) }
}
// 仅记录释放调用，防止错误路径误释放已经供正文或撤销历史引用的旧/新 URL。
const observeRevoke = () => {
  const original = URL.revokeObjectURL
  const released = []
  URL.revokeObjectURL = url => released.push(url)
  return { released, restore: () => { URL.revokeObjectURL = original } }
}

test("换图保留当前全部排版字段与说明，NodeView 即时显示新 URL，独立一次撤销/重做", async () => {
  const { editor, assets } = createSession()
  const target = capture(editor)
  const tracker = observeRevoke()
  try {
    editor.commands.insertContentAt(1, "新增")
    const before = attrsAt(editor)
    const originalBlob = assets.get("image-a").blob
    assert.equal(await replaceDocumentImage({ editor, assets, target, file, readFile: async () => replacement() }), true)
    assert.deepEqual(attrsAt(editor), { ...before, assetId: "image-new" })
    assert.equal(editor.view.dom.querySelector("figure img").getAttribute("src"), "blob:image-new")
    assert.equal(assets.get("image-a").blob, originalBlob)
    assert.equal(editor.commands.undo(), true)
    assert.deepEqual(attrsAt(editor), before)
    assert.equal(editor.state.doc.firstChild.textContent, "新增前")
    assert.equal(editor.view.dom.querySelector("figure img").getAttribute("src"), "blob:image-a")
    assert.equal(editor.commands.redo(), true)
    assert.equal(attrsAt(editor).assetId, "image-new")
    assert.deepEqual(tracker.released, [])
  } finally { tracker.restore(); target.dispose(); editor.destroy() }
})

test("读取期间改选区和前方编辑仍替换原图，期间更新的图片说明/尺寸保留", async () => {
  const { editor, assets } = createSession([paragraph("前"), image(), paragraph("中"), image({ assetId: "image-b" }), paragraph("后")],
    new Map([["image-a", { byteLength: 4096, url: "blob:image-a" }], ["image-b", { byteLength: 4096, url: "blob:image-b" }]]))
  const target = capture(editor)
  const pending = deferredReader()
  try {
    const operation = replaceDocumentImage({ editor, assets, target, file, readFile: pending.readFile })
    editor.commands.insertContentAt(1, "移动原图")
    editor.view.dispatch(editor.state.tr.setNodeAttribute(positions(editor)[0], "title", "读取期间的新说明")
      .setNodeAttribute(positions(editor)[0], "width", 333))
    editor.commands.setNodeSelection(positions(editor)[1])
    pending.resolve()
    assert.equal(await operation, true)
    assert.equal(attrsAt(editor).assetId, "image-new")
    assert.equal(attrsAt(editor).title, "读取期间的新说明")
    assert.equal(attrsAt(editor).width, 333)
    assert.equal(attrsAt(editor, 1).assetId, "image-b")
  } finally { target.dispose(); editor.destroy() }
})

test("容量排除只由目标引用的旧图，共享图片引用仍计入额度，原资源始终保留", async () => {
  for (const shared of [false, true]) {
    const assets = new Map([["image-a", { byteLength: 5 * 1024 * 1024, url: "blob:image-a" }],
      ["filler", { byteLength: MAX_ASSET_BYTES - 5 * 1024 * 1024, url: "blob:filler" }]])
    const { editor } = createSession([image(), image({ assetId: "filler" }), ...(shared ? [image()] : [])], assets)
    const target = capture(editor)
    try {
      if (shared) assert.throws(() => checkImageReplacementCapacity(editor, assets, target, 1024), /20 MiB/)
      else {
        assert.equal(checkImageReplacementCapacity(editor, assets, target, 1024), true)
        assert.equal(await replaceDocumentImage({ editor, assets, target, file, readFile: async () => replacement() }), true)
        assert.ok(assets.has("image-a"))
      }
    } finally { target.dispose(); editor.destroy() }
  }
})

test("读取期间新增资源使容量超限时不写原图，解码所得新 URL 被释放且不登记", async () => {
  const { editor, assets } = createSession()
  const target = capture(editor)
  const pending = deferredReader()
  const tracker = observeRevoke()
  try {
    const operation = replaceDocumentImage({ editor, assets, target, file, readFile: pending.readFile })
    assets.set("full", { byteLength: MAX_ASSET_BYTES, url: "blob:full" })
    editor.commands.insertContentAt(editor.state.doc.content.size, image({ assetId: "full" }))
    pending.resolve()
    await assert.rejects(operation, /20 MiB/)
    assert.equal(attrsAt(editor).assetId, "image-a")
    assert.equal(assets.has("image-new"), false)
    assert.deepEqual(tracker.released, ["blob:image-new"])
  } finally { tracker.restore(); target.dispose(); editor.destroy() }
})

test("删除原图后同位置重插同资源也取消，换图再撤销恢复旧资源不能复活旧任务", async () => {
  for (const action of ["delete-reinsert", "asset-change-and-restore"]) {
    const { editor, assets } = createSession()
    const target = capture(editor)
    const pending = deferredReader()
    const tracker = observeRevoke()
    try {
      const operation = replaceDocumentImage({ editor, assets, target, file, readFile: pending.readFile })
      const position = positions(editor)[0]
      if (action === "delete-reinsert") {
        editor.view.dispatch(editor.state.tr.delete(position, position + 1))
        editor.commands.insertContentAt(position, image())
      } else {
        editor.view.dispatch(editor.state.tr.setNodeAttribute(position, "assetId", "image-b"))
        editor.commands.undo()
      }
      assert.equal(target.getSelection(), null)
      pending.resolve()
      assert.equal(await operation, false)
      assert.equal(attrsAt(editor).assetId, "image-a")
      assert.equal(assets.has("image-new"), false)
      assert.deepEqual(tracker.released, ["blob:image-new"])
    } finally { tracker.restore(); target.dispose(); editor.destroy() }
  }
})

test("读取期间表格修复的追加事务移动原图仍可提交，追加重插原图永久失效", async () => {
  for (const replaceAfter of [false, true]) {
    const { editor, assets } = createSession()
    let target
    const pending = deferredReader()
    try {
      if (replaceAfter) editor.registerPlugin(new Plugin({ appendTransaction(transactions, _old, state) {
        if (!transactions.some(transaction => transaction.getMeta("replace-image"))) return null
        const position = positions(editor)[0]
        const node = state.doc.nodeAt(position)
        return state.tr.replaceWith(position, position + 1, state.schema.nodes.image.create(node.attrs))
      } }))
      else editor.commands.insertContentAt(0, { type: "table", content: [
        { type: "tableRow", content: [{ type: "tableCell", content: [paragraph("a")] }, { type: "tableCell", content: [paragraph("b")] }] },
        { type: "tableRow", content: [{ type: "tableCell", content: [paragraph("c")] }, { type: "tableCell", content: [paragraph("d")] }] }
      ] })
      target = capture(editor)
      const operation = replaceDocumentImage({ editor, assets, target, file, readFile: pending.readFile })
      if (replaceAfter) editor.view.dispatch(editor.state.tr.setMeta("replace-image", true))
      else {
        let cellPosition
        editor.state.doc.descendants((node, position) => { if (node.type.name === "tableCell" && cellPosition === undefined) cellPosition = position })
        editor.view.dispatch(editor.state.tr.setNodeAttribute(cellPosition, "colspan", 2))
      }
      pending.resolve()
      assert.equal(await operation, !replaceAfter)
      assert.equal(attrsAt(editor).assetId, replaceAfter ? "image-a" : "image-new")
    } finally { target?.dispose(); editor.destroy() }
  }
})

test("只读/切换中断后恢复、组合输入、销毁与会话关闭均取消读取所得图片", async () => {
  for (const reason of ["readonly", "switching", "composition", "destroy", "session-end"]) {
    const { editor, assets } = createSession()
    const target = capture(editor)
    const pending = deferredReader()
    const tracker = observeRevoke()
    let active = true
    let allowed = true
    let sessionListener
    try {
      const operation = replaceDocumentImage({ editor, assets, target, file, readFile: pending.readFile,
        isActive: () => active, canEdit: () => allowed,
        subscribeSession: callback => { sessionListener = callback; return () => { sessionListener = null } }
      })
      if (["readonly", "switching"].includes(reason)) {
        allowed = false
        if (reason === "readonly") editor.setEditable(false, false)
        sessionListener()
        allowed = true
        editor.setEditable(true, false)
      }
      if (reason === "composition") {
        // 组合输入发生在另一段文字，原图本身应保留；若直接在图片节点选区输入，编辑器会主动删除选中的图。
        editor.commands.setTextSelection(1)
        editor.view.dom.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }))
      }
      if (reason === "destroy") editor.destroy()
      if (reason === "session-end") active = false
      pending.resolve()
      assert.equal(await operation, false, reason)
      assert.equal(assets.has("image-new"), false)
      assert.deepEqual(tracker.released, ["blob:image-new"], reason)
      assert.equal(sessionListener, null)
      if (!editor.isDestroyed) assert.equal(attrsAt(editor).assetId, "image-a")
    } finally { tracker.restore(); target.dispose(); if (!editor.isDestroyed) editor.destroy() }
  }
})

test("失效目标、错误解码、缺失旧资源和不允许编辑均无正文或资源写入", async () => {
  const { editor, assets } = createSession()
  const target = capture(editor)
  let reads = 0
  const readFile = async () => { reads += 1; throw new Error("图片无法解码") }
  try {
    const before = editor.getJSON()
    assert.equal(await replaceDocumentImage({ editor, assets, target: null, file, readFile }), false)
    assert.equal(await replaceDocumentImage({ editor, assets, target, file: null, readFile }), false)
    assert.equal(await replaceDocumentImage({ editor, assets, target, file, readFile, canEdit: () => false }), false)
    assert.equal(reads, 0)
    await assert.rejects(replaceDocumentImage({ editor, assets, target, file, readFile }), /无法解码/)
    assert.equal(reads, 1)
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(assets.size, 1)
    assets.delete("image-a")
    assert.throws(() => checkImageReplacementCapacity(editor, assets, target, 1024), /资源缺失/)
    assert.equal(applyImageReplacement(editor, target, "image-new", () => false), false)
    assert.equal(getImageReplacementTarget(editor, { ...target, getSelection: () => null }), null)
  } finally { target.dispose(); editor.destroy() }
})

test("替换入口复用 PNG/JPEG/WebP 类型与内容校验，伪造图片和超限文件被拒绝", async () => {
  const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], { type: "image/png" })
  await validateImageBlob(png)
  await assert.rejects(validateImageBlob(new Blob(["fake"], { type: "image/png" })), /内容与文件类型/)
  await assert.rejects(validateImageBlob(new Blob(["svg"], { type: "image/svg+xml" })), /PNG、JPEG 或 WebP/)
  await assert.rejects(validateImageBlob(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" })), /5 MiB/)
})
