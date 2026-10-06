/**
 * Markdown 导入语义与输入边界回归：通过正式入口检查块/标记、资源降级、引用定义和 Schema。
 * 不支持内容保留为说明/源码，非法或超限结构拒绝；最后验证 Markdown 导入导出的内容往返。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { generateHTML } from "@tiptap/core"
import { readMarkdownSource, readMarkdownDocument, createDocumentMarkdown, MAX_MARKDOWN_BYTES } from "../src/pages/editor/tools/markdown-file.js"
import { createMarkdownContent } from "../src/pages/editor/tools/markdown-import.js"
import { validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"

// 渲染 HTML 的安全检查使用实际扩展和临时 DOM，确保普通源码没有变成可执行标签。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}

// 按 JSON 类型递归查找语义结构；getText 仅用于检查降级内容文字完整性。
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

// 同一源文档覆盖多种块和行内结构，检查 Schema 合法、资源为空及重复导入的新身份。
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

// 任务列表保留真实勾选语义；脚注和远程图片继续明确降级，不能生成假的 image 节点。
test("六级标题和任务状态保留，脚注及图片按约定保留内容并说明", async () => {
  const source = "###### 六级\n\n- [x] 完成\n- [ ] 待办\n\n正文[^a]\n\n[^a]: 脚注 **内容**\n\n"
    + "![替代说明][img]\n\n[img]: https://example.com/picture.png\n"
  const { record, warnings } = await readMarkdownDocument(source)
  const content = record.document.content
  const text = getText(content)
  assert.equal(getNodes(content, "heading")[0].attrs.level, 6)
  assert.deepEqual(getNodes(content, "taskItem").map(item => item.attrs.checked), [true, false])
  assert.deepEqual(getNodes(content, "taskItem").map(getText), ["完成", "待办"])
  assert.match(text, /\[\^a\]/)
  assert.match(text, /脚注 内容/)
  assert.match(text, /替代说明.*https:\/\/example.com\/picture.png/)
  assert.equal(getNodes(content, "image").length, 0)
  assert.equal(warnings.length, 2)
})

// 定义在引用之后且大小写不同仍能解析；真正 HTML 渲染只应出现转义后的源码文字。
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

// 围栏内部的 HTML 与美元符号都是源码，不能被二次解析成脚本或公式，语言降级也不能改正文。
test("代码附加参数与过长语言报告降级，源码中的公式和 HTML 保持原样", async () => {
  const source = "```" + "x".repeat(1001) + " title\n<script> $x$\t\n\n```\n"
  const { record, warnings } = await readMarkdownDocument(source)
  const code = getNodes(record.document.content, "codeBlock")[0]
  assert.equal(code.attrs.language, "plaintext")
  assert.equal(code.content[0].text, "<script> $x$\t\n")
  assert.equal(getNodes(record.document.content, "inlineMath").length, 0)
  assert.equal(warnings.length, 2)
})

// 首个定义优先，空引用仍满足 Schema，不齐表格按最大列补齐同时保留超出首行的内容。
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

// 单式不适合作节点时保留完整源码，但总公式预算超限属于文档拒绝，两种边界分别断言。
test("空或超长公式保留原始文字，公式总量越界则拒绝新建", async () => {
  const longFormula = "x".repeat(2001)
  const result = await readMarkdownDocument(`$$\n${longFormula}\n$$\n\n$$\n\n$$\n`)
  assert.equal(getNodes(result.record.document.content, "blockMath").length, 0)
  assert.ok(getText(result.record.document.content).includes(longFormula))
  assert.equal(result.warnings.length, 1)
  const manyFormulas = Array.from({ length: 51 }, () => `$$\n${"x".repeat(2000)}\n$$`).join("\n\n")
  await assert.rejects(readMarkdownDocument(manyFormulas), /公式源码总量/)
})

// 字节与字符各自限额，错误编码不能用替换字符勉强成功；BOM/CRLF 的合法输入仍可读取。
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

// 绕过文本解析直接输入受控 AST，以单独证明深度、数量及未知类型检查不依赖 remark 的正常输出。
test("AST 深度、节点数与未知节点不被静默接受", () => {
  let nested = { type: "text", value: "text" }
  for (let index = 0; index < 50; index += 1) nested = { type: "blockquote", children: [nested] }
  assert.throws(() => createMarkdownContent({ type: "root", children: [nested] }), /结构过深/)
  assert.throws(() => createMarkdownContent({ type: "root", children: Array.from({ length: 50001 }, () => ({ type: "paragraph", children: [] })) }), /节点过多/)
  assert.throws(() => createMarkdownContent({ type: "root", children: [{ type: "unknown" }] }), /暂不支持/)
})

// 缺地址也要保留说明，不能把缺失值串成 undefined；零列表起点需明确折算并提示。
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

// 用正式双向入口逐节点比较规范化内容，检查嵌套标记、字面语法和多行代码没有互相污染。
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
