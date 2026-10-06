/** 静态表头专项：检查正式 HTML 的真实行与嵌套拓扑，结构通过不替代原生系统打印。 */
import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { compile } from "sass"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentHtml } from "../src/pages/editor/tools/html-export.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "Element", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
const styles = compile(new URL("../src/pages/editor/sass/content.scss", import.meta.url).pathname).css
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const cell = (text, header = false, attrs = {}, extra = []) => ({
  type: header ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, ...attrs }, content: [paragraph(text), ...extra]
})
const row = (cells, attrs = {}) => ({ type: "tableRow", attrs, content: cells })
const table = rows => ({ type: "table", content: rows })
const pair = (prefix, header = false) => row([cell(`${prefix}甲`, header), cell(`${prefix}乙`, header)])
const directRows = element => [...element.children].filter(child => ["THEAD", "TBODY", "TFOOT"].includes(child.tagName)).flatMap(group => [...group.children])
const groupRows = (element, tagName) => [...element.children].filter(child => child.tagName === tagName).flatMap(group => [...group.children])

// 正式入口只消费 JSON 快照；页面装饰、编辑 NodeView 或伪造行不会参与输出。
async function exportTables(content) {
  const source = createDocument()
  source.content = { type: "doc", content }
  const before = structuredClone(source)
  const html = await createDocumentHtml(source, new Map(), styles)
  assert.deepEqual(source, before, "导出改写了源文档或合并属性")
  const parsed = new DOMParser().parseFromString(html, "text/html")
  assert.equal(parsed.querySelector("[data-mewoc-page-gap], [data-mewoc-table-pagination], .ProseMirror-widget, [contenteditable], [data-resize-handle]"), null)
  return { source, html, parsed, tables: [...parsed.querySelectorAll("article.mewoc-content table")] }
}

// 行与正文逐项核对，不能仅凭 thead 存在就判定无重行、漏行或伪造空白行。
function assertRows(element, texts, headerCount) {
  assert.deepEqual(directRows(element).map(current => current.textContent), texts)
  assert.equal(groupRows(element, "THEAD").length, headerCount)
  assert.equal(groupRows(element, "TBODY").length, texts.length - headerCount)
}

test("HTML 长表格只保存一份真实表头和全部数据行，打印样式声明重复表头组", async () => {
  const rows = [pair("标题", true), ...Array.from({ length: 48 }, (_item, index) => pair(`数据 ${index + 1} `))]
  const { parsed, tables: [rendered] } = await exportTables([table(rows)])
  assertRows(rendered, rows.map(current => current.content.map(item => item.content[0].content[0].text).join("")), 1)
  assert.equal(rendered.querySelectorAll("th").length, 2)
  assert.equal(rendered.querySelectorAll("td").length, 96)
  const sheet = new JSDOM(parsed.documentElement.outerHTML).window.document.styleSheets[0]
  const printRules = [...sheet.cssRules].filter(rule => rule.conditionText === "print").flatMap(rule => [...rule.cssRules])
  assert.equal(printRules.find(rule => rule.selectorText === ".mewoc-content thead").style.getPropertyValue("display"), "table-header-group")
  assert.equal(printRules.find(rule => rule.selectorText === ".mewoc-content tbody").style.getPropertyValue("display"), "table-row-group")
})

test("HTML 多行起始表头支持横向合并，列宽、行高、样式与富文本原样保留", async () => {
  const heading = cell("上层分组", true, { colspan: 2, colwidth: [160, 180], backgroundColor: "#ddeeff", paddingX: 17 })
  heading.content[0].content[0].marks = [{ type: "bold" }]
  const { tables: [rendered] } = await exportTables([table([
    row([heading], { minHeight: 48 }), pair("二级标题", true), pair("正文")
  ])])
  assertRows(rendered, ["上层分组", "二级标题甲二级标题乙", "正文甲正文乙"], 2)
  const group = rendered.querySelector("thead th")
  assert.equal(group.colSpan, 2)
  assert.equal(group.getAttribute("colwidth"), "160,180")
  assert.equal(group.style.backgroundColor, "rgb(221, 238, 255)")
  assert.equal(group.style.paddingLeft, "17px")
  assert.equal(group.parentElement.style.height, "48px")
  assert.equal(group.querySelector("strong").textContent, "上层分组")
  assert.equal(rendered.querySelectorAll("colgroup > col").length, 2)
})

