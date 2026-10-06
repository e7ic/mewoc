/** 核对实际 HTML、正文隔离和降级说明，不将静态 CSS 文本匹配当作系统 PDF 通过。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentHtml } from "../src/pages/editor/tools/html-export.js"
import { createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentText, getDocumentTextWarnings } from "../src/pages/editor/tools/document-text.js"
import { createPageFurnitureExport, escapeCssPageText, supportsPageMarginBoxes } from "../src/pages/editor/tools/page-furniture-export.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "Element", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}

const fixture = () => {
  const record = createDocument()
  record.content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "独立正文，不含页面装饰" }] }] }
  record.page.header = { text: "项目周报", alignment: "left", pageNumber: "none" }
  record.page.footer = { text: "内部资料", alignment: "right", pageNumber: "page-total" }
  return record
}

test("离线 HTML 页眉页脚只作为装饰，打印使用 page/pages 原生计数且屏幕页码明确为示意", async () => {
  const record = fixture()
  const before = structuredClone(record)
  const html = await createDocumentHtml(record, new Map())
  const doc = new DOMParser().parseFromString(html, "text/html")
  assert.equal(doc.querySelector("article").textContent, "独立正文，不含页面装饰")
  assert.equal(doc.querySelector("[data-mewoc-page-header]").textContent, "项目周报")
  assert.equal(doc.querySelector("[data-mewoc-page-footer]").textContent, "内部资料 · 第 1 / … 页")
  assert.equal(doc.querySelectorAll("[data-mewoc-page-header]").length, 1)
  assert.ok(doc.querySelector(".mewoc-export-furniture-hint").textContent.includes("实际页码与总页数"))
  const styles = doc.querySelector("style").textContent
  assert.ok(styles.includes("counter(page)") && styles.includes("counter(pages)"))
  assert.match(styles, /@top-center\s*\{[^}]+text-align: left/)
  assert.match(styles, /@bottom-center\s*\{[^}]+text-align: right/)
  assert.match(styles, /@media print\s*\{[^}]*furniture-hint\s*\{ display: none/)
  assert.deepEqual(record, before)
})

test("文字安全编码分别覆盖 CSS/HTML，style闭合、反斜杠、引号与Unicode不成为活动内容", async () => {
  const record = fixture()
  record.page.header.text = '</style>"\\ <字>&😀'
  const html = await createDocumentHtml(record, new Map())
  const doc = new DOMParser().parseFromString(html, "text/html")
  assert.equal(doc.querySelectorAll("style").length, 1)
  assert.equal(doc.querySelector("script"), null)
  assert.equal(doc.querySelector("[data-mewoc-page-header]").textContent, record.page.header.text)
  assert.ok(!doc.querySelector("style").textContent.includes("</style>"))
  assert.ok(escapeCssPageText(record.page.header.text).includes("\\1f600 "))
})

test("未启用或空白设置不产生空页眉页脚、额外打印规则与兼容提示", async () => {
  for (const value of [undefined, null, { text: "  ", alignment: "left", pageNumber: "none" }]) {
    const record = createDocument()
    if (value !== undefined) record.page.header = value
    const output = createPageFurnitureExport(record.page)
    assert.deepEqual(output, { marginBoxes: "", furniture: "", hint: "", styles: "" })
    assert.ok(!(await createDocumentHtml(record, new Map())).includes("mewoc-export-furniture-hint"))
  }
})

test("Markdown与纯文本明确说明页眉页脚损失，装饰和假页码不混入正文", async () => {
  const record = fixture()
  const markdown = await createDocumentMarkdown(record)
  assert.ok(markdown.warnings.some(text => text.includes("页眉、页脚和页码")))
  assert.ok(getDocumentTextWarnings(record).some(text => text.includes("页眉、页脚和页码")))
  for (const value of [markdown.source, createDocumentText(record)]) {
    assert.ok(value.includes("独立正文"))
    assert.ok(!value.includes("项目周报") && !value.includes("内部资料") && !value.includes("第 1"))
  }
})

test("HTML导出固定页眉页脚快照，异步编码期间继续编辑不会混入已生成文件", async () => {
  const record = fixture()
  const promise = createDocumentHtml(record, new Map())
  record.page.header.text = "稍后改写"
  record.page.footer.pageNumber = "none"
  const doc = new DOMParser().parseFromString(await promise, "text/html")
  assert.equal(doc.querySelector("[data-mewoc-page-header]").textContent, "项目周报")
  assert.equal(doc.querySelector("[data-mewoc-page-footer]").textContent, "内部资料 · 第 1 / … 页")
})

test("能力检测确认真实嵌套边距规则，空规则与解析失败不冒充支持", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "CSSStyleSheet")
  try {
    for (const [rules, expected] of [[[{ cssRules: [{ name: "top-center" }] }], true], [[{ cssRules: [] }], false], [[], false]]) {
      globalThis.CSSStyleSheet = class { cssRules = rules; replaceSync() {} }
      assert.equal(supportsPageMarginBoxes(), expected)
    }
    globalThis.CSSStyleSheet = class { replaceSync() { throw new Error("不支持") } }
    assert.equal(supportsPageMarginBoxes(), false)
  } finally {
    if (original) Object.defineProperty(globalThis, "CSSStyleSheet", original)
    else delete globalThis.CSSStyleSheet
  }
})
