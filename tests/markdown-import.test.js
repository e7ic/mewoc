import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { generateHTML } from "@tiptap/core"
import { readMarkdownSource, readMarkdownDocument, createDocumentMarkdown, MAX_MARKDOWN_BYTES } from "../src/pages/editor/tools/markdown-file.js"
import { createMarkdownContent } from "../src/pages/editor/tools/markdown-import.js"
import { validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}

const getNodes = (content, type) => {
  const nodes = []
  const visit = node => {
    if (node.type === type) nodes.push(node)
    node.content?.forEach(visit)
  }
  visit(content)
  return nodes
}
const getText = node => node.type === "text" ? node.text : (node.content || []).map(getText).join("")

test("Markdown 导入完整结构并通过既有 schema，创建独立文档", async () => {
  const source = "# 标题\n\n**粗体** _斜体_ ~~删除~~ `inline` [链接](https://example.com)\n\n"
    + "3. 第一项\n   - 子项\n4. 第二项\n\n> 引用\n\n---\n\n"
    + "| 名称 | 值 |\n| :--- | ---: |\n| A | **B** |\n\n"
    + '```js\n  const message = "$原样"\n\n```\n\n行内 $x^2$\n\n$$\n\\frac{a}{b}\n$$\n'
  const { record, warnings, preview } = await readMarkdownDocument(source, "测试文档")
  const content = record.document.content
  assert.equal(record.storageVersion, 0)
  assert.equal(record.assets.size, 0)
  assert.equal(validateDocument(record.document), record.document)
  assert.equal(getNodes(content, "heading")[0].attrs.level, 1)
  assert.equal(getNodes(content, "orderedList")[0].attrs.start, 3)
  assert.equal(getNodes(content, "bulletList").length, 1)
  assert.equal(getNodes(content, "tableHeader")[1].content[0].attrs.textAlign, "right")
  assert.equal(getNodes(content, "codeBlock")[0].content[0].text, '  const message = "$原样"\n')
  assert.equal(getNodes(content, "inlineMath")[0].attrs.latex, "x^2")
  assert.equal(getNodes(content, "blockMath")[0].attrs.latex, "\\frac{a}{b}")
  assert.equal(warnings.length, 0)
  assert.match(preview, /标题/)
  const repeated = await readMarkdownDocument(source)
  assert.notEqual(record.document.id, repeated.record.document.id)
})

test("高阶标题、任务项、脚注及图片按约定保留内容并说明", async () => {
  const source = "###### 六级\n\n- [x] 完成\n- [ ] 待办\n\n正文[^a]\n\n[^a]: 脚注 **内容**\n\n"
    + "![替代说明][img]\n\n[img]: https://example.com/picture.png\n"
  const { record, warnings } = await readMarkdownDocument(source)
  const content = record.document.content
  const text = getText(content)
  assert.equal(getNodes(content, "heading")[0].attrs.level, 3)
  assert.match(text, /\[x\] 完成/)
  assert.match(text, /\[ \] 待办/)
  assert.match(text, /\[\^a\]/)
  assert.match(text, /脚注 内容/)
  assert.match(text, /替代说明.*https:\/\/example.com\/picture.png/)
  assert.equal(getNodes(content, "image").length, 0)
  assert.equal(warnings.length, 4)
})

test("引用链接先解引用，危险和相对地址作为文字，HTML 不执行", async () => {
  const source = "[安全][ID] [危险](javascript:alert%281%29) [相对](../file.md)\n\n"
    + '[id]: https://example.com/path "悬浮标题"\n\n<script>alert(1)</script>\n\n<img src=x onerror=bad()>\n'
  const { record, warnings } = await readMarkdownDocument(source)
  const content = record.document.content
  const links = getNodes(content, "text").flatMap(node => node.marks || []).filter(mark => mark.type === "link")
  assert.equal(links.length, 1)
  assert.equal(links[0].attrs.href, "https://example.com/path")
  assert.match(getText(content), /javascript:alert%281%29/)
  assert.match(getText(content), /\.\.\/file.md/)
  const html = generateHTML(content, createExtensions())
  const parsed = new DOMParser().parseFromString(html, "text/html")
  assert.equal(parsed.querySelectorAll("script, img, iframe").length, 0)
  assert.match(parsed.body.textContent, /<script>alert\(1\)<\/script>/)
  assert.ok(warnings.some(warning => warning.includes("HTML")))
})

test("代码附加参数与过长语言报告降级，源码中的公式和 HTML 保持原样", async () => {
  const source = "```" + "x".repeat(1001) + " title\n<script> $x$\t\n\n```\n"
  const { record, warnings } = await readMarkdownDocument(source)
  const code = getNodes(record.document.content, "codeBlock")[0]
  assert.equal(code.attrs.language, "plaintext")
  assert.equal(code.content[0].text, "<script> $x$\t\n")
  assert.equal(getNodes(record.document.content, "inlineMath").length, 0)
  assert.equal(warnings.length, 2)
})

