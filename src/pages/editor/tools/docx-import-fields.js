/**
 * 把目录/页码类 Word 域与内容控件静态化；完整独立的页眉页脚空页码域使用明确占位。
 * 简单域直接解包，复杂域按 begin/separate/end 状态机去除代码；未知语义或不完整结果停止导入。
 */
import { getXmlChildren, getWordChild, getWordValue, WORD_XML } from "./docx-import-xml.js"

// 内容控件按 Word 内建图库名白名单放行，不凭显示文字猜测未知控件用途。
const GALLERIES = new Set(["Table of Contents", "Page Numbers (Bottom of Page)", "Page Numbers (Top of Page)", "Page Numbers (Page Margins)"])
const FIELD_WARNING = "有已保存显示值的目录、页码及页码引用按原值转为普通文字；不会随编辑或分页自动更新，原页码可能不适用于当前文档"
const EMPTY_PAGE_WARNING = "原文页眉、页脚的页码域未保存实际数字，已用 [页码] / [总页数] 占位并转为普通文字；不会随编辑或分页自动更新，请保留原 DOCX"
const XML_XML = "http://www.w3.org/XML/1998/namespace"
const XMLNS_XML = "http://www.w3.org/2000/xmlns/"
const RUN_PROPERTIES = new Set(["rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"])

/** 域指令必须属于可静态保留的目录/页码类型；这里只识别用途，不执行指令或解析目标。 */
function checkInstruction(instruction) {
  if (!/^(TOC|PAGE|NUMPAGES|PAGEREF)(?:\s|$)/i.test(instruction.trim())) throw new Error("文档包含暂不支持的域，仅能保留目录和页码类域的已有显示值，请保留原 DOCX")
}

// 不执行域代码、不访问引用目标，也不计算当前页码；空页码占位仅适用于普通页眉页脚。
export function normalizeDocxFields(xml, warnings) {
  // 从内到外解包允许的控件，保留子节点顺序；结构/属性超出白名单时拒绝而非部分截取。
  for (const control of Array.from(xml.getElementsByTagNameNS(WORD_XML, "sdt")).reverse()) {
    const properties = getWordChild(control, "sdtPr")
    const content = getWordChild(control, "sdtContent")
    const gallery = getWordValue(getWordChild(properties, "docPartObj"), "docPartGallery")
    const allowed = ["rPr", "id", "docPartObj", "alias", "tag", "lock"]
    if (!GALLERIES.has(gallery) || !content || getXmlChildren(properties).some(node => node.namespaceURI !== WORD_XML || !allowed.includes(node.localName))) throw new Error("文档包含暂不支持的内容控件，仅支持目录和页码的静态内容，请保留原 DOCX")
    if (getXmlChildren(control).some(node => node.namespaceURI !== WORD_XML || !["sdtPr", "sdtEndPr", "sdtContent"].includes(node.localName))) throw new Error("内容控件结构无法可靠转换，请保留原 DOCX")
    for (const child of Array.from(content.childNodes)) control.parentNode.insertBefore(child, control)
    control.parentNode.removeChild(control)
    warnings.add(FIELD_WARNING)
  }
  fillEmptyPageFields(xml, warnings)
  // fldSimple 已携带指令属性和结果子树，确认存在显示文字后移出子节点并删除域壳。
  for (const field of Array.from(xml.getElementsByTagNameNS(WORD_XML, "fldSimple")).reverse()) {
    checkInstruction(field.getAttributeNS(WORD_XML, "instr"))
    if (!Array.from(field.getElementsByTagNameNS(WORD_XML, "t")).some(node => node.textContent.length)) throw new Error("目录或页码域没有已保存的显示值，请先在 Word 中更新域并保存")
    for (const child of Array.from(field.childNodes)) field.parentNode.insertBefore(child, field)
    field.parentNode.removeChild(field)
    warnings.add(FIELD_WARNING)
  }
  // 复杂域标记可能跨 run/段落，状态栈必须贯穿整棵 XML，不能在每个 run 中重新开始。
  const stack = []
  // 用子元素快照递归，允许遍历时删除代码节点；结果正文原地保留，不重排显示内容。
  const visit = node => {
    for (const child of getXmlChildren(node)) {
      if (child.namespaceURI === WORD_XML && child.localName === "fldChar") {
        const type = child.getAttributeNS(WORD_XML, "fldCharType")
        if (getXmlChildren(child).length) throw new Error("域包含暂不支持的附加内容，请保留原 DOCX")
        // 只有父域已进入结果区时允许嵌套域，否则无法可靠区分代码与显示值。
        if (type === "begin") {
          if (stack.length >= 32 || stack.some(field => !field.separated)) throw new Error("域代码嵌套结构暂不支持，请保留原 DOCX")
          stack.push({ instruction: "", separated: false, result: false })
        // separate 是代码/结果的唯一合法分界，切换之前验证完整拼接的指令。
        } else if (type === "separate") {
          const current = stack.at(-1)
          if (!current || current.separated) throw new Error("Word 域的分隔标记无效，请保留原 DOCX")
          checkInstruction(current.instruction)
          current.separated = true
        // end 要求已出现分界及非空结果；只剩指令、空结果或不成对标记均不能作为成功导入。
        } else if (type === "end") {
          const current = stack.pop()
          if (!current?.separated || !current.result) throw new Error("目录或页码域没有完整的已保存显示值，请先在 Word 中更新域并保存")
        } else throw new Error("Word 域标记无法识别，请保留原 DOCX")
        node.removeChild(child)
        warnings.add(FIELD_WARNING)
      } else if (child.namespaceURI === WORD_XML && child.localName === "instrText") {
        const current = stack.at(-1)
        if (!current || current.separated) throw new Error("Word 域代码位置无效，请保留原 DOCX")
        // 指令常被 Word 拆成多个 instrText；按文档顺序拼接后才验证类型。
        current.instruction += child.textContent
        node.removeChild(child)
      } else {
        if (child.namespaceURI === WORD_XML && ["t", "drawing", "pict"].includes(child.localName)) {
          if (stack.some(field => !field.separated)) throw new Error("Word 域代码与显示值无法区分，请保留原 DOCX")
          // 嵌套域的可见结果也属于外层结果，图片/非空文字会为所有活动域标记已保存显示值。
          if (child.localName !== "t" || child.textContent.length) stack.forEach(field => { field.result = true })
        }
        visit(child)
      }
    }
  }
  visit(xml.documentElement)
  // 遍历结束仍有活动域说明源结构未闭合，不能仅凭已经读到部分文字就接受。
  if (stack.length) throw new Error("Word 域未完整结束，请保留原 DOCX")
}

