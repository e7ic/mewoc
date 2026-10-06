/** 行内/独立公式的节点定义与异步 NodeView；LaTeX 源码是保存、复制和重新渲染的依据。 */
import { Node } from "@tiptap/core"
import { getFormulaSourceError, renderFormula } from "../tools/formula.js"

// 源码是持久化依据，MathML 只是异步生成的显示结果；加载失败仍展示可恢复的 LaTeX。
function createFormulaView(node) {
  const type = node.type.name
  const displayMode = type === "blockMath"
  const dom = document.createElement(displayMode ? "div" : "span")
  dom.setAttribute("data-type", displayMode ? "block-math" : "inline-math")
  dom.contentEditable = "false"
  let version = 0
  const updateFormula = current => {
    // 更新/销毁会使旧任务失效，防止较慢的渲染覆盖新公式或回写已卸载视图。
    const request = ++version
    const latex = current.attrs.latex
    dom.setAttribute("data-latex", latex)
    dom.setAttribute("aria-label", `公式：${latex}`)
    dom.removeAttribute("data-formula-error")
    // 先用安全的文本占位，加载渲染器期间仍可识别公式；成功后才替换为受控 MathML。
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
      // 类型改变时交给编辑器重建节点视图；同类型只在源码变化时重绘。
      if (current.type.name !== type) return false
      if (current.attrs.latex !== dom.getAttribute("data-latex")) updateFormula(current)
      return true
    },
    // 异步渲染造成的 DOM 变化属于视图，不能被当作用户编辑重新解析进正文。
    ignoreMutation: mutation => mutation.type !== "selection",
    destroy: () => { version += 1 }
  }
}

// 行内与独立公式共享源码契约，但具有不同布局；atom 使公式以整体选中并通过弹窗编辑。
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
      // 只认本项目的显式公式标记，并再次验证源码，普通美元符号文字不会自动转换。
      tag: `${tag}[data-type="${type}"]`,
      getAttrs: element => {
        const latex = element.getAttribute("data-latex")
        return getFormulaSourceError(latex) ? false : { latex }
      }
    }],
    // 节点序列化保留可恢复源码；完整 HTML/打印导出再由转换工具补入显示结果。
    renderHTML: ({ node }) => [tag, { "data-type": type, "data-latex": node.attrs.latex }, node.attrs.latex],
    renderText: ({ node }) => inline ? `$${node.attrs.latex}$` : `$$${node.attrs.latex}$$`,
    addNodeView: () => ({ node }) => createFormulaView(node)
  })
}

export const InlineMath = createFormulaNode("inlineMath", true)
export const BlockMath = createFormulaNode("blockMath", false)
