/** 音视频导出、内部粘贴与 NodeView 清理契约；实际编解码由原生浏览器验收覆盖。 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { JSDOM } from "jsdom"
import JSZip from "jszip"
import { Editor, generateHTML } from "@tiptap/core"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, getReferencedAssetIds } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentHtml } from "../src/pages/editor/tools/html-export.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentText, getDocumentTextWarnings } from "../src/pages/editor/tools/document-text.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { createWaveFile } from "./media-fixtures.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "Element", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
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
// JSDOM 没有媒体引擎；仅记录播放器清理动作，不以模拟事件声称音视频实际可播放。
const stopped = []
DOM.window.HTMLMediaElement.prototype.pause = function () { stopped.push(this) }
DOM.window.HTMLMediaElement.prototype.load = function () {}
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
function fixture() {
  const audio = createWaveFile('<草稿>".wav')
  // WebM 仅容器契约夹具，原生验收另外用浏览器 MediaRecorder 生成完整视频。
  const video = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x18, 0x53, 0x80, 0x67])], "视频.webm", { type: "video/webm" })
  const assets = new Map([["audio", audio], ["video", video]].map(([id, blob]) => [id, {
    id, kind: id, fileName: blob.name, mimeType: blob.type, byteLength: blob.size, blob
  }]))
  const record = createDocument()
  record.title = "M24 导出"
  record.assets = [...assets.values()].map(({ blob: _blob, ...metadata }) => metadata)
  record.content.content = [paragraph("前文"), { type: "media", attrs: { assetId: "audio" } }, { type: "media", attrs: { assetId: "video" } }, paragraph("后文")]
  return { record, assets }
}

test("媒体 HTML：原始字节内嵌、原生控制、文件名安全且不自动播放", async () => {
  const { record, assets } = fixture()
  const before = JSON.stringify(record)
  const html = await createDocumentHtml(record, assets)
  const parsed = new DOMParser().parseFromString(html, "text/html")
  for (const kind of ["audio", "video"]) {
    const player = parsed.querySelector(kind)
    const asset = assets.get(kind)
    assert.ok(player.hasAttribute("controls"))
    assert.equal(player.getAttribute("preload"), "metadata")
    assert.equal(player.hasAttribute("autoplay"), false)
    assert.equal(player.getAttribute("src"), `data:${asset.mimeType};base64,${Buffer.from(await asset.blob.arrayBuffer()).toString("base64")}`)
    const card = player.closest('[data-type="media"]')
    assert.equal(card.querySelector("[data-media-name]").textContent, asset.fileName)
    assert.equal(card.querySelector("a").getAttribute("href"), player.getAttribute("src"))
  }
  assert.equal(parsed.querySelector("script"), null)
  assert.equal(parsed.querySelector("video").hasAttribute("playsinline"), true)
  assert.doesNotMatch(html, /blob:|https:\/\/|contenteditable|onerror=/)
  assert.equal(JSON.stringify(record), before)
})

test("媒体 Word：正文顺序和文件说明保留，不伪造嵌入媒体关系", async () => {
  const { record, assets } = fixture()
  const before = JSON.stringify(record)
  const result = await createDocumentDocx(record, assets)
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml").async("string")
  const parsed = new DOMParser().parseFromString(xml, "application/xml")
  const text = parsed.documentElement.textContent
  assert.ok(text.indexOf("前文") < text.indexOf("[音频："))
  assert.ok(text.indexOf("[音频：") < text.indexOf("[视频："))
  assert.ok(text.indexOf("[视频：") < text.indexOf("后文"))
  assert.ok(text.includes(assets.get("audio").fileName))
  assert.ok(text.includes(assets.get("video").fileName))
  assert.ok(result.warnings.some(value => value.includes("Word 不嵌入播放内容")))
  assert.equal(Object.keys(zip.files).some(name => /word\/media\//.test(name)), false)
  assert.doesNotMatch(await zip.file("word/_rels/document.xml.rels").async("string"), /video|audio|blob:|data:/)
  assert.equal(JSON.stringify(record), before)
})

test("媒体 Markdown 和纯文本：说明与降级提示完整且不改变源文档", async () => {
  const { record } = fixture()
  const before = JSON.stringify(record)
  const markdown = await createDocumentMarkdown(record)
  const plain = createDocumentText(record)
  for (const text of [markdown.source, plain]) {
    assert.ok(text.includes("音频："))
    assert.ok(text.includes("视频：视频.webm"))
    assert.ok(text.includes("前文") && text.includes("后文"))
    assert.doesNotMatch(text, /blob:|data:|https:\/\//)
  }
  assert.ok(markdown.warnings.some(value => value.includes("音频和视频")))
  assert.ok(getDocumentTextWarnings(record).some(value => value.includes("音频和视频")))
  assert.equal(getDocumentTextWarnings(createDocument()).some(value => value.includes("音频和视频")), false)
  assert.equal(JSON.stringify(record), before)
})

test("媒体粘贴：仅已有且种类匹配的资源可恢复，外部播放地址全部移除", () => {
  const { record, assets } = fixture()
  const extensions = createExtensions(() => "https://example.com/remote", id => assets.get(id))
  const editor = new Editor({ element: document.createElement("div"), extensions })
  try {
    const html = generateHTML(record.content, extensions)
    const clean = cleanPastedHtml(html, (id, kind) => assets.get(id)?.kind === kind)
    assert.doesNotMatch(clean, /https:|<audio|<video|<source|<track/)
    editor.commands.setContent(clean)
    assert.deepEqual(getReferencedAssetIds(editor.getJSON()), ["audio", "video"])
    editor.commands.setContent(cleanPastedHtml(html, () => false))
    assert.equal(getReferencedAssetIds(editor.getJSON()).length, 0)
    assert.ok(editor.getText().includes("视频.webm"))
    const external = cleanPastedHtml('<video src="https://example.com/v"><source src="x"><track src="y"></video><audio src="data:audio/wav;base64,x"></audio>')
    assert.doesNotMatch(external, /src=|<audio|<video|<source|<track/)
    assert.match(external, /外部视频/)
    assert.match(external, /外部音频/)
    editor.commands.setContent(cleanPastedHtml(html.replace('data-media-kind="audio"', 'data-media-kind="video"'), (id, kind) => assets.get(id)?.kind === kind))
    assert.deepEqual(getReferencedAssetIds(editor.getJSON()), ["video"])
  } finally { editor.destroy() }
})

test("媒体 NodeView：相邻编辑保留播放器，删除和销毁停止并释放 src，撤销可恢复", () => {
  const { record, assets } = fixture()
  const editor = new Editor({ element: document.createElement("div"), extensions: createExtensions(id => `blob:${id}`, id => assets.get(id)), content: record.content })
  try {
    const audio = editor.view.dom.querySelector("audio")
    editor.commands.setTextSelection(2)
    editor.commands.insertContent("新增")
    assert.equal(editor.view.dom.querySelector("audio"), audio)
    audio.dispatchEvent(new DOM.window.Event("error"))
    assert.equal(audio.closest('[data-type="media"]').querySelector("[data-media-error]").hidden, false)
    audio.dispatchEvent(new DOM.window.Event("canplay"))
    assert.equal(audio.closest('[data-type="media"]').querySelector("[data-media-error]").hidden, true)
    let pos
    editor.state.doc.descendants((node, index) => { if (node.type.name === "media" && node.attrs.assetId === "audio") pos = index })
    editor.commands.setNodeSelection(pos)
    editor.commands.deleteSelection()
    assert.ok(stopped.includes(audio))
    assert.equal(audio.hasAttribute("src"), false)
    editor.commands.undo()
    assert.equal(editor.view.dom.querySelector("audio").getAttribute("src"), "blob:audio")
    const players = [...editor.view.dom.querySelectorAll("audio,video")]
    editor.destroy()
    assert.ok(players.every(player => stopped.includes(player) && !player.hasAttribute("src")))
  } finally { if (!editor.isDestroyed) editor.destroy() }
})

test("媒体打印样式隐藏播放器与下载控件，保留文件说明", async () => {
  const styles = await readFile(new URL("../src/pages/editor/sass/content.scss", import.meta.url), "utf8")
  const print = styles.slice(styles.lastIndexOf("@media print"))
  assert.match(print, /\[data-media-player\][\s\S]*display:\s*none/)
  assert.match(print, /\[data-media-print\][\s\S]*display:\s*block/)
})
