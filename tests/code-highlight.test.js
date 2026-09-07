import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor, Extension } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { Fragment, Slice } from "@tiptap/pm/model"
import { DocumentCodeBlock } from "../src/pages/editor/extensions/code-block.js"
import { createCodeHighlightPlugin, CodeHighlightKey } from "../src/pages/editor/extensions/code-highlight.js"
import { highlightCode, renderCodeHtml, MAX_CODE_HIGHLIGHT_LENGTH } from "../src/pages/editor/tools/code-highlight.js"
import { getCodeLanguage } from "../src/pages/editor/constants/code-languages.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const code = (text, language = "javascript") => ({
  type: "codeBlock", attrs: { language }, content: text ? [{ type: "text", text }] : []
})
const createEditor = (content, highlight) => new Editor({
  element: document.createElement("div"), content,
  extensions: highlight ? [StarterKit.configure({ trailingNode: false }), Extension.create({
    name: "testCodeHighlight", addProseMirrorPlugins: () => [createCodeHighlightPlugin(highlight)]
  })] : [StarterKit.configure({ codeBlock: false, trailingNode: false }), DocumentCodeBlock]
})
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const waitFor = async condition => {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("等待高亮结果超时")
    await delay(10)
  }
}
const paste = (editor, text, metadata = "") => editor.state.plugins.find(plugin => plugin.key.startsWith("documentCodePaste$")).props.handlePaste(editor.view, {
  clipboardData: { getData: type => ({ "text/plain": text, "vscode-editor-data": metadata })[type] || "" }
})
const getDeferredHighlight = requests => text => new Promise(resolve => { requests.push({ text, resolve }) })
const pasteThroughPlugins = (editor, text, metadata = "") => {
  const paragraph = editor.schema.nodes.paragraph.create(null, editor.schema.text(text))
  const slice = new Slice(Fragment.from(paragraph), 0, 0)
  const event = { clipboardData: { getData: type => ({ "text/plain": text, "vscode-editor-data": metadata })[type] || "" } }
  return !!editor.view.someProp("handlePaste", handler => handler(editor.view, event, slice))
}

test("六种语法的高亮片段完整还原源码，别名使用对应语法", async () => {
  const samples = [
    ["javascript", "const message = `你好`;\nconsole.log(message)\n"],
    ["html", "<section title=\"你好\">&amp;<br></section>\n"],
    ["css", ".card { color: #fff; margin: 0 2px; }\n"],
    ["json", "{\n  \"message\": \"你好\", \"count\": 2\n}\n"],
    ["bash", "#!/bin/bash\necho \"$HOME\"\n"],
    ["python", "def greet(name):\n\treturn f\"你好 {name}\"\n"]
  ]
  for (const [language, source] of samples) {
    const tokens = await highlightCode(source, language)
    assert.equal(tokens.map(token => token.text).join(""), source)
    assert.equal(tokens.some(token => token.classes.length), true)
    assert.equal(tokens.every(token => token.classes.every(value => /^[a-zA-Z0-9_-]+$/.test(value))), true)
  }
  assert.deepEqual(await highlightCode(samples[0][1], "js"), await highlightCode(samples[0][1], "javascript"))
  assert.equal(getCodeLanguage("XML"), "html")
})

test("未知语言、空源码与单块超预算回退纯文本并保留全部字符", async () => {
  const source = "\t<unknown>&\n  原始代码\n"
  for (const language of [null, "ruby", "constructor", "__proto__", "toString", "plaintext"]) {
    assert.equal(getCodeLanguage(language), "plaintext")
    assert.deepEqual(await highlightCode(source, language), [{ text: source, classes: [] }])
  }
  assert.deepEqual(await highlightCode("", "javascript"), [{ text: "", classes: [] }])
  const longSource = "x".repeat(MAX_CODE_HIGHLIGHT_LENGTH + 1)
  assert.deepEqual(await highlightCode(longSource, "javascript"), [{ text: longSource, classes: [] }])
})

test("HTML 高亮安全转义并保留语言与空白，内部粘贴恢复原始文档", async () => {
  const source = "  </code></pre><script>alert(1)</script><img src=x onerror=bad()>\n\t& \" ' </style>\n"
  const editor = createEditor({ type: "doc", content: [code(source, "html"), code("未知源码\n", "ruby")] })
  let pasted
  try {
    const html = await renderCodeHtml(editor.getHTML())
    const parsed = new DOMParser().parseFromString(html, "text/html")
    assert.equal(parsed.querySelector("code").textContent, source)
    assert.equal(parsed.querySelectorAll("script, img, style, link").length, 0)
    assert.ok(parsed.querySelector("code span"))
    assert.equal(parsed.querySelectorAll("pre")[1].getAttribute("data-code-language"), "ruby")
    assert.equal(parsed.querySelectorAll("code")[1].textContent, "未知源码\n")
    pasted = createEditor(cleanPastedHtml(html))
    assert.deepEqual(pasted.getJSON(), editor.getJSON())
  } finally {
    editor.destroy()
    pasted?.destroy()
  }
})

