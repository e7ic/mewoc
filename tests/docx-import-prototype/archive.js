/**
 * 仅供 Node 导入原型使用的 DOCX 归档检查器，输入/输出为内存 Buffer。
 * 流式检查实际解压大小、严格解析所有 XML 并拒绝原型未支持的独立语义，再重建安全归档。
 * 此模块保留原型的较小能力范围，不能用它代表正式导入已支持的公式/页内容行为。
 */
import JSZip from "jszip"
import { JSDOM } from "jsdom"

const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math"
// 分别约束压缩输入、单项/总展开字节和条目数，防止小压缩包带来不可控解压开销。
const LIMITS = { compressed: 32 * 1024 * 1024, entry: 8 * 1024 * 1024, expanded: 40 * 1024 * 1024, entries: 512 }
// 当前原型没有恢复这些语义的机制，遇到即拒绝整份，而非让 Mammoth 自动忽略。
const UNSUPPORTED = ["altChunk", "object", "pict", "ins", "del", "moveFrom", "moveTo", "fldChar", "fldSimple", "sdt", "footnoteReference", "endnoteReference"]

// JSZip 默认只读取目录；逐项消费 StreamHelper，按实际展开字节停止，不能相信 ZIP 的声明大小。
// 这里只处理内存 Buffer，不把 ZIP 路径落盘，也不给 Mammoth 传文件系统路径。
export async function readDocxArchive(source, warnings, signal) {
  if (!Buffer.isBuffer(source) || !source.length || source.length > LIMITS.compressed) throw new Error("请选择不超过 32 MiB 的 DOCX 文件")
  signal?.throwIfAborted()
  let archive
  try { archive = await JSZip.loadAsync(Buffer.from(source)) }
  catch { throw new Error("无法读取 DOCX 压缩包；旧版 DOC 或加密文件不受支持") }
  const entries = Object.values(archive.files)
  if (entries.length > LIMITS.entries) throw new Error("DOCX 压缩包条目过多")
  // 所有检查通过的部件写入全新 ZIP，不修改调用方 Buffer，也不将任何 ZIP 路径写入磁盘。
  const checked = new JSZip()
  let total = 0
  let main = false
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (entry.dir) continue
    // 同时检查规范化前/后的条目名，避免路径穿越被 ZIP 库清理后看起来合法。
    if (entry.unsafeOriginalName !== entry.name || /(^\/|\\|(^|\/)\.\.?\/)/.test(entry.name)) throw new Error("DOCX 包含异常路径")
    if (/vbaproject|word\/embeddings\//i.test(entry.name)) throw new Error("原型不接收宏或嵌入文件，请保留原文件")
    const chunks = []
    let size = 0
    // 在 data 事件中累加真实字节，达到限额立即 pause，而不是把整条目展开后才检查。
    await new Promise((resolve, reject) => {
      const stream = entry.internalStream("nodebuffer")
      let finished = false
      // abort/error/end 可能竞争，第一次结束负责清监听、暂停流并结算，后续触发均忽略。
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
        if (size > LIMITS.entry || total > LIMITS.expanded) finish(new Error("DOCX 展开内容超过原型限额（单项 8 MiB / 总量 40 MiB）"))
        else chunks.push(chunk)
      }).on("error", finish).on("end", () => finish()).resume()
      if (signal?.aborted) abort()
    })
    // 只有已通过字节限额的块才合并；XML 可被规范化重写，二进制资源仍保留原字节。
    let bytes = Buffer.concat(chunks)
    if (/\.(xml|rels)$/i.test(entry.name)) {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("DOCX XML 不允许实体或文档类型声明")
      let dom
      // JSDOM 的 XML 模式用于结构校验，不执行脚本或挂载到当前编辑页面。
      try { dom = new JSDOM(source, { contentType: "text/xml" }) }
      catch { throw new Error(`DOCX XML 无法解析：${entry.name}`) }
      try {
        const xml = dom.window.document
        // 显式栈检查元素深度和数量，避免深递归或大量节点拖垮原型验证进程。
        const stack = [[xml.documentElement, 0]]
        let nodes = 0
        while (stack.length) {
          const [node, depth] = stack.pop()
          nodes += 1
          if (depth > 64 || nodes > 100000) throw new Error("DOCX XML 结构过深或节点过多")
          for (const child of node.children) stack.push([child, depth + 1])
        }
        if (xml.getElementsByTagNameNS(MATH, "oMath").length) throw new Error("原型尚不能保留 Word 原生公式，已停止导入；请保留原文件")
        for (const name of UNSUPPORTED) {
          if (xml.getElementsByTagNameNS(WORD, name).length) throw new Error(`原型暂不支持 ${name} 内容，已停止导入；请保留原文件`)
        }
        // 仅允许可保留为文字超链接的外链，图片/文件引用不进入任何外部读取器。
        for (const relation of xml.getElementsByTagNameNS("*", "Relationship")) {
          if (relation.getAttribute("TargetMode") === "External" && !relation.getAttribute("Type").endsWith("/hyperlink")) throw new Error("原型不读取外部图片或文件，请先在 Word 中内嵌资源")
        }
        // Mammoth 1.12.3 只检查 tblHeader 是否存在，未读取 false；移除显式关闭的标记再转换。
        for (const header of [...xml.getElementsByTagNameNS(WORD, "tblHeader")]) {
          if (["0", "false", "off"].includes(header.getAttributeNS(WORD, "val"))) header.remove()
        }
        // 主文档还需核对 Word Transitional 根元素，并记录列表/表格/分页的原型降级范围。
        if (entry.name === "word/document.xml") {
          if (xml.documentElement.namespaceURI !== WORD || xml.documentElement.localName !== "document") throw new Error("原型仅支持 Transitional Word 文档结构")
          main = true
          if (xml.getElementsByTagNameNS(WORD, "numPr").length) warnings.add("列表按语义导入，起始编号、编号样式、续编和复杂嵌套需人工复核")
          if (xml.getElementsByTagNameNS(WORD, "tbl").length) warnings.add("表格保留合并及内容，列宽、边框、底色和跨页设置使用编辑器默认值")
          if (xml.getElementsByTagNameNS(WORD, "br").length || xml.getElementsByTagNameNS(WORD, "pageBreakBefore").length) warnings.add("换行保留，手动分页与原文分页位置不保证保留")
        }
        if (/word\/(header|footer|comments)\d*\.xml/.test(entry.name) &&
          (xml.documentElement.textContent.trim() || xml.getElementsByTagNameNS(WORD, "drawing").length || xml.getElementsByTagNameNS(WORD, "comment").length)) throw new Error("原型暂不支持页眉、页脚或批注，请保留原文件")
        bytes = Buffer.from(dom.serialize())
      // 每个 XML 的临时窗口在成功/失败时都关闭，防止多部件解析残留 DOM 资源。
      } finally { dom.window.close() }
    }
    checked.file(entry.name, bytes)
  }
  // 核对包级必需部件，ZIP 能读取和扩展名匹配并不足以成为可导入 Word 文档。
  if (!main || !checked.file("[Content_Types].xml") || !checked.file("_rels/.rels")) throw new Error("DOCX 缺少必要的文档部件")
  signal?.throwIfAborted()
  return checked.generateAsync({ type: "nodebuffer", compression: "STORE" })
}
