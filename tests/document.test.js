import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { createDocument, validateDocument, validatePage, isSafeLink } from "../src/pages/editor/tools/document-schema.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  // Node 24 提供只读 navigator getter；测试环境显式安装自己的 DOM 对象。
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(bytes => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`
      this.onload()
    })
  }
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII="

test("文档拒绝未知节点、未知属性与未来版本，保留原始内容", () => {
  const document = createDocument()
  assert.doesNotThrow(() => validateDocument(document))
  assert.throws(() => validateDocument({ ...document, schemaVersion: 2 }), /版本/)
  assert.throws(() => validateDocument({ ...document, content: { type: "doc", content: [{ type: "unknown" }] } }), /content.0/)
  assert.throws(() => validateDocument({ ...document, content: { type: "doc", content: [{ type: "paragraph", attrs: { onclick: "alert(1)" } }] } }), /未知属性/)
  assert.equal(document.content.content[0].type, "paragraph")
})

test("链接与纸张在边界拒绝非法值", () => {
  assert.equal(isSafeLink("javascript:alert(1)"), false)
  assert.equal(isSafeLink("https://example.com"), true)
  assert.equal(isSafeLink("java\nscript:alert(1)"), false)
  const page = createDocument().page
  assert.throws(() => validatePage({ ...page, marginsMm: { top: 20, right: 150, bottom: 20, left: 150 } }), /页边距过大/)
})

test("完整扩展组合：段落行距、表格和撤销后的 JSON 仍通过校验", () => {
  const record = createDocument()
  const editor = new Editor({ element: document.createElement("div"), extensions: createExtensions(), content: record.content })
  editor.commands.insertContent("中文与 English")
  editor.commands.setParagraphSpacing(2)
  assert.equal(editor.getJSON().content[0].attrs.lineHeight, 2)
  editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
  assert.equal(editor.getJSON().content.some(node => node.type === "table"), true)
  assert.doesNotThrow(() => validateDocument({ ...record, content: editor.getJSON() }))
  const names = editor.extensionManager.extensions.map(extension => extension.name)
  assert.equal(new Set(names).size, names.length)
  editor.commands.undo()
  assert.equal(editor.getJSON().content.some(node => node.type === "table"), false)
  assert.doesNotThrow(() => validateDocument({ ...record, content: editor.getJSON() }))
  editor.destroy()
})

test("文字样式 HTML 往返产生的空属性可保存，非法颜色仍被拒绝", () => {
  const record = createDocument()
  const editor = new Editor({ element: document.createElement("div"), extensions: createExtensions(), content: '<p><span style="color: #6657d9">粘贴文字</span></p>' })
  try {
    const content = editor.getJSON()
    assert.equal(content.content[0].content[0].marks[0].attrs.backgroundColor, "")
    assert.doesNotThrow(() => validateDocument({ ...record, content }))
    content.content[0].content[0].marks[0].attrs.color = "url(https://example.com)"
    assert.throws(() => validateDocument({ ...record, content }), /color 无效/)
  } finally {
    editor.destroy()
  }
})

test("带图文件往返保留图片字节、尺寸与资源 ID，导入另建文档 ID", async () => {
  const document = createDocument()
  const blob = new Blob([Buffer.from(PNG, "base64")], { type: "image/png" })
  const asset = { id: "image-test", fileName: "test.png", mimeType: blob.type, byteLength: blob.size }
  document.assets = [asset]
  document.content.content = [{ type: "image", attrs: { assetId: asset.id, width: 100, height: 100, alt: "测试图片", title: "" } }]
  const portable = await createPortableFile(document, new Map([[asset.id, { ...asset, blob }]]))
  const imported = await readPortableFile(new File([JSON.stringify(portable)], "test.mewoc.json"))
  assert.notEqual(imported.document.id, document.id)
  assert.deepEqual(imported.document.content, document.content)
  assert.deepEqual(await imported.assets.get(asset.id).blob.arrayBuffer(), await blob.arrayBuffer())
  delete portable.assetData[asset.id]
  await assert.rejects(() => readPortableFile(new File([JSON.stringify(portable)], "invalid.json")), /图片.*缺失/)
})

test("声明图片但实际内容不匹配时拒绝导入", async () => {
  const document = createDocument()
  document.assets = [{ id: "image-fake", fileName: "fake.png", mimeType: "image/png", byteLength: 3 }]
  const source = { format: "mewoc", formatVersion: 1, document, assetData: { "image-fake": "data:image/png;base64,YWJj" } }
  await assert.rejects(() => readPortableFile(new File([JSON.stringify(source)], "invalid.json")), /文件类型不一致/)
})
