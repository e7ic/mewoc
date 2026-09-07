import { createDocumentHtml } from "../src/pages/editor/tools/file-transfer.js"
import { renderFormula } from "../src/pages/editor/tools/formula.js"
import { getDocuments } from "../src/pages/editor/tools/local-repository.js"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function checkFormulaFlows(left, check) {
  const { editor } = left
  await check("公式节点显示原生 MathML，编辑源码后视图同步", async () => {
    editor.commands.setContent({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "行内" }, { type: "inlineMath", attrs: { latex: "x^2" } }] },
      { type: "blockMath", attrs: { latex: "\\frac{a}{b}" } }
    ] })
    await renderFormula("x")
    const maths = [...editor.view.dom.querySelectorAll("math")]
    assert(maths.length === 2 && maths.every(math => math.getBoundingClientRect().height > 0), "公式未显示")
    editor.view.dispatch(editor.state.tr.setNodeMarkup(5, undefined, { latex: "\\sqrt{x}" }))
    await renderFormula("x")
    assert(editor.view.dom.querySelector('[data-type="block-math"] annotation').textContent === "\\sqrt{x}", "视图未同步")
  })
  await check("公式进入 HTML / 打印共用输出，不依赖脚本、外链字体或样式", async () => {
    const html = await createDocumentHtml(left.getSnapshot(), new Map())
    const output = new DOMParser().parseFromString(html, "text/html")
    assert(output.querySelectorAll("article math").length === 2, "输出丢失公式")
    assert(output.querySelectorAll("script, link, img").length === 0, "公式输出存在外部依赖")
    assert(output.querySelector('[data-type="block-math"]').getAttribute("data-latex") === "\\sqrt{x}", "源码未保留")
    assert(output.head.textContent.includes("break-inside"), "未包含打印规则")
  })
  await check("公式随正文保存 IndexedDB，重新读取保留源码", async () => {
    assert(await left.saveDocument(), "保存失败")
    const record = (await getDocuments()).find(item => item.id === left.getSnapshot().id)
    assert(record.document.content.content[1].attrs.latex === "\\sqrt{x}", "已存公式内容错误")
  })
}
