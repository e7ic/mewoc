/** 文档导航导出回归：核验刷新后的目录、HTML 真锚点、Markdown/TXT 正文及 DOCX 原生书签。 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { JSDOM } from "jsdom"
import JSZip from "jszip"
import { unified } from "unified"
import remarkParse from "remark-parse"
import { generateHTML } from "@tiptap/core"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { prepareNavigationExportContent, MISSING_NAVIGATION_WARNING } from "../src/pages/editor/tools/navigation-export.js"
import { createDocumentMarkdown, readMarkdownDocument } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentText } from "../src/pages/editor/tools/document-text.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"

const dom = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
}
const ids = Array.from({ length: 8 }, (_, index) => `nav-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`)
const wordName = id => id.replace(/-/g, "_")
const text = (value, marks) => ({ type: "text", text: value, ...(marks && { marks }) })
const paragraph = (value, attrs) => ({ type: "paragraph", ...(attrs && { attrs }), content: typeof value === "string" ? value ? [text(value)] : [] : value })
const heading = (value, level, navigationId, bookmarkName = null) => ({ type: "heading", attrs: { level, navigationId, bookmarkName }, content: [text(value)] })
const link = (value, id) => text(value, [{ type: "link", attrs: { href: `#${id}`, target: "_blank", rel: "noopener noreferrer" } }, { type: "bold" }])
const toc = (title = "章节目录", maxLevel = 3) => ({ type: "tableOfContents", attrs: { title, maxLevel, entries: [{ id: ids[7], level: 1, text: "旧目录条目" }] } })
const record = content => ({ ...createDocument(), content: { type: "doc", content }, assets: [] })
const fixture = () => record([
  toc(), heading("当前一级 <&>", 1, ids[0], "主标题书签"),
  paragraph("书签原文", { navigationId: ids[1], bookmarkName: "论点书签" }),
  { type: "details", attrs: { summary: "折叠说明" }, content: [heading("折叠二级", 2, ids[2]), paragraph([link("跳转论点", ids[1]), text("与"), text("外部网站", [{ type: "link", attrs: { href: "https://example.com/guide?a=1&b=2" } }])])] },
  { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2, rowspan: 1, colwidth: [90, 120] }, content: [heading("合并格三级", 3, ids[3]), paragraph("格内正文")] }] }] },
  { type: "textBox", content: [heading("文本框四级", 4, ids[4]), paragraph([link("跳转框内", ids[4])])] },
  { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("已完成原文", { navigationId: ids[5], bookmarkName: "待办书签" })] }] },
  paragraph([link("失效标签", ids[7])]), toc("扩展目录", 4)
])
const unpack = async (source, assets = new Map(), signal) => {
  const result = await createDocumentDocx(source, assets, signal)
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml").async("string")
  const parsed = new DOMParser().parseFromString(xml, "application/xml")
  assert.equal(parsed.querySelector("parsererror"), null)
  return { ...result, zip, xml, parsed }
}
const allTocs = content => {
  const found = []
  const visit = node => { if (node.type === "tableOfContents") found.push(node); node.content?.forEach(visit) }
  visit(content)
  return found
}

test("导航导出副本按真实标题刷新多个目录，保留合法窗口内跳转，失效链接只去 mark 不改原稿", () => {
  const source = fixture()
  const before = structuredClone(source)
  const result = prepareNavigationExportContent(source.content)
  const directories = allTocs(result.content)
  assert.deepEqual(directories[0].attrs.entries.map(entry => entry.id), [ids[0], ids[2], ids[3]])
  assert.deepEqual(directories[1].attrs.entries.map(entry => entry.id), [ids[0], ids[2], ids[3], ids[4]])
  assert.equal(result.targets.size, 6)
  const valid = result.content.content[3].content[1].content[0]
  assert.equal(valid.marks.find(mark => mark.type === "link").attrs.target, "_self")
  const missing = result.content.content[7].content[0]
  assert.deepEqual(missing.marks, [{ type: "bold" }])
  assert.deepEqual(result.warnings, [MISSING_NAVIGATION_WARNING])
  assert.deepEqual(source, before)
})

test("静态 HTML 目录和原文内部链接使用真实唯一 id，折叠/合并格/文本框内目标完整保留", () => {
  const source = fixture()
  const before = structuredClone(source)
  const prepared = prepareNavigationExportContent(source.content)
  const html = generateHTML(prepared.content, createExtensions())
  const rendered = new DOMParser().parseFromString(html, "text/html")
  const directories = [...rendered.querySelectorAll('nav[data-type="table-of-contents"]')]
  assert.equal(directories.length, 2)
  assert.deepEqual([...directories[0].querySelectorAll("a")].map(anchor => anchor.textContent), ["当前一级 <&>", "折叠二级", "合并格三级"])
  assert.deepEqual([...directories[1].querySelectorAll("a")].map(anchor => anchor.textContent), ["当前一级 <&>", "折叠二级", "合并格三级", "文本框四级"])
  for (const anchor of rendered.querySelectorAll('a[href^="#nav-"]')) {
    const id = anchor.getAttribute("href").slice(1)
    assert.equal(rendered.querySelectorAll(`[id="${id}"]`).length, 1)
    assert.equal(anchor.getAttribute("target"), "_self")
  }
  assert.equal(rendered.querySelector('a[href="https://example.com/guide?a=1&b=2"]').textContent, "外部网站")
  assert.equal(rendered.querySelector(`a[href="#${ids[7]}"]`), null)
  assert.ok(rendered.body.textContent.includes("失效标签"))
  assert.equal(rendered.querySelector("details").hasAttribute("open"), true)
  assert.ok(rendered.querySelector(`td[colspan="2"] [id="${ids[3]}"]`))
  assert.ok(rendered.querySelector(`[data-type="text-box"] [id="${ids[4]}"]`))
  assert.doesNotMatch(html, /<script|contenteditable|旧目录条目/)
  assert.deepEqual(source, before)
})

test("Markdown 导出实际目录快照及完整正文，内部跳转降为原标签，外部链接和其他格式仍可往返", async () => {
  const source = fixture()
  const before = structuredClone(source)
  const result = await createDocumentMarkdown(source)
  assert.match(result.source, /章节目录/)
  assert.match(result.source, /扩展目录/)
  for (const value of ["当前一级", "折叠二级", "合并格三级", "文本框四级", "跳转论点", "跳转框内", "失效标签", "格内正文"]) assert.ok(result.source.includes(value), value)
  assert.doesNotMatch(result.source, /#nav-|nav_0000|旧目录条目|论点书签|待办书签/)
  assert.match(result.source, /https:\/\/example\.com\/guide/)
  assert.ok(result.warnings.some(value => value.includes("目录已转换")))
  assert.ok(result.warnings.some(value => value.includes("文内链接已转换")))
  assert.ok(result.warnings.some(value => value.includes("文档书签")))
  assert.ok(result.warnings.includes(MISSING_NAVIGATION_WARNING))
  const imported = await readMarkdownDocument(result.source)
  const readable = createDocumentText(imported.record.document)
  assert.match(readable, /\[x\] 已完成原文/)
  assert.match(readable, /折叠说明/)
  assert.deepEqual(source, before)
})

test("Markdown 目录重新解析后仍是嵌套列表，跳级标题使用最近低级父项且不补虚构条目", async () => {
  const values = [["起始三级", 3], ["跳级五级", 5], ["回到四级", 4], ["深入六级", 6],
    ["新一级", 1], ["新章四级", 4], ["回到二级", 2], ["同级二级", 2]]
  const source = record([toc("层级目录", 6), ...values.map(([value, level], index) => heading(value, level, ids[index]))])
  const before = structuredClone(source)
  const exported = await createDocumentMarkdown(source)
  // 核验输出再解析得到的实际结构，不能只断言源字符串有空格或包含标题文字。
  const tree = unified().use(remarkParse).parse(exported.source)
  const list = tree.children.find(node => node.type === "list")
  const topology = node => node.children.map(item => {
    assert.equal(item.type, "listItem")
    const paragraph = item.children.find(child => child.type === "paragraph")
    const children = item.children.find(child => child.type === "list")
    assert.equal(paragraph.children.every(child => child.type === "text"), true)
    return [paragraph.children.map(child => child.value).join(""), children ? topology(children) : []]
  })
  assert.deepEqual(topology(list), [
    ["起始三级", [["跳级五级", []], ["回到四级", [["深入六级", []]]]]],
    ["新一级", [["新章四级", []], ["回到二级", []], ["同级二级", []]]]
  ])
  assert.equal(tree.children.filter(node => node.type === "list").length, 1)
  assert.deepEqual(source, before)
})

test("纯文本保留目录标题、按层级缩进的条目及全部正文，不泄露书签名字、ID、旧快照或页码", () => {
  const source = fixture()
  const before = structuredClone(source)
  const result = createDocumentText(source)
  assert.match(result, /章节目录\n\n当前一级 <&>\n\n  折叠二级\n\n    合并格三级/)
  assert.match(result, /扩展目录\n\n当前一级 <&>\n\n  折叠二级\n\n    合并格三级\n\n      文本框四级/)
  for (const value of ["书签原文", "折叠说明", "格内正文", "跳转论点", "跳转框内", "失效标签", "[x] 已完成原文"]) assert.ok(result.includes(value), value)
  assert.doesNotMatch(result, /nav-|论点书签|待办书签|旧目录条目/)
  assert.deepEqual(source, before)
})

test("DOCX 多个锚点生成唯一配对整数与稳定安全名称，目录及原链接均为原生 w:anchor", async () => {
  const source = fixture()
  const before = structuredClone(source)
  const result = await unpack(source)
  const starts = [...result.parsed.getElementsByTagName("w:bookmarkStart")]
  const ends = [...result.parsed.getElementsByTagName("w:bookmarkEnd")]
  assert.equal(starts.length, 6)
  assert.equal(ends.length, 6)
  const numbers = starts.map(node => node.getAttribute("w:id"))
  assert.equal(new Set(numbers).size, starts.length)
  assert.deepEqual(new Set(ends.map(node => node.getAttribute("w:id"))), new Set(numbers))
  const names = starts.map(node => node.getAttribute("w:name"))
  assert.deepEqual(new Set(names), new Set(ids.slice(0, 6).map(wordName)))
  for (const name of names) assert.match(name, /^[A-Za-z][A-Za-z\d_]{0,39}$/)
  const internal = [...result.parsed.getElementsByTagName("w:hyperlink")].filter(node => node.hasAttribute("w:anchor"))
  assert.equal(internal.length, 9)
  for (const anchor of internal) {
    assert.ok(names.includes(anchor.getAttribute("w:anchor")))
    assert.equal(anchor.hasAttribute("r:id"), false)
  }
  const missing = [...result.parsed.getElementsByTagName("w:p")].find(node => node.textContent === "失效标签")
  assert.ok(missing)
  assert.equal(missing.getElementsByTagName("w:hyperlink").length, 0)
  assert.ok(missing.getElementsByTagName("w:b").length)
  const relations = await result.zip.file("word/_rels/document.xml.rels").async("string")
  assert.match(relations, /https:\/\/example\.com\/guide/)
  assert.doesNotMatch(relations, /Target="#nav-/)
  assert.doesNotMatch(result.xml, /旧目录条目|w:fldChar|NUMPAGES|PAGEREF|w:instrText/)
  assert.ok(result.warnings.some(value => value.includes("可点击快照")))
  assert.ok(result.warnings.includes(MISSING_NAVIGATION_WARNING))
  assert.deepEqual(source, before)
})

test("DOCX 合并单元格、折叠详情和文本框内书签位于目标原文段落，前方分页仅作用于目录标题", async () => {
  const source = fixture()
  source.content.content.unshift(paragraph("前页"), { type: "pageBreak" })
  const result = await unpack(source)
  const paragraphs = [...result.parsed.getElementsByTagName("w:p")]
  for (const [id, value] of [[ids[2], "折叠二级"], [ids[3], "合并格三级"], [ids[4], "文本框四级"], [ids[5], "[x] 已完成原文"]]) {
    const start = [...result.parsed.getElementsByTagName("w:bookmarkStart")].find(node => node.getAttribute("w:name") === wordName(id))
    assert.ok(start)
    assert.equal(start.parentNode.textContent, value)
    assert.equal(start.parentNode.tagName, "w:p")
  }
  assert.ok(result.parsed.getElementsByTagName("w:gridSpan").length)
  const startsPage = node => node.getElementsByTagName("w:pageBreakBefore").length > 0 && node.getElementsByTagName("w:pageBreakBefore")[0].getAttribute("w:val") !== "false"
  assert.equal(paragraphs.filter(startsPage).length, 1)
  assert.ok(startsPage(paragraphs.find(node => node.textContent === "章节目录")))
  assert.ok(!startsPage(paragraphs.find(node => node.textContent === "扩展目录")))
})

test("空目录、未命名普通段落锚点及空目标段均可导出，已有原文不被占位文案污染", async () => {
  const source = record([toc("空目录", 1), paragraph("", { navigationId: ids[0], bookmarkName: null }), paragraph([link("跳往空段", ids[0])])])
  const prepared = prepareNavigationExportContent(source.content)
  assert.equal(allTocs(prepared.content)[0].attrs.entries.length, 0)
  assert.deepEqual(prepared.warnings, [])
  const markdown = await createDocumentMarkdown(source)
  assert.match(markdown.source, /空目录/)
  assert.match(markdown.source, /跳往空段/)
  assert.doesNotMatch(markdown.source, /未命名标题|旧目录/)
  const word = await unpack(source)
  const start = word.parsed.getElementsByTagName("w:bookmarkStart")[0]
  assert.equal(start.parentNode.textContent, "")
  assert.equal(word.parsed.getElementsByTagName("w:hyperlink")[0].getAttribute("w:anchor"), wordName(ids[0]))
  assert.equal(word.warnings.includes(MISSING_NAVIGATION_WARNING), false)
})

test("空标题目录条目在各输出中有可读标签，标签仅属于目录，目标空标题和原稿保持空内容", async () => {
  const source = record([toc(), { type: "heading", attrs: { level: 1, navigationId: ids[0] }, content: [] }])
  const before = structuredClone(source)
  const prepared = prepareNavigationExportContent(source.content)
  assert.equal(allTocs(prepared.content)[0].attrs.entries[0].text, "")
  const rendered = new DOMParser().parseFromString(generateHTML(prepared.content, createExtensions()), "text/html")
  assert.equal(rendered.querySelector(`a[href="#${ids[0]}"]`).textContent, "未命名标题")
  assert.equal(rendered.getElementById(ids[0]).textContent, "")
  assert.match(createDocumentText(source), /未命名标题/)
  const markdown = await createDocumentMarkdown(source)
  assert.match(markdown.source, /未命名标题/)
  const word = await unpack(source)
  assert.equal(word.parsed.getElementsByTagName("w:hyperlink")[0].textContent, "未命名标题")
  assert.equal(word.parsed.getElementsByTagName("w:bookmarkStart")[0].parentNode.textContent, "")
  assert.deepEqual(source, before)
})

test("导航输出不会丢图片、公式、源码、附件及待办，仍保留未知内容与取消的拒绝边界", async () => {
  const portable = JSON.parse(await readFile(new URL("./fixtures/m5-current-document.mewoc.json", import.meta.url), "utf8"))
  const image = portable.document.assets[0]
  const attachment = { id: "navigation-attachment", kind: "attachment", fileName: "导航附件.txt", mimeType: "text/plain", byteLength: 3 }
  const source = record([toc(), heading("资源标题", 1, ids[0]),
    { type: "image", attrs: { assetId: image.id, width: 120, height: 90, alt: "资源图片" } },
    { type: "attachment", attrs: { assetId: attachment.id } },
    { type: "blockMath", attrs: { latex: "x^2" } }, { type: "codeBlock", attrs: { language: "plaintext" }, content: [text("<code>&\n下一行")] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph("待办原文")] }] }
  ])
  source.assets = [image, attachment]
  const assets = new Map([
    [image.id, { ...image, blob: new Blob([Buffer.from(portable.assetData[image.id].split(",")[1], "base64")], { type: image.mimeType }) }],
    [attachment.id, { ...attachment, blob: new Blob(["abc"], { type: attachment.mimeType }) }]
  ])
  validateDocument(source)
  const before = structuredClone(source)
  const result = await unpack(source, assets)
  assert.equal(result.parsed.getElementsByTagName("w:drawing").length, 1)
  assert.equal(result.parsed.getElementsByTagName("m:oMath").length, 1)
  assert.ok(result.parsed.documentElement.textContent.includes("<code>&"))
  assert.ok(result.parsed.documentElement.textContent.includes("[ ] 待办原文"))
  assert.ok(result.parsed.documentElement.textContent.includes("导航附件.txt"))
  const markdown = await createDocumentMarkdown(source)
  assert.match(markdown.source, /资源图片/)
  assert.match(markdown.source, /待办原文/)
  assert.match(markdown.source, /x\^2/)
  assert.match(markdown.source, /导航附件\.txt/)
  assert.deepEqual(source, before)
  const unknown = record([toc(), { type: "futureNavigation" }])
  await assert.rejects(() => createDocumentMarkdown(unknown), /不支持/)
  await assert.rejects(() => createDocumentDocx(unknown, new Map()), /不支持/)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(() => createDocumentDocx(source, assets, cancelled.signal), { name: "AbortError" })
})