test("HTML 混合起始格不成为重复表头，后续全表头行保留在正文组", async () => {
  const { tables: [rendered] } = await exportTables([table([
    row([cell("首行表头格", true), cell("首行普通格")]), pair("后来表头", true), pair("正文")
  ])])
  assertRows(rendered, ["首行表头格首行普通格", "后来表头甲后来表头乙", "正文甲正文乙"], 0)
  assert.equal(rendered.querySelector("thead"), null)
})

test("HTML 起始纵向合并表头保持 tbody 与原 rowspan，不能提取合并的部分行", async () => {
  const { tables: [rendered] } = await exportTables([table([
    row([cell("跨行表头", true, { rowspan: 2 }), cell("首行右格", true)]),
    row([cell("次行右格", true)]), pair("正文")
  ])])
  assertRows(rendered, ["跨行表头首行右格", "次行右格", "正文甲正文乙"], 0)
  assert.equal(rendered.querySelector("th").rowSpan, 2)
  assert.equal(rendered.querySelectorAll("th").length, 3)
})

test("HTML 连续表头前缀遇纵向合并即停止，只提取合并之前的合法原行", async () => {
  const { tables: [rendered] } = await exportTables([table([
    pair("可重复", true),
    row([cell("合并表头", true, { rowspan: 2 }), cell("右上", true)]),
    row([cell("右下", true)]), pair("正文")
  ])])
  assertRows(rendered, ["可重复甲可重复乙", "合并表头右上", "右下", "正文甲正文乙"], 1)
  assert.equal(rendered.querySelector("tbody th").rowSpan, 2)
})

test("HTML 中部表头不会启动重复，末尾样式表头同样保持真实位置", async () => {
  const { tables: [rendered] } = await exportTables([table([pair("前文"), pair("中部表头", true), pair("后文"), pair("末尾表头", true)])])
  assertRows(rendered, ["前文甲前文乙", "中部表头甲中部表头乙", "后文甲后文乙", "末尾表头甲末尾表头乙"], 0)
  assert.equal(rendered.querySelectorAll("th").length, 4)
})

test("HTML 嵌套表独立分组，嵌套普通格不影响外表头、嵌套表头不污染外正文", async () => {
  const nestedBody = table([pair("内层普通")])
  const nestedHead = table([pair("内层表头", true), pair("内层正文")])
  const { tables } = await exportTables([table([
    row([cell("外层表头甲", true, {}, [nestedBody]), cell("外层表头乙", true)]),
    row([cell("外层正文甲", false, {}, [nestedHead]), cell("外层正文乙")])
  ])])
  assert.equal(tables.length, 3)
  const [outer, innerBody, innerHead] = tables
  assertRows(outer, ["外层表头甲内层普通甲内层普通乙外层表头乙", "外层正文甲内层表头甲内层表头乙内层正文甲内层正文乙外层正文乙"], 1)
  assertRows(innerBody, ["内层普通甲内层普通乙"], 0)
  assertRows(innerHead, ["内层表头甲内层表头乙", "内层正文甲内层正文乙"], 1)
  assert.equal(outer.querySelectorAll("tr").length, 5)
  assert.equal(innerHead.closest("td").parentElement.parentElement.tagName, "TBODY")
})

test("HTML 无表头与全部表头表格保持合法结构、原行次序和正文恰好一次", async () => {
  const { tables } = await exportTables([table([pair("普通首行"), pair("普通末行")]), table([pair("全头首行", true), pair("全头末行", true)])])
  assertRows(tables[0], ["普通首行甲普通首行乙", "普通末行甲普通末行乙"], 0)
  assertRows(tables[1], ["全头首行甲全头首行乙", "全头末行甲全头末行乙"], 2)
  assert.equal(tables[1].querySelectorAll(":scope > tbody").length, 1)
})

test("HTML 表头分组以调用时快照为准，异步后切换表头类型不混入本轮导出", async () => {
  const source = createDocument()
  source.content = { type: "doc", content: [table([pair("原表头", true), pair("正文")])] }
  const pending = createDocumentHtml(source, new Map(), styles)
  source.content.content[0].content[0].content.forEach(item => { item.type = "tableCell" })
  source.content.content[0].content[0].content[0].content[0].content[0].text = "稍后更新"
  const parsed = new DOMParser().parseFromString(await pending, "text/html")
  assertRows(parsed.querySelector("article table"), ["原表头甲原表头乙", "正文甲正文乙"], 1)
  assert.equal(parsed.querySelector("article").textContent.includes("稍后更新"), false)
})
