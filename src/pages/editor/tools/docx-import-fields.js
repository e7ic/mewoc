/**
 * 把目录/页码类 Word 域与内容控件静态化，只保留源文件已有的显示结果。
 * 简单域直接解包，复杂域按 begin/separate/end 状态机去除代码；未知语义或不完整结果停止导入。
 */
import { getXmlChildren, getWordChild, getWordValue, WORD_XML } from "./docx-import-xml.js"

// 内容控件按 Word 内建图库名白名单放行，不凭显示文字猜测未知控件用途。
const GALLERIES = new Set(["Table of Contents", "Page Numbers (Bottom of Page)", "Page Numbers (Top of Page)", "Page Numbers (Page Margins)"])
const FIELD_WARNING = "目录、页码及页码引用保留原文件中已保存的显示值，转为普通文字；不会随编辑或分页自动更新，原页码可能不适用于当前文档"

/** 域指令必须属于可静态保留的目录/页码类型；这里只识别用途，不执行指令或解析目标。 */
function checkInstruction(instruction) {
  if (!/^(TOC|PAGE|NUMPAGES|PAGEREF)(?:\s|$)/i.test(instruction.trim())) throw new Error("文档包含暂不支持的域，仅能保留目录和页码类域的已有显示值，请保留原 DOCX")
}

// 只读取 Word 已保存的显示值，不执行域代码、不访问引用目标，也不计算当前页码。
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
  // fldSimple 已携带指令属性和结果子树，确认存在显示文字后移出子节点并删除域壳。
  for (const field of Array.from(xml.getElementsByTagNameNS(WORD_XML, "fldSimple")).reverse()) {
    checkInstruction(field.getAttributeNS(WORD_XML, "instr"))
    if (!field.getElementsByTagNameNS(WORD_XML, "t").length) throw new Error("目录或页码域没有已保存的显示值，请先在 Word 中更新域并保存")
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
