/**
 * DOCX 导入的预处理层：检查 ZIP 与 XML，静态展开可支持的 Word 特性，记录转换损失。
 * 输出重建的内存归档、按源顺序排列的段落元信息和公式占位表，供 Mammoth 与 JSON 阶段复原语义。
 * 不支持而可能丢失正文的结构会停止整份导入，不输出看似成功的残缺文档。
 */
import JSZip from "jszip"
import { createId } from "./create-id.js"
import { readDocxXml, writeDocxXml, getXmlChildren, getWordChild, getWordValue, WORD_XML, MATH_XML } from "./docx-import-xml.js"
import { readDocxFormula } from "./docx-import-formula.js"
import { readDocxParagraphs } from "./docx-import-numbering.js"
import { normalizeDocxLegacyContent } from "./docx-import-drawings.js"
import { normalizeDocxFields } from "./docx-import-fields.js"
import { appendDocxPageContent, createDocxChartReader } from "./docx-import-report.js"

// 这些元素具有当前编辑器无法完整表示的独立语义，不能当作普通样式略过。
const UNSUPPORTED = {
  altChunk: "外部格式内容", object: "嵌入对象",
  ins: "插入修订", del: "删除修订", moveFrom: "移动修订", moveTo: "移动修订",
  footnoteReference: "脚注", endnoteReference: "尾注"
}
// 压缩文件大小不能代表解压开销；另设总解压字节限额，配合循环内的单部件限额。
const MAX_EXPANDED_BYTES = 40 * 1024 * 1024

// 本函数只在 Worker 或测试进程运行；只重建内存 ZIP，不访问压缩包引用的外部文件或地址。
/**
 * source 必须为非空 Uint8Array；warnings 为调用方共享的 Set，signal 用于中断耗时步骤。
 * 先逐部件校验再进行语义变换，最终只把已检查的部件写入新 ZIP，原字节始终不被改写。
 */
