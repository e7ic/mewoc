import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { applyFormula, removeFormula } from "../src/pages/editor/tools/formula-commands.js"
import { renderFormula, renderFormulaHtml } from "../src/pages/editor/tools/formula.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const createEditor = (content = "<p>前后</p>") => new Editor({
  element: document.createElement("div"), extensions: createExtensions(), content
})
const formula = (latex = "x^2", type = "inlineMath") => ({ type, attrs: { latex } })
const selectFormula = (editor, position) => {
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)))
  return editor.state.selection
}

test("行内插入保留两侧文字，编辑、删除各自撤销，无变化不产生更新", () => {
  const editor = createEditor()
  try {
    editor.commands.setTextSelection(2)
    assert.equal(applyFormula(editor, editor.state.selection, { type: "inlineMath", latex: "x^2" }), true)
    assert.equal(editor.getText(), "前$x^2$后")
    const original = { type: "inlineMath", latex: "x^2" }
    selectFormula(editor, 2)
    let updates = 0
    editor.on("update", () => { updates += 1 })
    assert.equal(applyFormula(editor, editor.state.selection, original, original), true)
    assert.equal(updates, 0)
    assert.equal(applyFormula(editor, editor.state.selection, { ...original, latex: "y" }, original), true)
    editor.commands.undo()
    assert.equal(editor.getText(), "前$x^2$后")
    editor.commands.redo()
    selectFormula(editor, 2)
    assert.equal(removeFormula(editor, editor.state.selection, { ...original, latex: "y" }), true)
    assert.equal(editor.getText(), "前后")
    editor.commands.undo()
    assert.equal(editor.getText(), "前$y$后")
  } finally {
    editor.destroy()
  }
})

test("独立公式在段中插入分开两侧段落，后续输入单独撤销", () => {
  const editor = createEditor()
  try {
    editor.commands.setTextSelection(2)
    applyFormula(editor, editor.state.selection, { type: "blockMath", latex: "x" })
    assert.deepEqual(editor.getJSON().content.map(node => node.type), ["paragraph", "blockMath", "paragraph"])
    assert.equal(editor.getJSON().content[0].content[0].text, "前")
    assert.equal(editor.getJSON().content[2].content[0].text, "后")
    editor.commands.insertContent("新")
    editor.commands.undo()
    assert.equal(editor.getJSON().content[1].type, "blockMath")
    editor.commands.undo()
    assert.equal(editor.getText(), "前后")
  } finally {
    editor.destroy()
  }
})

test("只读、组合输入、代码块、过期选区和原公式不匹配均拒绝写入", () => {
  const editor = createEditor()
  const values = { type: "inlineMath", latex: "x" }
  try {
    const stale = editor.state.selection
    editor.commands.insertContent("新")
    assert.equal(applyFormula(editor, stale, values), false)
    editor.setEditable(false)
    assert.equal(applyFormula(editor, editor.state.selection, values), false)
    editor.setEditable(true)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionstart", { bubbles: true }))
    assert.equal(applyFormula(editor, editor.state.selection, values), false)
    editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionend", { bubbles: true }))
    editor.commands.setContent("<pre><code>代码</code></pre>")
    assert.equal(applyFormula(editor, editor.state.selection, values), false)
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [formula()] }] })
    selectFormula(editor, 1)
    assert.equal(applyFormula(editor, editor.state.selection, values, { ...values, latex: "旧" }), false)
    assert.equal(removeFormula(editor, editor.state.selection, values), false)
  } finally {
    editor.destroy()
  }
  assert.equal(applyFormula(editor, null, values), false)
})

test("MathML 支持分数矩阵，拒绝非法语法、外部资源、HTML 与宏循环", async () => {
  for (const latex of ["\\frac{a}{b}", "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}"]) {
    const html = await renderFormula(latex, true)
    assert.match(html, /<math/)
    assert.match(html, /display="block"/)
    assert.doesNotMatch(html, /<script|<img|href=/)
  }
  for (const latex of ["\\frac{", "\\href{https://example.com}{x}", "\\includegraphics{https://example.com/a.png}",
    "\\htmlClass{bad}{x}", "\\def\\x{\\x}\\x", " ", "x".repeat(2001)]) {
    await assert.rejects(renderFormula(latex))
  }
  await renderFormula("\\gdef\\localmacro{x}\\localmacro")
  await assert.rejects(renderFormula("\\localmacro"))
})

