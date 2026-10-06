/** 导航复制通过产品 sanitizer 和真实 schema；重点防止复制身份抢占、危险片段和正文丢失。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { collectNavigationTargets, isNavigationId } from "../src/pages/editor/tools/document-navigation.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "Element", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const id = "nav-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const otherId = "nav-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const makeEditor = content => new Editor({ element: document.createElement("div"), extensions: createExtensions(), content })
const assertValid = editor => assert.doesNotThrow(() => validateDocument({ ...createDocument(), content: editor.getJSON() }))
const htmlForToc = attrs => {
  const nav = document.createElement("nav")
  nav.setAttribute("data-type", "table-of-contents")
  nav.setAttribute("data-title", attrs.title)
  nav.setAttribute("data-max-level", String(attrs.maxLevel))
  nav.setAttribute("data-entries", JSON.stringify(attrs.entries))
  nav.innerHTML = "<div>伪造标题</div><p>不能成为目录正文的任意标签</p>"
  return nav.outerHTML
}

test("导航 HTML 往返保留标题、段落书签、真实内部链接及只读目录属性", () => {
  const source = makeEditor({ type: "doc", content: [
    { type: "tableOfContents", attrs: { title: "阅读目录", maxLevel: 2, entries: [{ id, level: 2, text: "正文标题" }] } },
    { type: "heading", attrs: { level: 2, navigationId: id, bookmarkName: "章节位置" }, content: [{ type: "text", text: "正文标题" }] },
    { ...paragraph("正文书签"), attrs: { navigationId: otherId, bookmarkName: "段落位置" } },
    { type: "paragraph", content: [{ type: "text", text: "去阅读", marks: [{ type: "link", attrs: { href: `#${otherId}`, target: "_self", rel: "noopener noreferrer" } }] }] }
  ] })
  let restored
  try {
    const cleaned = cleanPastedHtml(source.getHTML())
    restored = makeEditor(cleaned)
    assert.deepEqual(collectNavigationTargets(restored.getJSON()), collectNavigationTargets(source.getJSON()))
    assert.deepEqual(restored.getJSON().content[0].attrs, source.getJSON().content[0].attrs)
    assert.match(restored.getHTML(), new RegExp(`href="#${otherId}"`))
    assertValid(restored)
  } finally { source.destroy(); restored?.destroy() }
})

test("粘贴到同文档时副本及其内部链接重映射，现有目标和原书签名称保持不动", () => {
  const current = { type: "doc", content: [{ ...paragraph("原位置"), attrs: { navigationId: id, bookmarkName: "参考位置" } }] }
  const cleaned = cleanPastedHtml(`<p data-navigation-id="${id}" data-bookmark-name="参考位置">复制位置</p><p><a href="#${id}">副本链接</a><a href="#${otherId}">未复制目标</a></p>`, undefined, current)
  const parsed = new DOMParser().parseFromString(cleaned, "text/html")
  const copiedId = parsed.querySelector("p").getAttribute("data-navigation-id")
  assert.equal(isNavigationId(copiedId), true)
  assert.notEqual(copiedId, id)
  assert.equal(parsed.querySelector("p").id, copiedId)
  assert.equal(parsed.querySelector("p").getAttribute("data-bookmark-name"), "参考位置（副本 1）")
  assert.equal(parsed.querySelectorAll("a")[0].getAttribute("href"), `#${copiedId}`)
  assert.equal(parsed.querySelectorAll("a")[1].getAttribute("href"), `#${otherId}`)
  assert.equal(current.content[0].attrs.navigationId, id)
  assert.equal(current.content[0].attrs.bookmarkName, "参考位置")
})

test("重复源 ID 的粘贴目标分别获得唯一身份，歧义链接保留文字且不猜跳转位置", () => {
  const cleaned = cleanPastedHtml(`<h1 data-navigation-id="${id}">位置一</h1><h2 data-navigation-id="${id}">位置二</h2><p><a href="#${id}">歧义链接文字</a></p>`)
  const parsed = new DOMParser().parseFromString(cleaned, "text/html")
  const ids = [...parsed.querySelectorAll("[data-navigation-id]")].map(element => element.getAttribute("data-navigation-id"))
  assert.equal(ids.length, 2)
  assert.equal(new Set(ids).size, 2)
  assert.equal(ids.every(isNavigationId), true)
  assert.equal(parsed.querySelector("a").hasAttribute("href"), false)
  assert.match(parsed.body.textContent, /歧义链接文字/)
  const restored = makeEditor(cleaned)
  try { assertValid(restored) } finally { restored.destroy() }
})

test("目录快照同复制标题一起重映射，显示文字从有效元数据重建且拒绝额外交互 HTML", () => {
  const attrs = { title: "<阅读>&目录", maxLevel: 2, entries: [{ id, level: 2, text: "<标题>&正文" }] }
  const current = { type: "doc", content: [{ type: "heading", attrs: { level: 2, navigationId: id }, content: [{ type: "text", text: "原标题" }] }] }
  const cleaned = cleanPastedHtml(`${htmlForToc(attrs)}<h2 data-navigation-id="${id}">&lt;标题&gt;&amp;正文</h2>`, undefined, current)
  const parsed = new DOMParser().parseFromString(cleaned, "text/html")
  const targetId = parsed.querySelector("h2").getAttribute("data-navigation-id")
  const toc = parsed.querySelector("nav")
  assert.equal(toc.querySelector("[data-toc-title]").textContent, attrs.title)
  assert.equal(toc.querySelector("a").textContent, attrs.entries[0].text)
  assert.equal(toc.querySelector("a").getAttribute("href"), `#${targetId}`)
  assert.equal(JSON.parse(toc.getAttribute("data-entries"))[0].id, targetId)
  assert.doesNotMatch(toc.textContent, /伪造标题|任意标签/)
  const restored = makeEditor(cleaned)
  try { assertValid(restored) } finally { restored.destroy() }
})

test("非法目录展开为普通内容，非法ID、名称和危险href不恢复但文字不丢失", () => {
  const cleaned = cleanPastedHtml('<nav data-type="table-of-contents" data-title="正常" data-max-level="2.5" data-entries="[]" onclick="bad()"><p>坏目录标题</p><ol><li>保留条目</li></ol><p>额外正文</p></nav><p id="外部锚点" data-navigation-id="nav-invalid" data-bookmark-name="书签">段落正文</p><p><a href="javascript:bad()">危险链接文字</a><a href="#外部锚点">任意片段</a></p>')
  assert.doesNotMatch(cleaned, /data-type="table-of-contents"|data-navigation-id|data-bookmark-name|id=|onclick|javascript:/)
  const restored = makeEditor(cleaned)
  try {
    for (const text of ["坏目录标题", "保留条目", "额外正文", "段落正文", "危险链接文字", "任意片段"]) assert.match(restored.getText(), new RegExp(text))
    assertValid(restored)
  } finally { restored.destroy() }
})

test("80字符书签副本仍符合长度边界，现有多次副本名称不会碰撞", () => {
  const longName = "签".repeat(80)
  const suffix = "（副本 1）"
  const firstCopy = `${longName.slice(0, 80 - suffix.length)}${suffix}`
  const current = { type: "doc", content: [
    { ...paragraph("原签"), attrs: { navigationId: id, bookmarkName: longName } },
    { ...paragraph("副本"), attrs: { navigationId: otherId, bookmarkName: firstCopy } }
  ] }
  const cleaned = cleanPastedHtml(`<p data-navigation-id="${id}" data-bookmark-name="${longName}">复制位置</p>`, undefined, current)
  const parsed = new DOMParser().parseFromString(cleaned, "text/html")
  const name = parsed.querySelector("p").getAttribute("data-bookmark-name")
  assert.equal(name.length, 80)
  assert.notEqual(name, longName)
  assert.notEqual(name, firstCopy)
  const restored = makeEditor(cleaned)
  try { assertValid(restored) } finally { restored.destroy() }
})
