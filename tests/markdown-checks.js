import { readMarkdownSource, readMarkdownDocument, createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentHtml } from "../src/pages/editor/tools/file-transfer.js"
import { getDocuments } from "../src/pages/editor/tools/local-repository.js"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function checkMarkdownFlows(left, check) {
  const source = "# Markdown 验收\n\n**加粗** 与 $x^2$\n\n"
    + "| 项目 | 内容 |\n| --- | --- |\n| A | B |\n\n```js\nconst value = 1\n```\n"
  await check("Markdown UTF-8 文件转换为既有模型，代码、公式和表格进入编辑器", async () => {
    const input = await readMarkdownSource(new File([source], "Markdown 验收.md"))
    const result = await readMarkdownDocument(input.source, input.title)
    left.editor.commands.setContent(result.record.document.content)
    assert(left.editor.view.dom.querySelector("table th").textContent === "项目", "表头丢失")
    assert(left.editor.view.dom.querySelector("pre").getAttribute("data-code-language") === "js", "代码语言丢失")
    assert(left.editor.getJSON().content.some(node => node.content?.some(child => child.type === "inlineMath")), "公式丢失")
    assert(result.warnings.length === 0, "支持的结构产生多余说明")
  })
  await check("Markdown 导出与重新导入保留正文，HTML 共用输出包含表格和公式", async () => {
    const snapshot = left.getSnapshot()
    const result = await createDocumentMarkdown(snapshot)
    const restored = await readMarkdownDocument(result.source)
    const html = await createDocumentHtml(restored.record.document, new Map())
    const output = new DOMParser().parseFromString(html, "text/html")
    assert(output.querySelector("h1").textContent === "Markdown 验收", "标题丢失")
    assert(output.querySelectorAll("table tr").length === 2, "表格丢失")
    assert(output.querySelector("math"), "公式未进入输出")
    assert(output.querySelector("pre code").textContent === "const value = 1", "代码内容丢失")
  })
  await check("Markdown 转换后的正文可保存并从 IndexedDB 重新读取", async () => {
    assert(await left.saveDocument(), "保存失败")
    const record = (await getDocuments()).find(item => item.id === left.getSnapshot().id)
    assert(record.document.content.content[0].content[0].text === "Markdown 验收", "保存内容错误")
    assert(record.document.content.content.some(node => node.type === "table"), "已存文档缺少表格")
  })
  await check("Markdown 带格式换行与连续空行往返保留正文，不显示语法标记", async () => {
    left.editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "第一行\n\n第二行", marks: [{ type: "bold" }] },
      { type: "hardBreak", marks: [{ type: "strike" }] },
      { type: "text", text: "末行", marks: [{ type: "strike" }] }
    ] }] })
    const result = await createDocumentMarkdown(left.getSnapshot())
    const restored = await readMarkdownDocument(result.source)
    left.editor.commands.setContent(restored.record.document.content)
    assert(left.editor.view.dom.querySelectorAll("br").length === 3, "连续换行丢失")
    assert(left.editor.getText() === "第一行\n\n第二行\n末行", "换行或文字内容改变")
    assert(left.editor.view.dom.querySelector("strong").textContent === "第一行", "粗体丢失")
    assert(left.editor.view.dom.querySelector("s").textContent === "末行", "删除线丢失")
    assert(result.warnings.length > 0, "换行转换缺少说明")
  })
  await check("Markdown 外链图片和 HTML 源码仅成为文字，不产生可加载元素", async () => {
    const result = await readMarkdownDocument("![外链](https://example.com/image.png)\n\n<script>alert(1)</script>\n")
    left.editor.commands.setContent(result.record.document.content)
    assert(!left.editor.view.dom.querySelector("img, script, iframe"), "产生了外部资源或脚本")
    assert(left.editor.getText().includes("https://example.com/image.png"), "图片地址未保留")
    assert(left.editor.getText().includes("<script>"), "HTML 源码未保留")
    assert(result.warnings.length === 2, "缺少转换说明")
  })
}