test("文件保存还原公式源码，schema 拒绝缺失、非法与超预算属性", async () => {
  const record = { ...createDocument(), content: { type: "doc", content: [formula("\\badsyntax", "blockMath")] } }
  const portable = await createPortableFile(record, new Map())
  const imported = await readPortableFile(new File([JSON.stringify(portable)], "formula.mewoc.json"))
  assert.deepEqual(imported.document.content, record.content)
  for (const latex of [null, undefined, "", " ", 1, "x".repeat(2001)]) {
    assert.throws(() => validateDocument({ ...record, content: { type: "doc", content: [{ type: "blockMath", attrs: { latex } }] } }))
  }
  assert.throws(() => validateDocument({ ...record, content: { type: "doc", content: [{ type: "blockMath" }] } }))
  assert.throws(() => validateDocument({ ...record, content: { type: "doc", content: [
    { type: "blockMath", attrs: { latex: "x", html: "bad" } }
  ] } }), /未知属性/)
  assert.throws(() => validateDocument({ ...record, content: { type: "doc", content: Array.from({ length: 51 }, () => formula("x".repeat(2000), "blockMath")) } }), /总量/)
})

test("预渲染 HTML 无外链依赖，内部粘贴仅恢复源码，错误源码保留且转义", async () => {
  const editor = createEditor({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "前" }, formula(), { type: "text", text: "后" }] },
    formula("\\frac{a}{b}", "blockMath")
  ] })
  let pasted
  try {
    const html = await renderFormulaHtml(editor.getHTML())
    assert.match(html, /<math/)
    assert.doesNotMatch(html, /<script|<link|<img/)
    pasted = createEditor(cleanPastedHtml(html))
    assert.deepEqual(pasted.getJSON(), editor.getJSON())
    editor.commands.setContent({ type: "doc", content: [formula("\\bad </style><script>bad()</script>", "blockMath")] })
    const failed = new DOMParser().parseFromString(await renderFormulaHtml(editor.getHTML()), "text/html")
    assert.equal(failed.querySelectorAll("script").length, 0)
    assert.equal(failed.querySelector("[data-formula-error]").getAttribute("data-latex"), "\\bad </style><script>bad()</script>")
    assert.match(failed.body.textContent, /公式未能渲染/)
  } finally {
    editor.destroy()
    pasted?.destroy()
  }
})

test("节点异步渲染只保留最新源码，销毁后不再改 DOM", async () => {
  const editor = createEditor({ type: "doc", content: [formula("x", "blockMath")] })
  const dom = editor.view.dom.querySelector('[data-type="block-math"]')
  editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { latex: "y" }))
  await renderFormula("z")
  assert.equal(dom.querySelector("annotation").textContent, "y")
  editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { latex: "z" }))
  editor.destroy()
  const html = dom.innerHTML
  await renderFormula("z")
  assert.equal(dom.innerHTML, html)
})

test("格式刷跨公式应用只修改文字，公式源码与原子结构保持", () => {
  const editor = createEditor({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "源", marks: [{ type: "bold" }] }] },
    { type: "paragraph", content: [{ type: "text", text: "前" }, formula(), { type: "text", text: "后" }] }
  ] })
  try {
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 4, to: 7 })
    editor.commands.applyFormat()
    const nodes = editor.getJSON().content[1].content
    assert.equal(nodes[0].marks[0].type, "bold")
    assert.equal(nodes[1].type, "inlineMath")
    assert.equal(nodes[1].attrs.latex, "x^2")
    assert.equal(nodes[1].marks, undefined)
    assert.equal(nodes[2].marks[0].type, "bold")
  } finally {
    editor.destroy()
  }
})