export async function readDocxImportArchive(source, warnings, signal) {
  if (!(source instanceof Uint8Array) || !source.byteLength || source.byteLength > 32 * 1024 * 1024) throw new Error("请选择不超过 32 MiB 的 Word 文件")
  signal?.throwIfAborted()
  let archive
  try { archive = await JSZip.loadAsync(source.slice()) }
  catch { throw new Error("无法读取 Word 文件；旧版 DOC、加密文件或损坏文件不受支持") }
  const entries = Object.values(archive.files)
  if (entries.length > 512) throw new Error("Word 文件包含过多部件，请拆分文档后重试")
  // XML 先存为 DOM 以便跨部件变换；非 XML 资源直接保留字节；嵌入文件暂缓决定是否允许。
  const checked = new JSZip()
  const parts = new Map()
  const embeddedFiles = new Set()
  let total = 0
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (entry.dir) continue
    // JSZip 会规范化部分路径，必须同时比对原路径，防止异常路径被规范化后逃过检查。
    if (entry.unsafeOriginalName !== entry.name || /(^\/|\\|(^|\/)\.\.?\/)/.test(entry.name)) throw new Error("Word 文件包含异常路径")
    if (/vbaproject/i.test(entry.name)) throw new Error("暂不支持宏或嵌入文件，请保留原 DOCX")
    if (/^word\/embeddings\//i.test(entry.name)) embeddedFiles.add(entry.name)
    const chunks = []
    let size = 0
    // 流式解压边读边累计大小，超过限额时立即暂停，避免先完整展开再检查造成内存峰值。
    await new Promise((resolve, reject) => {
      const stream = entry.internalStream("uint8array")
      let finished = false
      // 结束回调可能被 abort、流错误和 end 竞争触发；仅第一次结算 Promise 并移除取消监听。
      const finish = error => {
        if (finished) return
        finished = true
        stream.pause()
        signal?.removeEventListener("abort", abort)
        if (error) reject(error)
        else resolve()
      }
      const abort = () => finish(signal.reason)
      signal?.addEventListener("abort", abort, { once: true })
      stream.on("data", chunk => {
        if (finished) return
        size += chunk.length
        total += chunk.length
        if (size > 8 * 1024 * 1024 || total > MAX_EXPANDED_BYTES) finish(new Error("Word 解压内容超过限额（单项 8 MiB / 总量 40 MiB）"))
        else chunks.push(chunk)
      }).on("error", finish).on("end", () => finish()).resume()
      if (signal?.aborted) abort()
    })
    // 通过限额后才分配连续缓冲区；按块偏移拼接，保留图片等二进制资源的原始字节。
    const bytes = new Uint8Array(size)
    let offset = 0
    chunks.forEach(chunk => {
      bytes.set(chunk, offset)
      offset += chunk.length
    })
    // 所有 XML/关系部件均做严格 UTF-8 和结构检查，不能只检查主文档而遗漏资源关系。
    if (/\.(xml|rels)$/i.test(entry.name)) {
      const xml = readDocxXml(new TextDecoder("utf-8", { fatal: true }).decode(bytes), entry.name)
      for (const [name, label] of Object.entries(UNSUPPORTED)) {
        if (xml.getElementsByTagNameNS(WORD_XML, name).length) throw new Error(`文档包含暂不支持的${label}，请保留原 DOCX`)
      }
      // 只允许可作为普通链接保留的外部超链接；图片、文件等外链不交给转换器读取。
      for (const relation of Array.from(xml.getElementsByTagNameNS("*", "Relationship"))) {
        if (relation.getAttribute("TargetMode") === "External" && !relation.getAttribute("Type").endsWith("/hyperlink")) throw new Error("暂不读取外部图片或文件，请先在 Word 中内嵌资源")
      }
      if (/word\/comments\d*\.xml/.test(entry.name) && (xml.documentElement.textContent.trim() || ["drawing", "pict", "txbxContent", "comment"].some(name => xml.getElementsByTagNameNS(WORD_XML, name).length))) throw new Error("暂不支持非空批注，请保留原 DOCX")
      // 域在所有部件中先静态化，因此页眉/页脚追加到正文时也只携带已保存的显示值。
      normalizeDocxFields(xml, warnings)
      // Mammoth 只判断表头元素存在性；显式关闭的标记必须先移除，不能误把整表导成表头。
      for (const header of Array.from(xml.getElementsByTagNameNS(WORD_XML, "tblHeader"))) {
        if (["0", "false", "off"].includes(header.getAttributeNS(WORD_XML, "val"))) header.parentNode.removeChild(header)
      }
      parts.set(entry.name, xml)
    } else if (!embeddedFiles.has(entry.name)) checked.file(entry.name, bytes)
  }
  // 文件扩展名与 ZIP 形态均不能证明是受支持的 DOCX；核对主命名空间及必要包部件。
  const xml = parts.get("word/document.xml")
  if (xml?.documentElement.namespaceURI === "http://purl.oclc.org/ooxml/wordprocessingml/main") throw new Error("暂不支持严格 Open XML 文档，请在 Word 中另存为普通 Word 文档（.docx）后重试，并保留原文件")
  if (!xml || xml.documentElement.namespaceURI !== WORD_XML || xml.documentElement.localName !== "document" || !parts.has("[Content_Types].xml") || !parts.has("_rels/.rels")) throw new Error("Word 文件缺少必要部件或使用暂不支持的文档格式")
  // 先附加页内容、再展开图形，最后读取公式与段落；这一顺序确保新增正文被统一编号和统计。
  appendDocxPageContent(parts, warnings)
  const charts = createDocxChartReader(parts, warnings, embeddedFiles)
  normalizeDocxLegacyContent(xml, warnings, charts.read)
  // 只有成功读取缓存的图表所引用的 XLSX 可作为不执行的附属数据被略过。
  // 其他嵌入文件仍拒绝，不能因放开图表而把任意 OLE 对象静默丢弃。
  if ([...embeddedFiles].some(name => !charts.allowedEmbeddings.has(name))) throw new Error("暂不支持独立的嵌入文件，仅支持读取图表已有缓存，请保留原 DOCX")
  // Mammoth 不负责公式和列表身份：公式先替换为不会碰撞的文字标记，列表元数据从 XML 单独读取。
  const formulas = replaceFormulas(xml)
  const paragraphs = readDocxParagraphs(xml, parts.get("word/numbering.xml"), parts.get("word/styles.xml"), warnings)
  if (xml.getElementsByTagNameNS(WORD_XML, "tbl").length) warnings.add("表格保留内容和合并，列宽、边框、底色及跨页设置使用编辑器默认值")
  if (xml.getElementsByTagNameNS(WORD_XML, "br").length || xml.getElementsByTagNameNS(WORD_XML, "pageBreakBefore").length) warnings.add("普通换行保留，原文的手动分页与页面布局不保证保留")
  // 新 ZIP 使用 STORE 避免重新压缩的额外开销；生成前检查取消，调用方在下一转换阶段也会复查。
  for (const [name, part] of parts) checked.file(name, writeDocxXml(part))
  signal?.throwIfAborted()
  return { buffer: await checked.generateAsync({ type: "uint8array", compression: "STORE" }), paragraphs, formulas }
}

