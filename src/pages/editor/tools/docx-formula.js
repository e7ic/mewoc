import * as sdk from "docx"
import { renderFormula } from "./formula.js"

// KaTeX 负责解析和安全限制；这里只消费生成的 MathML 白名单，不解释用户 XML。
// 整个公式转换成功才采用 OMML，遇到不支持的排版保留完整源码，不能丢掉局部符号。
export async function createDocxFormula(latex, displayMode, warnings) {
  try {
    const source = await renderFormula(latex, displayMode)
    const parsed = new DOMParser().parseFromString(source, "text/html")
    const root = parsed.querySelector("math")
    if (!root) throw new Error("公式未生成 MathML")
    return new sdk.Math({ children: convertMath(root) })
  } catch {
    warnings.add("部分公式暂不能转换为 Word 公式，已在原位置保留完整 LaTeX 源码；可用 HTML 或打印查看排版")
    return new sdk.TextRun({ text: latex, font: "Menlo", color: "A63737" })
  }
}

function convertMath(node) {
  const children = [...node.children]
  const tag = node.localName
  const child = index => convertMath(children[index])
  const content = () => children.flatMap(convertMath)
  if (tag === "math" || tag === "mrow") {
    // 可伸缩括号包住分式/矩阵，避免导出后退化为与正文等高的小括号。
    if (children.length >= 2 && children[0].localName === "mo" && children.at(-1).localName === "mo"
      && children[0].getAttribute("fence") === "true" && children.at(-1).getAttribute("fence") === "true") {
      return [element("m:d", [
        element("m:dPr", [element("m:begChr", [], { "m:val": children[0].textContent }), element("m:endChr", [], { "m:val": children.at(-1).textContent })]),
        element("m:e", children.slice(1, -1).flatMap(convertMath))
      ])]
    }
    return content()
  }
  if (tag === "semantics") return child(0)
  if (tag === "mstyle") {
    if ([...node.attributes].some(attr => !["displaystyle", "scriptlevel"].includes(attr.name))) throw new Error("公式样式不支持")
    return content()
  }
  if (["mi", "mn", "mo", "mtext"].includes(tag)) {
    const variant = node.getAttribute("mathvariant")
    if (variant && !["normal", "italic", "bold", "bold-italic"].includes(variant)) throw new Error("公式字体不支持")
    const style = { normal: "p", italic: "i", bold: "b", "bold-italic": "bi" }[variant] || (tag === "mi" ? "i" : "p")
    return [element("m:r", [
      element("m:rPr", [element("m:sty", [], { "m:val": style })]),
      element("m:t", [node.textContent], { "xml:space": "preserve" })
    ])]
  }
  if (tag === "mfrac") {
    if (node.hasAttribute("linethickness")) throw new Error("特殊分式线不支持")
    return [new sdk.MathFraction({ numerator: child(0), denominator: child(1) })]
  }
  if (tag === "msqrt") return [new sdk.MathRadical({ children: content() })]
  if (tag === "mroot") return [new sdk.MathRadical({ children: child(0), degree: child(1) })]
  if (tag === "msup") return [new sdk.MathSuperScript({ children: child(0), superScript: child(1) })]
  if (tag === "msub") return [new sdk.MathSubScript({ children: child(0), subScript: child(1) })]
  if (tag === "msubsup") return [new sdk.MathSubSuperScript({ children: child(0), subScript: child(1), superScript: child(2) })]
  if (tag === "mover" && node.getAttribute("accent") === "true") {
    if (children[1].localName !== "mo") throw new Error("组合重音不支持")
    return [element("m:acc", [element("m:accPr", [element("m:chr", [], { "m:val": children[1].textContent })]), element("m:e", child(0))])]
  }
  if (tag === "munder") return [new sdk.MathLimitLower({ children: child(0), limit: child(1) })]
  if (tag === "mover") return [new sdk.MathLimitUpper({ children: child(0), limit: child(1) })]
  if (tag === "munderover") return [new sdk.MathLimitUpper({ children: [new sdk.MathLimitLower({ children: child(0), limit: child(1) })], limit: child(2) })]
  if (tag === "mtable") {
    if (children.some(row => row.localName !== "mtr" || [...row.children].some(cell => cell.localName !== "mtd"))) throw new Error("公式表格不支持")
    const columns = children[0]?.children.length
    if (!columns || children.some(row => row.children.length !== columns)) throw new Error("公式矩阵不规则")
    return [element("m:m", [
      element("m:mPr", [element("m:mcs", [element("m:mc", [element("m:mcPr", [element("m:count", [], { "m:val": columns }), element("m:mcJc", [], { "m:val": "center" })])])])]),
      ...children.map(row => element("m:mr", [...row.children].map(cell => element("m:e", [...cell.children].flatMap(convertMath)))))
    ])]
  }
  if (tag === "mspace") {
    const width = node.getAttribute("width") || "0em"
    if (!/^(0|0\.\d+|1)em$/.test(width)) throw new Error("公式特殊间距不支持")
    return [new sdk.MathRun(Number.parseFloat(width) ? "\u2009" : "")]
  }
  throw new Error(`不支持的公式结构 ${tag}`)
}

function element(name, children, attrs) {
  const node = new sdk.ImportedXmlComponent(name, attrs)
  children.forEach(child => node.push(child))
  return node
}
