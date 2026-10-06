/**
 * 正式 DOCX 导入链路回归：覆盖 XML 列表/公式语义、资源组装、文件入口与 Worker 结束协议。
 * 合成部件从有效归档替换局部 XML，集中验证源语义的边界，不依赖编辑器视觉样式。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { imageSize } from "image-size"
import { convertDocxImport } from "../src/pages/editor/tools/docx-import-converter.js"
import { createDocxImportRecord, runDocxImportWorker } from "../src/pages/editor/tools/docx-import-session.js"
import { readDocxDocument } from "../src/pages/editor/tools/docx-import-file.js"
import { readDocxFormula } from "../src/pages/editor/tools/docx-import-formula.js"
import { readDocxXml, WORD_XML, MATH_XML } from "../src/pages/editor/tools/docx-import-xml.js"
import { renderFormula } from "../src/pages/editor/tools/formula.js"
import { validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"

const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "DOMParser", "Node", "HTMLElement"]) globalThis[key] = DOM.window[key]
// Node 不提供真实图片解码；这里只验证尺寸传递和资源生命周期，真实解码另由浏览器专项覆盖。
let CLOSED = 0
globalThis.createImageBitmap = async blob => ({ ...imageSize(new Uint8Array(await blob.arrayBuffer())), close: () => { CLOSED += 1 } })
// 正式导出的复杂样例覆盖列表、公式、图片与表格；辅助 XML 构造器仅用于受控测试输入。
const SOURCE = new Uint8Array(await fs.readFile(new URL("../docs/m7-docx-evidence/integration/complex-portrait.docx", import.meta.url)))
// 小型 XML 构造器分别表达 run、段落和编号定义，调用方提供的字符串均为测试常量。
const TEXT = text => `<w:r><w:t>${text}</w:t></w:r>`
const PARAGRAPH = (text, properties = "") => `<w:p><w:pPr>${properties}</w:pPr>${TEXT(text)}</w:p>`
const NUMBERING = (id, level = 0) => `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr>`
const ABSTRACT = (id, levels) => `<w:abstractNum w:abstractNumId="${id}">${levels}</w:abstractNum>`
const LEVEL = (level, format = "decimal", start = 1, extra = "") => `<w:lvl w:ilvl="${level}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="%${level + 1}."/>${extra}</w:lvl>`
const INSTANCE = (id, abstract = id, extra = "") => `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstract}"/>${extra}</w:num>`
// JSON 递归查询帮助核对语义类型与正文顺序；不使用 HTML 外观作为导入成功依据。
const getNodes = (node, type) => [ ...(node.type === type ? [node] : []), ...(node.content || []).flatMap(child => getNodes(child, type)) ]
const getText = node => node.text || (node.content || []).map(getText).join("")
// 保留合法包基础与资源，替换正文/可选编号/样式部件，精确隔离一个 Word 属性组合。
const makeFile = async (body, numbering, styles) => {
  const zip = await JSZip.loadAsync(SOURCE)
  zip.file("word/document.xml", `<w:document xmlns:w="${WORD_XML}" xmlns:m="${MATH_XML}"><w:body>${body}</w:body></w:document>`)
  if (numbering !== undefined) zip.file("word/numbering.xml", `<w:numbering xmlns:w="${WORD_XML}">${numbering}</w:numbering>`)
  if (styles !== undefined) zip.file("word/styles.xml", `<w:styles xmlns:w="${WORD_XML}">${styles}</w:styles>`)
  return zip.generateAsync({ type: "uint8array" })
}
// 直接组合正式转换与记录组装，绕过 UI 但保留图片、公式、文档及 Schema 的生产校验。
const importFile = async source => createDocxImportRecord(await convertDocxImport(source), "正式导入")

// 一项可以包含后续普通段落和混合子列表，验证 XML 元信息重建没有按 Mammoth 分组丢失边界。
test("Word 正式转换保留 3 起编号、独立 A 列表、多段项和混合嵌套", async () => {
  const original = SOURCE.slice()
  const { record, warnings } = await importFile(SOURCE)
  assert.deepEqual(SOURCE, original)
  assert.equal(validateDocument(record.document), record.document)
  const lists = getNodes(record.document.content, "orderedList")
  assert.equal(lists[0].attrs.start, 3)
  assert.equal(lists[0].content.length, 2)
  assert.equal(lists[0].content[0].content[1].type, "paragraph")
  assert.equal(lists[0].content[0].content[2].type, "bulletList")
  assert.match(getText(lists[0].content[1]), /继续为四/)
  assert.equal(lists[1].attrs.type, "A")
  assert.equal(lists[1].attrs.start, 1)
  assert.equal(getNodes(record.document.content, "heading").length, 2)
  assert.ok(warnings.some(warning => warning.includes("多段列表项")))
})

// 公式不仅要有 LaTeX，还要能由编辑器渲染并再次生成 OMML，防止占位符或文字伪装成可编辑公式。
test("Word 分式、上下限和矩阵转为可编辑公式，再导出仍含 OMML", async () => {
  const { record } = await importFile(SOURCE)
  assert.equal(getNodes(record.document.content, "inlineMath").length, 1)
  assert.equal(getNodes(record.document.content, "blockMath").length, 2)
  const formulas = [...getNodes(record.document.content, "inlineMath"), ...getNodes(record.document.content, "blockMath")]
  assert.match(formulas[1].attrs.latex, /\\frac/)
  assert.match(formulas[2].attrs.latex, /\\begin\{matrix\}/)
  for (const formula of formulas) await renderFormula(formula.attrs.latex)
  const exported = await createDocumentDocx(record.document, record.assets)
  const zip = await JSZip.loadAsync(await exported.blob.arrayBuffer())
  const xml = readDocxXml(await zip.file("word/document.xml").async("string"), "result")
  assert.equal(xml.getElementsByTagNameNS(MATH_XML, "oMath").length, 3)
})

// 编号身份与连续显示区间是不同概念：中断后的同 numId 续编，新实例即使共用抽象定义也重新计数。
test("同一编号被正文打断后续编，不同实例重新开始", async () => {
  const source = await makeFile(PARAGRAPH("一", NUMBERING(10)) + PARAGRAPH("二", NUMBERING(10)) + PARAGRAPH("正文") + PARAGRAPH("三", NUMBERING(10)) + PARAGRAPH("独立", NUMBERING(11)), ABSTRACT(1, LEVEL(0)) + INSTANCE(10, 1) + INSTANCE(11, 1))
  const { record } = await importFile(source)
  const lists = getNodes(record.document.content, "orderedList")
  assert.deepEqual(lists.map(list => list.attrs.start), [1, 3, 1])
  assert.deepEqual(lists.map(list => list.content.length), [2, 1, 1])
})

// 编号可能藏在 basedOn 基类中，实例 startOverride 必须覆盖抽象起点，不能仅检查段落直接属性。
test("继承样式的编号属性、起点覆盖和罗马数字保留", async () => {
  const source = await makeFile(PARAGRAPH("罗马七", '<w:pStyle w:val="Child"/>'), ABSTRACT(1, LEVEL(0, "upperRoman", 2)) + INSTANCE(10, 1, '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride>'), '<w:style w:styleId="Base"><w:pPr>' + NUMBERING(10) + '</w:pPr></w:style><w:style w:styleId="Child"><w:basedOn w:val="Base"/></w:style>')
  const list = getNodes((await importFile(source)).record.document.content, "orderedList")[0]
  assert.equal(list.attrs.start, 7)
  assert.equal(list.attrs.type, "I")
})

// 分别核对默认重启与显式永不重启，确保父项推进时不是一律重置所有子计数。
test("父级推进重置子级，lvlRestart=0 继续计数", async () => {
  for (const [extra, starts] of [["", [1, 1]], ['<w:lvlRestart w:val="0"/>', [1, 2]]]) {
    const source = await makeFile(PARAGRAPH("父一", NUMBERING(1)) + PARAGRAPH("子一", NUMBERING(1, 1)) + PARAGRAPH("父二", NUMBERING(1)) + PARAGRAPH("子二", NUMBERING(1, 1)), ABSTRACT(1, LEVEL(0) + LEVEL(1, "lowerLetter", 1, extra)) + INSTANCE(1))
    const lists = getNodes((await importFile(source)).record.document.content, "orderedList")
    assert.deepEqual(lists.slice(1).map(list => list.attrs.start), starts)
  }
})

// 无法等价表示的编号定义必须停止导入，不能改成普通数字后交付错误编号。
test("复合编号、样式链接、负数起点和缺失定义明确拒绝", async () => {
  const definitions = [
    ABSTRACT(1, LEVEL(0).replace("%1.", "%1.%2.")) + INSTANCE(1),
    '<w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="Other"/></w:abstractNum>' + INSTANCE(1),
    ABSTRACT(1, LEVEL(0, "decimal", -1)) + INSTANCE(1), ""
  ]
  for (const definition of definitions) await assert.rejects(importFile(await makeFile(PARAGRAPH("不能改号", NUMBERING(1)), definition)), /编号/)
})

// 用独立小 OMML 树覆盖各语义构造，最后实际渲染 LaTeX，检查映射结果可被公式引擎消费。
test("Word 数学结构覆盖根式、组合上下标、大运算符、重音与括号", async () => {
  const run = text => `<m:r><m:t>${text}</m:t></m:r>`
  const cases = [
    `<m:rad><m:deg>${run("3")}</m:deg><m:e>${run("x")}</m:e></m:rad>`,
    `<m:sSubSup><m:e>${run("x")}</m:e><m:sub>${run("i")}</m:sub><m:sup>${run("2")}</m:sup></m:sSubSup>`,
    `<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${run("i=1")}</m:sub><m:sup>${run("n")}</m:sup><m:e>${run("i")}</m:e></m:nary>`,
    `<m:acc><m:accPr><m:chr m:val="⃗"/></m:accPr><m:e>${run("x")}</m:e></m:acc>`,
    `<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>${run("a+b")}</m:e></m:d>`,
    run("x_{}%&#92;alpha")
  ]
  for (const source of cases) {
    const xml = readDocxXml(`<m:oMath xmlns:m="${MATH_XML}">${source}</m:oMath>`, "formula")
    const latex = readDocxFormula(xml.documentElement)
    await renderFormula(latex)
  }
})

// 未知正文与未知属性都可能改变公式语义；整体拒绝比只保留已识别文字更能保证没有局部符号缺失。
test("未知或超限整式拒绝，不从 textContent 拼出错误公式", () => {
  for (const source of ["<m:box><m:e><m:r><m:t>x</m:t></m:r></m:e></m:box>", `<m:r><m:t>${"x".repeat(2001)}</m:t></m:r>`, "<m:f><m:num><m:r><m:t>x</m:t></m:r></m:num></m:f>"]) {
    assert.throws(() => readDocxFormula(readDocxXml(`<m:oMath xmlns:m="${MATH_XML}">${source}</m:oMath>`, "math").documentElement), /公式/)
  }
  const unknown = [
    "<m:r><m:rPr><m:nor/></m:rPr><m:t>normal text</m:t></m:r>",
    "<m:f><m:fPr><m:unknown/></m:fPr><m:num/><m:den/></m:f>",
    "<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:unknown/></m:mcPr></m:mc></m:mcs></m:mPr><m:mr><m:e/></m:mr></m:m>"
  ]
  for (const source of unknown) assert.throws(() => readDocxFormula(readDocxXml(`<m:oMath xmlns:m="${MATH_XML}">${source}</m:oMath>`, "math").documentElement), /公式/)
})

// 转换器会消除续格，只有空续格才可略过；非空续格必须拒绝以免隐藏正文永久消失。
test("纵向合并续格只允许空占位，不静默丢掉其中正文", async () => {
  const source = await makeFile('<w:tbl><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>' + PARAGRAPH("开始") + "</w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>" + PARAGRAPH("隐藏正文") + "</w:tc></w:tr></w:tbl>")
  await assert.rejects(importFile(source), /续格包含正文/)
})

// 多处引用可共享一个资产；解码后发生取消也必须关闭位图，且不能返回半成品记录。
test("Word 图片去重、合并及真实解码接口清理，取消不返回记录", async () => {
  const converted = await convertDocxImport(SOURCE)
  const closed = CLOSED
  const { record } = await createDocxImportRecord(converted, "图表")
  assert.equal(CLOSED, closed + 1)
  assert.equal(record.assets.size, 1)
  assert.equal(getNodes(record.document.content, "image").length, 2)
  assert.equal(getNodes(record.document.content, "table").length, 2)
  const decode = globalThis.createImageBitmap
  const controller = new AbortController()
  globalThis.createImageBitmap = async blob => {
    const image = await decode(blob)
    controller.abort()
    return image
  }
  try { await assert.rejects(createDocxImportRecord(converted, "取消", controller.signal), { name: "AbortError" }) }
  finally { globalThis.createImageBitmap = decode }
  assert.equal(CLOSED, closed + 2)
})

// 轻量文件入口应在任何 Worker/重型模块任务前挡住不合格输入，已取消任务也不能继续。
test("DOCX 文件类型与大小先校验，不创建转换 Worker", async () => {
  await assert.rejects(readDocxDocument(new File(["x"], "旧文档.doc")), /\.docx/)
  await assert.rejects(readDocxDocument(new File([], "空.docx")), /不能为空/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(readDocxDocument(new File([SOURCE], "valid.docx"), controller.signal), { name: "AbortError" })
})

// 用 Worker 替身触发不同协议结局，验证每个任务只终止一次并清除事件处理器。
test("Worker 成功、错误、传输失败、取消均销毁且清理监听", async () => {
  const previous = globalThis.Worker
  const workers = []
  // 不执行真实转换，仅记录发送数据与终止次数，便于精确控制异步消息和错误的时机。
  class TestWorker {
    constructor() { workers.push(this) }
    terminate() { this.terminated = (this.terminated || 0) + 1 }
    postMessage(bytes, transfer) { this.bytes = bytes
      this.transfer = transfer }
  }
  globalThis.Worker = TestWorker
  try {
    const success = runDocxImportWorker(new ArrayBuffer(1))
    workers.at(-1).onmessage({ data: { result: { html: "success" } } })
    assert.equal((await success).html, "success")
    for (const event of ["onerror", "onmessageerror"]) {
      const failed = runDocxImportWorker(new ArrayBuffer(1))
      workers.at(-1)[event]()
      await assert.rejects(failed, /Word/)
    }
    const controller = new AbortController()
    const cancelled = runDocxImportWorker(new ArrayBuffer(1), controller.signal)
    controller.abort()
    await assert.rejects(cancelled, { name: "AbortError" })
    assert.ok(workers.every(worker => worker.terminated === 1 && worker.onmessage === null && worker.onerror === null))
  } finally { globalThis.Worker = previous }
})

// 手动触发计时器与同步发送异常，覆盖没有 Worker 消息也必须收口的路径；finally 还原全局替身。
test("Worker 超时和 postMessage 抛错也收口", async () => {
  const previousWorker = globalThis.Worker
  const previousTimeout = globalThis.setTimeout
  let timeout
  let terminated = 0
  globalThis.Worker = class {
    postMessage() {}
    terminate() { terminated += 1 }
  }
  globalThis.setTimeout = (callback, delay) => { assert.equal(delay, 30000)
    timeout = callback
    return 0 }
  try {
    const task = runDocxImportWorker(new ArrayBuffer(1))
    timeout()
    await assert.rejects(task, /30 秒/)
    globalThis.Worker.prototype.postMessage = () => { throw new Error("传输失败") }
    await assert.rejects(runDocxImportWorker(new ArrayBuffer(1)), /传输失败/)
    assert.equal(terminated, 2)
  } finally { globalThis.Worker = previousWorker
    globalThis.setTimeout = previousTimeout }
})