/**
 * 用普通 Word 文本 run 暂存 OMML 公式的位置，并另存 LaTeX 与行内/块级类型。
 * 唯一前缀防止与正文碰撞；JSON 阶段根据完整 marker 还原公式，避免靠正文内容猜位置。
 */
function replaceFormulas(xml) {
  const formulas = []
  const prefix = `MEWOCMATH${createId().replaceAll("-", "")}X`
  // 替换节点保持原有位置；公式不直接位于 w:p 内时补一个合法段落供 Mammoth 识别。
  const replace = (node, math, display) => {
    const marker = `${prefix}${formulas.length}END`
    formulas.push({ marker, latex: readDocxFormula(math), type: display ? "blockMath" : "inlineMath" })
    const run = xml.createElementNS(WORD_XML, "w:r")
    const text = xml.createElementNS(WORD_XML, "w:t")
    text.appendChild(xml.createTextNode(marker))
    run.appendChild(text)
    let replacement = run
    if (node.parentNode.namespaceURI !== WORD_XML || node.parentNode.localName !== "p") {
      replacement = xml.createElementNS(WORD_XML, "w:p")
      replacement.appendChild(run)
    }
    node.parentNode.replaceChild(replacement, node)
  }
  // 先处理公式段落，避免其中的 oMath 随后被重复当作行内公式；组合公式段落明确拒绝。
  for (const block of Array.from(xml.getElementsByTagNameNS(MATH_XML, "oMathPara"))) {
    const children = getXmlChildren(block)
    const maths = children.filter(child => child.namespaceURI === MATH_XML && child.localName === "oMath")
    if (maths.length !== 1 || children.some(child => child.namespaceURI !== MATH_XML || !["oMath", "oMathParaPr"].includes(child.localName))) throw new Error("多公式组合段落暂不能可靠转换，请保留原 DOCX")
    replace(block, maths[0], true)
  }
  // 独占居中 Word 段落的公式也视作块级；混排或未居中的公式仍保留行内类型。
  for (const inline of Array.from(xml.getElementsByTagNameNS(MATH_XML, "oMath"))) {
    const paragraph = inline.parentNode
    const content = getXmlChildren(paragraph).filter(child => !(child.namespaceURI === WORD_XML && child.localName === "pPr"))
    const display = paragraph.namespaceURI === WORD_XML && paragraph.localName === "p" && content.length === 1 && getWordValue(getWordChild(paragraph, "pPr"), "jc") === "center"
    replace(inline, inline, display)
  }
  return formulas
}