/** 只补齐完整独立空域；随后仍经过原状态机，残缺/嵌套/未知语义不能因占位而通过。 */
function fillEmptyPageFields(xml, warnings) {
  if (!isWord(xml.documentElement, "hdr") && !isWord(xml.documentElement, "ftr")) return
  const stack = []
  const replacements = []
  const visit = (node, simpleDepth = 0) => {
    for (const child of getXmlChildren(node)) {
      if (isWord(child, "fldSimple")) {
        if (!stack.length && !simpleDepth && emptySimpleField(child)) replacements.push({ field: child, text: pagePlaceholder(child.getAttributeNS(WORD_XML, "instr")) })
        visit(child, simpleDepth + 1)
      } else if (isWord(child, "fldChar")) {
        const type = child.getAttributeNS(WORD_XML, "fldCharType")
        if (type === "begin") {
          if (stack.length >= 32) throw new Error("域代码嵌套结构暂不支持，请保留原 DOCX")
          stack.forEach(field => { field.nested = true })
          stack.push({ begin: child, nested: stack.length > 0 || simpleDepth > 0 })
        } else if (type === "end") {
          const field = stack.pop()
          if (field && !field.nested) {
            const text = emptyComplexField(field.begin, child)
            if (text) replacements.push({ end: child, text })
          }
        }
      } else visit(child, simpleDepth)
    }
  }
  visit(xml.documentElement)
  if (stack.length) return
  for (const replacement of replacements) {
    const text = xml.createElementNS(WORD_XML, "w:t")
    text.appendChild(xml.createTextNode(replacement.text))
    if (replacement.end) replacement.end.parentNode.insertBefore(text, replacement.end)
    else {
      const run = xml.createElementNS(WORD_XML, "w:r")
      run.appendChild(text)
      replacement.field.appendChild(run)
    }
  }
  if (replacements.length) warnings.add(EMPTY_PAGE_WARNING)
}

