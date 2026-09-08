import test from "node:test"
import assert from "node:assert/strict"
import React from "react"
import ReactDOM from "react-dom"
import { act } from "react-dom/test-utils.js"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { message } from "antd"
import { createDocument, getReferencedAssetIds } from "../src/pages/editor/tools/document-schema.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createEditorStore } from "../src/pages/editor/tools/create-editor-store.js"
import { useDocumentAttachments } from "../src/pages/editor/hooks/use-document-attachments.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" })
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "Element", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

function createSession() {
  const assets = new Map()
  const editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: createExtensions(id => assets.get(id)?.url || "", id => assets.get(id)), content: "<p>原始文字</p>",
    // jsdom 不提供文本 Range 排版；这里只验证资源生命周期，实际滚动由浏览器验收覆盖。
    editorProps: { handleScrollToSelection: () => true }
  })
  editor.commands.setTextSelection(3)
  const store = createEditorStore({ document: createDocument(), storageVersion: 0 })
  const assetTaskRef = { current: false }
  const container = document.body.appendChild(document.createElement("div"))
  let context
  const Probe = () => {
    context = useDocumentAttachments(editor, assets, store, assetTaskRef)
    return null
  }
  act(() => { ReactDOM.render(React.createElement(Probe), container) })
  return {
    editor, assets, store, assetTaskRef, getContext: () => context,
    unmount: () => act(() => { ReactDOM.unmountComponentAtNode(container) }),
    clear: () => {
      act(() => { ReactDOM.unmountComponentAtNode(container) })
      assets.forEach(asset => { if (asset.url) URL.revokeObjectURL(asset.url) })
      editor.destroy()
      editor.options.element.remove()
      container.remove()
    }
  }
}

function createDelayedFile() {
  const file = new File([new Uint8Array([0, 1, 255])], "延迟附件.bin")
  let resolve
  const reading = new Promise(done => { resolve = done })
  file.arrayBuffer = () => reading
  return { file, finish: () => resolve(new Uint8Array([0, 1, 255]).buffer) }
}

test("附件读取期间选区随事务映射，读取完成不会跟随用户后来移动的光标", async () => {
  const session = createSession()
  const delayed = createDelayedFile()
  let pending
  try {
    act(() => { pending = session.getContext().insertAttachment(delayed.file) })
    assert.equal(session.assetTaskRef.current, true)
    assert.equal(session.getContext().attachmentUploading, true)
    act(() => {
      session.editor.commands.insertContentAt(1, "前缀")
      session.editor.commands.setTextSelection(7)
    })
    await act(async () => {
      delayed.finish()
      assert.equal(await pending, true)
    })
    assert.equal(session.editor.getJSON().content[0].content[0].text, "前缀原始")
    assert.equal(getReferencedAssetIds(session.editor.getJSON()).length, 1)
    assert.equal(session.assetTaskRef.current, false)
    assert.equal(session.getContext().attachmentUploading, false)
  } finally {
    delayed.finish()
    session.clear()
  }
})

for (const reason of ["readOnly", "switching", "deleted", "unmounted", "destroyed"]) {
  test(`附件读取期间 ${reason} 取消迟到结果，不发布资源或残留任务锁`, async () => {
    const session = createSession()
    const delayed = createDelayedFile()
    let pending
    try {
      act(() => { pending = session.getContext().insertAttachment(delayed.file) })
      act(() => {
        if (reason === "readOnly" || reason === "switching") {
          session.store.getState().updateView({ [reason]: true })
          session.store.getState().updateView({ [reason]: false })
        }
        if (reason === "deleted") session.editor.commands.setContent("<p>已替换</p>")
        if (reason === "destroyed") session.editor.destroy()
      })
      if (reason === "unmounted") session.unmount()
      await act(async () => {
        delayed.finish()
        assert.equal(await pending, false)
      })
      assert.equal(session.assets.size, 0)
      assert.equal(session.assetTaskRef.current, false)
      if (!session.editor.isDestroyed) assert.equal(getReferencedAssetIds(session.editor.getJSON()).length, 0)
    } finally {
      delayed.finish()
      session.clear()
    }
  })
}

test("附件读取防重复并复用图片任务锁，错误后恢复状态且允许重试", async () => {
  const session = createSession()
  const delayed = createDelayedFile()
  const messages = []
  const showError = message.error
  message.error = text => messages.push(text)
  let pending
  try {
    session.assetTaskRef.current = true
    assert.equal(await session.getContext().insertAttachment(delayed.file), false)
    session.assetTaskRef.current = false
    act(() => { pending = session.getContext().insertAttachment(delayed.file) })
    assert.equal(await session.getContext().insertAttachment(delayed.file), false)
    await act(async () => {
      delayed.finish()
      await pending
    })
    const before = session.assets.size
    await act(async () => { assert.equal(await session.getContext().insertAttachment(new File(["x"], "../invalid")), false) })
    assert.equal(session.assets.size, before)
    assert.equal(session.getContext().attachmentUploading, false)
    assert.equal(session.assetTaskRef.current, false)
    assert.equal(messages.some(text => text.includes("文件名")), true)
    await act(async () => { assert.equal(await session.getContext().insertAttachment(new File([], "重试.txt")), true) })
  } finally {
    message.error = showError
    delayed.finish()
    session.clear()
  }
})

test("读取期间恢复其他资源后，提交前再次检查合计容量", async () => {
  const session = createSession()
  const delayed = createDelayedFile()
  const showError = message.error
  const messages = []
  message.error = text => messages.push(text)
  let pending
  try {
    act(() => { pending = session.getContext().insertAttachment(delayed.file) })
    act(() => {
      for (let index = 0; index < 4; index += 1) {
        const id = `restored-${index}`
        session.assets.set(id, { id, kind: "attachment", fileName: `${index}.bin`, byteLength: 5 * 1024 * 1024 })
        session.editor.commands.insertContentAt(session.editor.state.doc.content.size, { type: "attachment", attrs: { assetId: id } })
      }
    })
    await act(async () => {
      delayed.finish()
      assert.equal(await pending, false)
    })
    assert.equal(session.assets.size, 4)
    assert.equal(messages.some(text => text.includes("20 MiB")), true)
    assert.equal(session.assetTaskRef.current, false)
  } finally {
    message.error = showError
    delayed.finish()
    session.clear()
  }
})