test("HTML 文档总高亮预算只限制显示，后续代码块源码保持", async () => {
  const source = "//" + "a".repeat(MAX_CODE_HIGHLIGHT_LENGTH - 2)
  const editor = createEditor({ type: "doc", content: Array.from({ length: 6 }, () => code(source)) })
  try {
    const parsed = new DOMParser().parseFromString(await renderCodeHtml(editor.getHTML()), "text/html")
    const blocks = [...parsed.querySelectorAll("pre code")]
    assert.equal(blocks.length, 6)
    assert.equal(blocks.every(block => block.textContent === source), true)
    assert.equal(blocks.slice(0, 5).every(block => !!block.querySelector("span")), true)
    assert.equal(blocks[5].querySelector("span"), null)
  } finally {
    editor.destroy()
  }
})

test("异步高亮只接收最新文档结果，不产生内容更新或撤销步骤", async () => {
  const requests = []
  const editor = createEditor({ type: "doc", content: [code("old")] }, getDeferredHighlight(requests))
  let updates = 0
  editor.on("update", () => { updates += 1 })
  try {
    await waitFor(() => requests.length === 1)
    editor.commands.setTextSelection(4)
    editor.commands.insertContent("new")
    await waitFor(() => requests.length === 2)
    requests[0].resolve([{ text: "old", classes: ["stale"] }])
    await delay(20)
    assert.equal(CodeHighlightKey.getState(editor.state).decorations.find().length, 0)
    requests[1].resolve([{ text: "oldnew", classes: ["current"] }])
    await waitFor(() => CodeHighlightKey.getState(editor.state).decorations.find().length === 1)
    assert.equal(CodeHighlightKey.getState(editor.state).decorations.find()[0].type.attrs.class, "current")
    assert.equal(updates, 1)
    assert.equal(editor.state.doc.firstChild.textContent, "oldnew")
    editor.commands.undo()
    assert.equal(editor.state.doc.firstChild.textContent, "old")
    assert.equal(editor.can().undo(), false)
  } finally {
    editor.destroy()
    requests.forEach(request => request.resolve([]))
  }
})

test("销毁后返回的异步高亮不会分发事务或修改 DOM", async () => {
  const requests = []
  const editor = createEditor({ type: "doc", content: [code("const value = 1")] }, getDeferredHighlight(requests))
  let transactions = 0
  editor.on("transaction", () => { transactions += 1 })
  try {
    await waitFor(() => requests.length === 1)
    const element = editor.view.dom
    editor.destroy()
    const html = element.innerHTML
    const count = transactions
    requests[0].resolve([{ text: "const value = 1", classes: ["late"] }])
    await delay(20)
    assert.equal(transactions, count)
    assert.equal(element.innerHTML, html)
  } finally {
    if (!editor.isDestroyed) editor.destroy()
    requests.forEach(request => request.resolve([]))
  }
})

test("只读仍能显示高亮，超预算或渲染失败保留源码并给出状态", async () => {
  const source = "a".repeat(MAX_CODE_HIGHLIGHT_LENGTH)
  const calls = []
  const content = { type: "doc", content: [code("unknown", "ruby"), code(source + "x"),
    ...Array.from({ length: 6 }, () => code(source))] }
  const editor = createEditor(content, async text => {
    calls.push(text)
    return [{ text, classes: ["token"] }]
  })
  const original = editor.getJSON()
  const failed = createEditor({ type: "doc", content: [code("source")] }, async () => { throw new Error("加载失败") })
  let updates = 0
  editor.on("update", () => { updates += 1 })
  editor.setEditable(false, false)
  try {
    await waitFor(() => CodeHighlightKey.getState(editor.state).decorations.find().length === 5)
    assert.equal(calls.length, 5)
    assert.equal(Object.keys(CodeHighlightKey.getState(editor.state).messages).length, 2)
    assert.deepEqual(editor.getJSON(), original)
    assert.equal(updates, 0)
    await waitFor(() => !!CodeHighlightKey.getState(failed.state).messages[0])
    assert.match(CodeHighlightKey.getState(failed.state).messages[0], /源码已保留/)
    assert.equal(failed.state.doc.firstChild.textContent, "source")
    assert.equal(failed.can().undo(), false)
  } finally {
    editor.destroy()
    failed.destroy()
  }
})