test("重复链接定义取首条，空引用可载入，不齐表格补齐且保留多余列", async () => {
  const source = "[链接][x]\n\n[x]: https://first.example\n[x]: https://second.example\n\n> \n\n"
    + "| A | B |\n| --- | --- |\n| C |\n| D | E | F |\n"
  const { record, warnings } = await readMarkdownDocument(source)
  const content = record.document.content
  const link = getNodes(content, "text").flatMap(node => node.marks || []).find(mark => mark.type === "link")
  assert.equal(link.attrs.href, "https://first.example")
  assert.equal(getNodes(content, "blockquote")[0].content[0].type, "paragraph")
  assert.equal(getNodes(content, "tableRow").every(row => row.content.length === 3), true)
  assert.match(getText(content), /DEF/)
  assert.ok(warnings.some(warning => warning.includes("表格列数不齐")))
  validateDocument(record.document)
})

test("空或超长公式保留原始文字，公式总量越界则拒绝新建", async () => {
  const longFormula = "x".repeat(2001)
  const result = await readMarkdownDocument(`$$\n${longFormula}\n$$\n\n$$\n\n$$\n`)
  assert.equal(getNodes(result.record.document.content, "blockMath").length, 0)
  assert.ok(getText(result.record.document.content).includes(longFormula))
  assert.equal(result.warnings.length, 1)
  const manyFormulas = Array.from({ length: 51 }, () => `$$\n${"x".repeat(2000)}\n$$`).join("\n\n")
  await assert.rejects(readMarkdownDocument(manyFormulas), /公式源码总量/)
})

test("UTF-8 文件与源码边界拒绝截断、二进制、空内容及超限", async () => {
  const result = await readMarkdownSource(new File(["\ufeff# 标题\r\n"], "示例.MD"))
  assert.equal(result.title, "示例")
  assert.equal(result.source, "# 标题\r\n")
  await assert.rejects(readMarkdownSource(new File([new Uint8Array([0xff, 0xfe])], "bad.md")), /UTF-8/)
  await assert.rejects(readMarkdownSource(new File(["text"], "bad.json")), /请选择/)
  await assert.rejects(readMarkdownSource(new File([new Uint8Array(MAX_MARKDOWN_BYTES + 1)], "large.md")), /1 MiB/)
  await assert.rejects(readMarkdownDocument(" "), /请输入/)
  await assert.rejects(readMarkdownDocument("x\u0000y"), /空字符/)
  await assert.rejects(readMarkdownDocument("x".repeat(200001)), /200000/)
})

test("AST 深度、节点数与未知节点不被静默接受", () => {
  let nested = { type: "text", value: "text" }
  for (let index = 0; index < 50; index += 1) nested = { type: "blockquote", children: [nested] }
  assert.throws(() => createMarkdownContent({ type: "root", children: [nested] }), /结构过深/)
  assert.throws(() => createMarkdownContent({ type: "root", children: Array.from({ length: 50001 }, () => ({ type: "paragraph", children: [] })) }), /节点过多/)
  assert.throws(() => createMarkdownContent({ type: "root", children: [{ type: "unknown" }] }), /暂不支持/)
})

test("空链接和空图片地址不产生 undefined，零起点编号明确报告", async () => {
  const source = "[空地址]() ![空图片]() [引用][x]\n\n[x]: <>\n\n0. 起点\n"
  const { record, warnings } = await readMarkdownDocument(source)
  const text = getText(record.document.content)
  assert.match(text, /空地址（空地址）/)
  assert.match(text, /空图片.*空地址/)
  assert.match(text, /引用（空地址）/)
  assert.equal(text.includes("undefined"), false)
  assert.equal(getNodes(record.document.content, "orderedList")[0].attrs.start, 1)
  assert.ok(warnings.some(warning => warning.includes("从 0")))
})

test("导入导出 Markdown 保留公式、嵌套标记和代码，原快照不变", async () => {
  const source = "# 往返\n\n_a**b**c_，文字\\$与\\* [链接](https://example.com)\n\n"
    + '```js\nconst tick = "```"\n\n```\n\n$x^2$\n\n$$\n\\sqrt{x}\n$$\n'
  const { record } = await readMarkdownDocument(source)
  const snapshot = JSON.stringify(record.document)
  const exported = await createDocumentMarkdown(record.document)
  const restored = await readMarkdownDocument(exported.source)
  assert.deepEqual(restored.record.document.content, record.document.content)
  assert.equal(JSON.stringify(record.document), snapshot)
  assert.equal(exported.warnings.length, 0)
})
