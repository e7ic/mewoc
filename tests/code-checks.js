import { createDocumentHtml } from "../src/pages/editor/tools/file-transfer.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { getDocuments } from "../src/pages/editor/tools/local-repository.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { setCodeBlockLanguage } from "../src/pages/editor/tools/code-block-commands.js"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForHighlight(editor) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (editor.view.dom.querySelector("pre .hljs-keyword")) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error("代码高亮未就绪")
}

export async function checkCodeFlows(left, check) {
  const { editor } = left
  const source = 'const text = "<script>示例</script>"\n\n  console.log(text)\n'
  await check("代码块异步高亮保留源码，实际样式可见且不写入文件模型", async () => {
    editor.commands.setContent({ type: "doc", content: [
      { type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: source }] }
    ] })
    await waitForHighlight(editor)
    const code = editor.view.dom.querySelector("pre code")
    assert(code.textContent === source, "高亮改变了源码")
    assert(getComputedStyle(code.querySelector(".hljs-keyword")).color !== getComputedStyle(code).color, "高亮样式未生效")
    assert(!JSON.stringify(left.getSnapshot().content).includes("hljs"), "显示装饰写入正文")
  })
  await check("代码 Tab / Shift+Tab / Enter 与退出快捷键接通，换行可撤销", () => {
    editor.commands.setTextSelection(1)
    assert(pressCodeKey(editor, "Tab"), "Tab 未处理")
    assert(editor.state.doc.firstChild.textContent === `  ${source}`, "缩进错误")
    assert(pressCodeKey(editor, "Tab", { shiftKey: true }), "Shift+Tab 未处理")
    assert(editor.state.doc.firstChild.textContent === source, "反缩进未恢复")
    pressCodeKey(editor, "Enter")
    assert(editor.state.doc.firstChild.textContent === `\n${source}`, "换行错误")
    editor.commands.undo()
    assert(editor.state.doc.firstChild.textContent === source, "撤销未恢复源码")
    const modifier = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
    assert(pressCodeKey(editor, "Enter", modifier), "退出快捷键未处理")
    assert(editor.state.selection.$from.parent.type.name === "paragraph", "未退出代码块")
  })
  await check("代码 HTML / 打印输出内嵌高亮且源码安全，内部复制保留语言和空白", async () => {
    const html = await createDocumentHtml(left.getSnapshot(), new Map())
    const output = new DOMParser().parseFromString(html, "text/html")
    const code = output.querySelector("article pre code")
    assert(code.textContent === source && code.querySelector(".hljs-keyword"), "输出丢失源码或高亮")
    assert(!output.querySelector("script, link"), "输出含脚本或外链")
    assert(output.head.textContent.includes("pre-wrap"), "缺少打印折行规则")
    editor.commands.setContent(cleanPastedHtml(output.querySelector("article").innerHTML))
    assert(editor.state.doc.firstChild.attrs.language === "javascript", "复制丢失语言")
    assert(editor.state.doc.firstChild.textContent === source, "复制丢失空白或换行")
  })
  await check("代码与语言随 JSON 文件和 IndexedDB 保存，重新读取保持完整", async () => {
    const portable = await createPortableFile(left.getSnapshot(), new Map())
    const restored = await readPortableFile(new File([JSON.stringify(portable)], "code.mewoc.json"))
    assert(restored.document.content.content[0].attrs.language === "javascript", "文件语言丢失")
    assert(restored.document.content.content[0].content[0].text === source, "文件源码丢失")
    assert(await left.saveDocument(), "保存失败")
    const record = (await getDocuments()).find(item => item.id === left.getSnapshot().id)
    assert(record.document.content.content[0].content[0].text === source, "已存源码错误")
  })
  await check("切换代码语言清除装饰，只读期间代码快捷键和语言命令不写入", async () => {
    editor.commands.setTextSelection(1)
    assert(setCodeBlockLanguage(editor, "plaintext"), "语言切换失败")
    await new Promise(resolve => setTimeout(resolve, 200))
    assert(!editor.view.dom.querySelector("pre .hljs-keyword"), "纯文本仍带高亮")
    editor.setEditable(false, false)
    const previous = JSON.stringify(editor.getJSON())
    assert(!pressCodeKey(editor, "Tab") && !setCodeBlockLanguage(editor, "python"), "只读仍处理代码修改")
    assert(JSON.stringify(editor.getJSON()) === previous, "只读源码改变")
    editor.setEditable(true, false)
  })
}

function pressCodeKey(editor, key, options = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })
  return editor.view.someProp("handleKeyDown", handler => handler(editor.view, event))
}