function emptySimpleField(field) {
  if (!isWord(field.parentNode, "p") || !pagePlaceholder(field.getAttributeNS(WORD_XML, "instr")) ||
    !wordAttributes(field, ["instr", "dirty", "fldLock"]) || !noStructuralText(field)) return false
  for (const name of ["dirty", "fldLock"]) {
    if (field.hasAttributeNS(WORD_XML, name) && !["0", "1", "true", "false", "on", "off"].includes(field.getAttributeNS(WORD_XML, name))) return false
  }
  return getXmlChildren(field).every(run => fieldRun(run) && getXmlChildren(run)
    .filter(node => !isWord(node, "rPr"))
    .every(node => isWord(node, "t") && textLeaf(node) && !node.textContent))
}

function emptyComplexField(begin, end) {
  const firstRun = begin.parentNode, lastRun = end.parentNode
  const paragraph = firstRun.parentNode
  if (!isWord(paragraph, "p") || lastRun.parentNode !== paragraph) return undefined
  const nodes = getXmlChildren(paragraph)
  const first = nodes.indexOf(firstRun), last = nodes.indexOf(lastRun)
  if (first < 0 || last < first) return undefined
  const runs = nodes.slice(first, last + 1)
  if (!runs.every(fieldRun)) return undefined
  const tokens = runs.flatMap(run => getXmlChildren(run).filter(node => !isWord(node, "rPr")))
  const start = tokens.indexOf(begin), finish = tokens.indexOf(end)
  if (start < 0 || finish <= start || !fieldMarker(begin, "begin") || !fieldMarker(end, "end")) return undefined
  const content = tokens.slice(start + 1, finish)
  let index = 0, instruction = ""
  while (isWord(content[index], "instrText")) {
    if (!textLeaf(content[index])) return undefined
    instruction += content[index++].textContent
  }
  const text = pagePlaceholder(instruction)
  if (!text || !fieldMarker(content[index++], "separate")) return undefined
  if (!content.slice(index).every(node => isWord(node, "t") && textLeaf(node) && !node.textContent)) return undefined
  return text
}

function fieldRun(run) {
  if (!isWord(run, "r") || !wordAttributes(run, ["rsidR", "rsidRPr", "rsidRDefault"]) || !noStructuralText(run)) return false
  for (const attribute of Array.from(run.attributes).filter(value => value.namespaceURI !== XMLNS_XML)) {
    if (!/^[\da-f]{8}$/i.test(attribute.value)) return false
  }
  const properties = getXmlChildren(run).filter(node => isWord(node, "rPr"))
  if (properties.length > 1) return false
  if (!properties.length) return true
  const property = properties[0]
  if (getXmlChildren(run)[0] !== property || !wordAttributes(property, []) || !noStructuralText(property)) return false
  const formats = getXmlChildren(property)
  return new Set(formats.map(node => node.localName)).size === formats.length && formats.every(node =>
    node.namespaceURI === WORD_XML && RUN_PROPERTIES.has(node.localName) && !getXmlChildren(node).length && !node.textContent.trim() &&
    Array.from(node.attributes).every(attribute => [WORD_XML, XMLNS_XML].includes(attribute.namespaceURI)))
}

function fieldMarker(node, type) {
  return isWord(node, "fldChar") && wordAttributes(node, ["fldCharType"]) &&
    node.getAttributeNS(WORD_XML, "fldCharType") === type && !getXmlChildren(node).length && !node.textContent.trim()
}

function textLeaf(node) {
  return !getXmlChildren(node).length && Array.from(node.attributes).every(attribute =>
    attribute.namespaceURI === XMLNS_XML || attribute.namespaceURI === XML_XML && attribute.localName === "space" && ["default", "preserve"].includes(attribute.value))
}

function wordAttributes(node, names) {
  return Array.from(node.attributes || []).every(attribute => attribute.namespaceURI === XMLNS_XML ||
    attribute.namespaceURI === WORD_XML && names.includes(attribute.localName))
}

const pagePlaceholder = instruction => ({ PAGE: "[页码]", NUMPAGES: "[总页数]" })[instruction.trim().toUpperCase()]
const noStructuralText = node => !Array.from(node.childNodes).some(child => [3, 4].includes(child.nodeType) && child.textContent.trim())
const isWord = (node, name) => node?.namespaceURI === WORD_XML && node.localName === name
