/**
 * Word 原生 OMML 公式到编辑器 LaTeX 的受限转换器。
 * 递归解释已支持的语义结构与属性，整棵公式成功后才返回源码；不把未知结构降成普通文字。
 */
import { getXmlChildren, MATH_XML, WORD_XML } from "./docx-import-xml.js"
import { getFormulaSourceError } from "./formula.js"

// 显式映射重音、括号和大型运算符；白名单之外的符号布局无法保证等价，必须拒绝。
const ACCENTS = { "̂": "hat", "̃": "tilde", "̅": "bar", "⃗": "vec", "̇": "dot", "̈": "ddot", "̆": "breve", "̌": "check", "´": "acute", "̀": "grave" }
const FENCES = { "(": "(", ")": ")", "[": "[", "]": "]", "{": "\\{", "}": "\\}", "|": "|", "‖": "\\Vert", "⟨": "\\langle", "⟩": "\\rangle", "": "." }
const OPERATORS = { "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "⋃": "\\bigcup", "⋂": "\\bigcap" }
// 每类公式属性节点可接受的子属性；只允许可解释或已明确属于外观控制的属性。
const PROPERTIES = {
  fPr: ["type"], radPr: ["degHide"], sSubPr: [], sSupPr: [], sSubSupPr: ["alnScr"],
  limLowPr: [], limUppPr: [], naryPr: ["chr", "limLoc", "grow", "subHide", "supHide"],
  accPr: ["chr"], dPr: ["begChr", "endChr", "sepChr", "grow", "shp"], mPr: ["mcs"], funcPr: []
}

// 只映射能解释的 OMML 结构，不以 textContent 代替公式树。任何未知子树都拒绝整份导入。
export function readDocxFormula(node) {
  try {
    const latex = getMath(node)
    // 除 OMML 结构检查外，再应用编辑器的 LaTeX 长度/空值约束，确保生成源码可作为公式存储。
    const error = getFormulaSourceError(latex)
    if (error) throw new Error(error)
    return latex
  } catch (error) {
    throw new Error(`部分 Word 公式暂不能可靠转换，已停止导入，请保留原文件（${error.message}）`)
  }
}

/** 返回当前 OMML 子树的 LaTeX；所有子结构都在这个递归入口执行命名空间与类型检查。 */
function getMath(node) {
  if (node.namespaceURI !== MATH_XML) throw new Error("公式命名空间不支持")
  const name = node.localName
  const children = getXmlChildren(node)
  // 语义必需项必须恰好出现一次；缺项或重复项不能通过取第一个节点来掩盖。
  const part = name => {
    const matches = children.filter(child => child.namespaceURI === MATH_XML && child.localName === name)
    if (matches.length !== 1) throw new Error(`公式缺少或重复 ${name}`)
    return getMath(matches[0])
  }
  // 每种构造在读取正文前校验直接子结构与属性，避免支持一部分时静默丢掉其余语义。
  const check = names => {
    if (children.some(child => child.namespaceURI !== MATH_XML || !names.includes(child.localName))) throw new Error(`公式 ${name} 含不支持的结构`)
    // 属性也必须受限，不能只验证正文后悄悄丢掉未知公式语义；ctrlPr 仅控制外观。
    for (const child of children.filter(child => child.localName.endsWith("Pr"))) {
      const allowed = PROPERTIES[child.localName] || []
      if (getXmlChildren(child).some(property => property.namespaceURI !== MATH_XML || ![...allowed, "ctrlPr"].includes(property.localName))) throw new Error("公式属性暂不支持")
      if (child.localName === "mPr") {
        const columns = getXmlChildren(child).find(property => property.localName === "mcs")
        const names = { mcs: ["mc"], mc: ["mcPr"], mcPr: ["count", "mcJc"], count: [], mcJc: [] }
        // 矩阵列配置有独立层级，递归验证其允许树形，不能只放行顶层 mcs 容器。
        const checkColumns = parent => {
          for (const property of getXmlChildren(parent)) {
            if (property.namespaceURI !== MATH_XML || !names[parent.localName]?.includes(property.localName)) throw new Error("公式矩阵列属性暂不支持")
            checkColumns(property)
          }
        }
        if (columns) checkColumns(columns)
      }
    }
  }
  // 属性缺失使用该构造的 OMML 默认值，显式属性值仍原样保留供分支判断。
  const property = (group, key, fallback) => {
    const properties = children.find(child => child.namespaceURI === MATH_XML && child.localName === group)
    const child = getXmlChildren(properties).find(child => child.localName === key)
    return child?.hasAttributeNS(MATH_XML, "val") ? child.getAttributeNS(MATH_XML, "val") : fallback
  }
  // 纯容器串接子树源码；各子树继续递归检查，不直接读取容器的 textContent。
  if (["oMath", "e", "num", "den", "sub", "sup", "deg", "lim", "fName"].includes(name)) return children.map(getMath).join("")
  // 文字 run 允许指定数学字形；普通文字/逐字模式语义不同，无法等价转换时明确停止。
  if (name === "r") {
    if (children.some(child => !((child.namespaceURI === MATH_XML && ["rPr", "t"].includes(child.localName)) || (child.namespaceURI === WORD_XML && child.localName === "rPr")))) throw new Error("公式文字含不支持的结构")
    const text = children.filter(child => child.localName === "t").map(child => escapeMath(child.textContent)).join("")
    const properties = children.find(child => child.localName === "rPr" && child.namespaceURI === MATH_XML)
    if (getXmlChildren(properties).some(child => child.namespaceURI !== MATH_XML || !["sty", "nor", "lit", "brk", "aln"].includes(child.localName))) throw new Error("公式文字字体不支持")
    for (const flag of ["nor", "lit"]) {
      const value = getXmlChildren(properties).find(child => child.localName === flag)
      if (value && !["0", "false", "off"].includes(value.getAttributeNS(MATH_XML, "val"))) throw new Error("公式中的普通文字或逐字模式暂不支持")
    }
    const style = property("rPr", "sty", "i")
    if (!["i", "p", "b", "bi"].includes(style)) throw new Error("公式字形不支持")
    return style === "p" ? `\\mathrm{${text}}` : style === "b" ? `\\mathbf{${text}}` : style === "bi" ? `\\boldsymbol{${text}}` : text
  }
  // 分式和根式按结构保留分子/分母与根指数；只有标准横线分式可用当前 LaTeX 映射表达。
  if (name === "f") {
    check(["fPr", "num", "den"])
    if (property("fPr", "type", "bar") !== "bar") throw new Error("特殊分式不支持")
    return `\\frac{${part("num")}}{${part("den")}}`
  }
  if (name === "rad") {
    check(["radPr", "deg", "e"])
    const degree = children.some(child => child.localName === "deg") ? part("deg") : ""
    const hidden = property("radPr", "degHide", "0")
    return `\\sqrt${degree && !["1", "true", "on"].includes(hidden) ? `[${degree}]` : ""}{${part("e")}}`
  }
  // 基底先用大括号分组，保证复合表达式的上下标绑定到整个基底，而不是最后一个字符。
  if (["sSub", "sSup", "sSubSup"].includes(name)) {
    check([`${name}Pr`, "e", "sub", "sup"])
    return `{${part("e")}}${name !== "sSup" ? `_{${part("sub")}}` : ""}${name !== "sSub" ? `^{${part("sup")}}` : ""}`
  }
  if (name === "limLow" || name === "limUpp") {
    check([`${name}Pr`, "e", "lim"])
    return `${name === "limLow" ? "\\underset" : "\\overset"}{${part("lim")}}{${part("e")}}`
  }
  // 大型运算符按隐藏标志决定是否输出上下限，正文始终单独分组保留。
  if (name === "nary") {
    check(["naryPr", "e", "sub", "sup"])
    const operator = OPERATORS[property("naryPr", "chr", "∫")]
    if (!operator) throw new Error("大型运算符不支持")
    const sub = ["1", "true", "on"].includes(property("naryPr", "subHide", "0")) ? "" : `_{${part("sub")}}`
    const sup = ["1", "true", "on"].includes(property("naryPr", "supHide", "0")) ? "" : `^{${part("sup")}}`
    return `${operator}${sub}${sup}{${part("e")}}`
  }
  if (name === "acc") {
    check(["accPr", "e"])
    const accent = ACCENTS[property("accPr", "chr", "̂")]
    if (!accent) throw new Error("重音符号不支持")
    return `\\${accent}{${part("e")}}`
  }
  // 使用可伸缩左右括号，多个 e 子项按显式分隔符连接，空字符映射为不可见括号。
  if (name === "d") {
    check(["dPr", "e"])
    const left = FENCES[property("dPr", "begChr", "(")]
    const right = FENCES[property("dPr", "endChr", ")")]
    const separator = FENCES[property("dPr", "sepChr", "|")]
    if (left === undefined || right === undefined || separator === undefined) throw new Error("公式括号不支持")
    const parts = children.filter(child => child.localName === "e").map(getMath)
    if (!parts.length) throw new Error("公式括号内容为空")
    return `\\left${left} ${parts.join(`\\middle${separator} `)} \\right${right}`
  }
  // 矩阵必须非空且各行等长；列/行不规则时无法保证公式布局，拒绝而非补空猜测。
  if (name === "m") {
    check(["mPr", "mr"])
    const rows = children.filter(child => child.localName === "mr").map(row => {
      const cells = getXmlChildren(row)
      if (cells.some(cell => cell.namespaceURI !== MATH_XML || cell.localName !== "e")) throw new Error("公式矩阵结构不支持")
      return cells.map(getMath)
    })
    if (!rows.length || !rows[0].length || rows.some(row => row.length !== rows[0].length)) throw new Error("公式矩阵不规则")
    return `\\begin{matrix}${rows.map(row => row.join("&")).join("\\\\")}\\end{matrix}`
  }
  // 函数名称与参数分别分组，保留 Word 的表达顺序，不猜测函数名对应哪个 LaTeX 命令。
  if (name === "func") {
    check(["funcPr", "fName", "e"])
    return `{${part("fName")}}{${part("e")}}`
  }
  throw new Error(`不支持 ${name}`)
}

/** 对公式文字中的 LaTeX 保留字符和空白转义，防止文字 run 意外变成命令或分组语法。 */
function escapeMath(text) {
  return [...text].map(character => {
    if ("{}_%$&#".includes(character)) return `\\${character}`
    if (character === "\\") return "\\backslash{}"
    if (character === "^") return "\\text{\\textasciicircum}"
    if (character === "~") return "\\text{\\textasciitilde}"
    if (/\s/.test(character)) return "\\ "
    return character
  }).join("")
}