test("组合输入期间延后高亮，结束事件后恢复", async () => {
  let calls = 0
  const editor = createEditor({ type: "doc", content: [code("value")] }, async text => {
    calls += 1
    return [{ text, classes: ["token"] }]
  })
  try {
    editor.view.input.composing = true
    await delay(200)
    assert.equal(calls, 0)
    editor.view.input.composing = false
    editor.view.dom.dispatchEvent(new DOM.window.Event("compositionend"))
    await waitFor(() => calls === 1)
    await waitFor(() => CodeHighlightKey.getState(editor.state).decorations.find().length === 1)
  } finally {
    editor.view.input.composing = false
    editor.destroy()
  }
})

test("VS Code 畸形元数据不抛错，合法粘贴保留源码、语言及独立撤销", () => {
  const editor = createEditor("<p>前后</p>")
  try {
    const original = editor.getJSON()
    for (const metadata of ["{", "null", "42", "[]", '{"mode":null}', '{"mode":[]}', JSON.stringify({ mode: "a".repeat(1001) })]) {
      assert.equal(paste(editor, "source", metadata), false)
      assert.deepEqual(editor.getJSON(), original)
    }
    editor.commands.setTextSelection(2)
    assert.equal(paste(editor, "  const a = 1\r\n\tvalue\r", '{"mode":"js"}'), true)
    const blocks = editor.getJSON().content
    const pasted = blocks.find(node => node.type === "codeBlock")
    assert.equal(pasted.attrs.language, "js")
    assert.equal(pasted.content[0].text, "  const a = 1\n\tvalue\n")
    assert.equal(blocks[0].content[0].text, "前")
    assert.equal(blocks[2].content[0].text, "后")
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), original)
  } finally {
    editor.destroy()
  }
})

test("块内粘贴保持纯文本，只读及组合输入拒绝粘贴写入", () => {
  const editor = createEditor({ type: "doc", content: [code("value")] })
  try {
    editor.commands.setTextSelection({ from: 1, to: 6 })
    assert.equal(paste(editor, "<b>raw</b>\r\n  x", "{"), true)
    assert.equal(editor.state.doc.firstChild.textContent, "<b>raw</b>\n  x")
    assert.equal(editor.state.doc.firstChild.attrs.language, "javascript")
    const content = editor.getJSON()
    editor.setEditable(false)
    assert.equal(paste(editor, "bad", '{"mode":"python"}'), false)
    editor.setEditable(true)
    editor.view.input.composing = true
    assert.equal(paste(editor, "bad", '{"mode":"python"}'), false)
    assert.deepEqual(editor.getJSON(), content)
  } finally {
    editor.view.input.composing = false
    editor.destroy()
  }
})

test("完整粘贴链优先处理 VS Code URL 源码，普通 URL 仍给选中文字加链接", () => {
  const editor = createEditor("<p>replace</p>")
  const source = "https://example.com"
  try {
    const original = editor.getJSON()
    editor.commands.setTextSelection({ from: 1, to: 8 })
    assert.equal(pasteThroughPlugins(editor, source, '{"mode":"javascript"}'), true)
    const pasted = editor.getJSON().content.find(node => node.type === "codeBlock")
    assert.ok(pasted)
    assert.equal(pasted.attrs.language, "javascript")
    assert.equal(pasted.content[0].text, source)
    assert.equal(editor.state.doc.textContent, source)
    editor.commands.undo()
    assert.deepEqual(editor.getJSON(), original)
    editor.commands.setTextSelection({ from: 1, to: 8 })
    assert.equal(pasteThroughPlugins(editor, source), true)
    const paragraph = editor.getJSON().content[0]
    assert.equal(paragraph.type, "paragraph")
    assert.equal(paragraph.content[0].text, "replace")
    assert.equal(paragraph.content[0].marks[0].attrs.href, source)
  } finally {
    editor.destroy()
  }
})

test("代码粘贴优先级不改变 schema 自动填充的默认正文节点", () => {
  const editor = createEditor("<p></p>")
  try {
    assert.equal(editor.schema.topNodeType.createAndFill().firstChild.type.name, "paragraph")
    assert.equal(editor.schema.nodes.blockquote.createAndFill().firstChild.type.name, "paragraph")
  } finally {
    editor.destroy()
  }
})
