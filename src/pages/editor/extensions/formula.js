import { Node } from "@tiptap/core"
import { getFormulaSourceError, renderFormula } from "../tools/formula.js"

function createFormulaView(node) {
  const type = node.type.name
  const displayMode = type === "blockMath"
  const dom = document.createElement(displayMode ? "div" : "span")
  dom.setAttribute("data-type", displayMode ? "block-math" : "inline-math")
  dom.contentEditable = "false"
  let version = 0
  const updateFormula = current => {
    const request = ++version
    const latex = current.attrs.latex
    dom.setAttribute("data-latex", latex)
    dom.setAttribute("aria-label", `公式：${latex}`)
    dom.removeAttribute("data-formula-error")
    dom.textContent = latex
    renderFormula(latex, displayMode).then(html => {
      if (request !== version) return
      dom.innerHTML = html
      dom.title = "选中后在「插入 → 编辑公式」中修改"
    }).catch(error => {
      if (request !== version) return
      dom.textContent = latex
      dom.title = `公式未能渲染：${error.message}`
      dom.setAttribute("data-formula-error", "true")
    })
  }
  updateFormula(node)
  return {
    dom,
    update: current => {
      if (current.type.name !== type) return false
      if (current.attrs.latex !== dom.getAttribute("data-latex")) updateFormula(current)
      return true
    },
    ignoreMutation: mutation => mutation.type !== "selection",
    destroy: () => { version += 1 }
  }
}

function createFormulaNode(name, inline) {
  const tag = inline ? "span" : "div"
  const type = inline ? "inline-math" : "block-math"
  return Node.create({
    name,
    group: inline ? "inline" : "block",
    inline,
    atom: true,
    selectable: true,
    marks: "",
    addAttributes: () => ({ latex: { default: "", rendered: false } }),
    parseHTML: () => [{
      tag: `${tag}[data-type="${type}"]`,
      getAttrs: element => {
        const latex = element.getAttribute("data-latex")
        return getFormulaSourceError(latex) ? false : { latex }
      }
    }],
    renderHTML: ({ node }) => [tag, { "data-type": type, "data-latex": node.attrs.latex }, node.attrs.latex],
    renderText: ({ node }) => inline ? `$${node.attrs.latex}$` : `$$${node.attrs.latex}$$`,
    addNodeView: () => ({ node }) => createFormulaView(node)
  })
}

export const InlineMath = createFormulaNode("inlineMath", true)
export const BlockMath = createFormulaNode("blockMath", false)
