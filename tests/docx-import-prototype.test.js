/**
 * Node 导入原型的范围与保真回归：检查受支持的图文表格、实际编辑/持久化往返以及明确拒绝项。
 * 原型能力边界独立于正式导入，测试不据此声称浏览器 Worker、真实图片解码或生产 UI 已通过。
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import JSZip from "jszip"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { readDocxPrototype } from "./docx-import-prototype/read.js"
import { createDocxContent } from "./docx-import-prototype/html-content.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { validateDocument } from "../src/pages/editor/tools/document-schema.js"

// 给真实 Tiptap 与便携文件 IO 提供 DOM 环境；跨 realm Blob/FileReader 的读取边界另用字节替身适配。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
// Node Blob 与 jsdom FileReader 来自不同 realm，用真实 Blob 字节实现测试环境的浏览器边界。
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(bytes => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`
      this.onload()
    }, () => this.onerror())
  }
}
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const SOURCE = await fs.readFile(new URL("../docs/m7-docx-evidence/portrait.docx", import.meta.url))
// 递归取目标类型与文字，以正文 JSON 断言结构和资源引用，不依赖原型 HTML 作为成功快照。
const getNodes = (content, type) => {
  const result = []
  const visit = node => {
    if (node.type === type) result.push(node)
    node.content?.forEach(visit)
  }
  visit(content)
  return result
}
const getText = node => node.type === "text" ? node.text : (node.content || []).map(getText).join("")
// 每次重新载入基础 ZIP 并仅应用当前场景修改，防止前一个失败用例污染后续输入。
const createArchive = async (change, source = SOURCE) => {
  const zip = await JSZip.loadAsync(source)
  await change(zip)
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}
// 构造最小受支持 Word 主文档，供危险节点/缺失正文场景使用，包的其它必需部件保留。
const addBody = (zip, content) => zip.file("word/document.xml", `<w:document xmlns:w="${WORD}"><w:body>${content}</w:body></w:document>`)

// 重复导入必须产生独立文档身份，且不改原 Buffer；正文合法与表头/标记数量一起验证。
test("DOCX 原型读取已有图文表格，独立记录且原 Buffer 不变", async () => {
  const copy = Buffer.from(SOURCE)
  const first = await readDocxPrototype(SOURCE, "导入样本")
  const second = await readDocxPrototype(SOURCE, "导入样本")
  assert.deepEqual(SOURCE, copy)
  assert.notEqual(first.record.document.id, second.record.document.id)
  assert.equal(first.record.storageVersion, 0)
  assert.equal(first.record.assets.size, 1)
  assert.equal(validateDocument(first.record.document), first.record.document)
  assert.equal(getNodes(first.record.document.content, "tableCell").length, 6)
  assert.equal(getNodes(first.record.document.content, "tableHeader").length, 3)
  assert.match(getText(first.record.document.content), /中文与 English/)
  assert.ok(getNodes(first.record.document.content, "text").some(node => node.marks?.some(mark => mark.type === "underline")))
  assert.ok(first.warnings.some(warning => warning.includes("分页")))
})

// 先去掉本原型明确不支持的公式，单独核对合并表格/嵌套内容和编号降级提示，避免混淆拒绝原因。
test("DOCX 复杂列表、合并与嵌套表格按语义转换并声明编号限制", async () => {
  const complex = await fs.readFile(new URL("../docs/m7-docx-evidence/integration/complex-portrait.docx", import.meta.url))
  // 原生公式属于明确拒绝范围，此夹具只移除公式以单独验证其余复杂结构。
  const source = await createArchive(async zip => {
    const dom = new JSDOM(await zip.file("word/document.xml").async("string"), { contentType: "text/xml" })
    for (const formula of [...dom.window.document.getElementsByTagNameNS("http://schemas.openxmlformats.org/officeDocument/2006/math", "oMath")]) formula.remove()
    zip.file("word/document.xml", dom.serialize())
    dom.window.close()
  }, complex)
  const { record, warnings } = await readDocxPrototype(source)
  assert.equal(record.assets.size, 1)
  assert.equal(getNodes(record.document.content, "image").length, 2)
  assert.equal(getNodes(record.document.content, "table").length, 2)
  const cells = getNodes(record.document.content, "tableCell")
  assert.ok(cells.some(cell => cell.attrs.rowspan === 2))
  assert.ok(cells.some(cell => cell.attrs.colspan === 2))
  assert.equal(getNodes(record.document.content, "tableHeader").length, 3)
  assert.ok(getNodes(record.document.content, "bulletList").length)
  assert.equal(getNodes(record.document.content, "orderedList")[0].attrs.start, 1)
  assert.ok(warnings.some(warning => warning.includes("起始编号")))
  assert.match(getText(record.document.content), /内甲内乙/)
})

// 原型没有公式恢复机制，遇 OMML 应整体拒绝，不能依赖 Mammoth 的忽略行为产生缺公式文档。
test("DOCX 原生公式拒绝导入，避免转换器静默丢弃", async () => {
  const source = await fs.readFile(new URL("../docs/m7-docx-evidence/integration/complex-portrait.docx", import.meta.url))
  await assert.rejects(readDocxPrototype(source), /原生公式/)
})

// 使用实际 Editor 插入内容，再经便携保存/恢复和正式导出，证明不仅能读取也能继续编辑和完整保存图片。
test("DOCX 导入后真实编辑器修改、便携保存重读、再次导出保持文字和图片", async () => {
  const { record } = await readDocxPrototype(SOURCE)
  const editor = new Editor({ extensions: createExtensions(), content: record.document.content })
  try {
    editor.commands.insertContentAt(1, "往返编辑成功：")
    record.document.content = editor.getJSON()
    const portable = await createPortableFile(record.document, record.assets)
    const restored = await readPortableFile(new File([JSON.stringify(portable)], "roundtrip.mewoc.json"))
    assert.match(getText(restored.document.content), /往返编辑成功/)
    assert.equal(restored.assets.size, record.assets.size)
    for (const [id, asset] of restored.assets) assert.deepEqual(new Uint8Array(await asset.blob.arrayBuffer()), new Uint8Array(await record.assets.get(id).blob.arrayBuffer()))
    const output = await createDocumentDocx(restored.document, restored.assets)
    const zip = await JSZip.loadAsync(await output.blob.arrayBuffer())
    assert.match(await zip.file("word/document.xml").async("string"), /往返编辑成功/)
    assert.equal(Object.values(zip.files).filter(entry => !entry.dir && entry.name.startsWith("word/media/")).length, 1)
  } finally { editor.destroy() }
})

// 受控 HTML 转 JSON 不应碰当前页面；安全链接可保留，脚本或未知图片源不能被激活或悄悄跳过。
test("DOCX 危险链接降为文字，转换 HTML 不注入页面", async () => {
  const before = document.body.innerHTML
  const warnings = new Set()
  const content = createDocxContent('<p><a href="javascript:alert(1)">危险</a><a href="https://example.com/">安全</a><strong onclick="alert(1)">粗体</strong></p>', new Map(), warnings)
  assert.equal(getNodes(content, "text").flatMap(node => node.marks || []).filter(mark => mark.type === "link").length, 1)
  assert.match(getText(content), /javascript:alert/)
  assert.equal(document.body.innerHTML, before)
  assert.throws(() => createDocxContent("<p><script>bad()</script></p>", new Map(), warnings), /不支持/)
  assert.throws(() => createDocxContent('<p><img src="https://example.com/x.png"></p>', new Map(), warnings), /图片引用缺失/)
})

// 外部关系即使隐藏在非主部件也要拒绝，防止转换器随后访问 file 或网络目标。
test("DOCX 外部图片关系不访问网络或本地文件", async () => {
  const source = await createArchive(zip => zip.file("word/_rels/external.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="file:///private/tmp/no-read.png"/></Relationships>'))
  await assert.rejects(readDocxPrototype(source), /外部图片/)
})

// 既检查资源关系能读到图片，也检查真实签名，不能只按 MIME 声明接受伪图或缺图结果。
test("DOCX 图片文件缺失和伪造签名均拒绝，不交付缺图结果", async () => {
  const missing = await createArchive(zip => Object.keys(zip.files).filter(name => name.startsWith("word/media/")).forEach(name => zip.remove(name)))
  await assert.rejects(readDocxPrototype(missing), /转换失败/)
  const forged = await createArchive(zip => Object.values(zip.files).filter(entry => !entry.dir && entry.name.startsWith("word/media/")).forEach(entry => zip.file(entry.name, "not an image")))
  await assert.rejects(readDocxPrototype(forged), /图片内容与文件类型不一致/)
})

// 扩展名和 ZIP 可读取不足以证明合法 DOCX，缺部件、超限和规范化前路径异常都要被拦住。
test("DOCX 坏包、必要部件缺失、路径穿越拒绝", async () => {
  await assert.rejects(readDocxPrototype(Buffer.from("not zip")), /压缩包/)
  await assert.rejects(readDocxPrototype(Buffer.alloc(32 * 1024 * 1024 + 1)), /32 MiB/)
  await assert.rejects(readDocxPrototype(await createArchive(zip => zip.remove("word/document.xml"))), /必要/)
  await assert.rejects(readDocxPrototype(await createArchive(zip => zip.file("../outside.txt", "no"))), /异常路径/)
})

// 将解析危险、未知语义和原型外页内容分别注入部件，确保检查覆盖整个包而非只正文文本。
test("DOCX 实体声明、超深 XML、宏、修订与非空页眉拒绝", async () => {
  const cases = [
    [zip => zip.file("word/document.xml", '<!DOCTYPE document [<!ENTITY x "hidden">]><document>&x;</document>'), /实体/],
    [zip => zip.file("word/document.xml", "<x>".repeat(70) + "</x>".repeat(70)), /过深/],
    [zip => zip.file("word/vbaProject.bin", "macro"), /宏/],
    [zip => addBody(zip, "<w:ins><w:p><w:r><w:t>修订内容</w:t></w:r></w:p></w:ins>"), /ins/],
    [zip => zip.file("word/header1.xml", `<w:hdr xmlns:w="${WORD}"><w:p><w:r><w:t>重要页眉</w:t></w:r></w:p></w:hdr>`), /页眉/]
  ]
  for (const [change, pattern] of cases) await assert.rejects(readDocxPrototype(await createArchive(change)), pattern)
})

// 高压缩比样例的压缩字节很少，测试证明限额按实际流式展开量判断，而非 ZIP 声明或压缩大小。
test("DOCX 按实际解压字节限额，高压缩比文件提前拒绝", async () => {
  const source = await createArchive(zip => zip.file("huge.txt", "x".repeat(8 * 1024 * 1024 + 1)))
  assert.ok(source.length < 100000)
  await assert.rejects(readDocxPrototype(source), /展开内容超过/)
})

// 分别取消未开始和正在解压的任务，再重试同输入，核对取消清理不会损坏可复用源数据。
test("DOCX 取消前和展开中均停止返回记录，后续重试正常", async () => {
  const before = new AbortController()
  before.abort()
  await assert.rejects(readDocxPrototype(SOURCE, "test", before.signal), { name: "AbortError" })
  const during = new AbortController()
  const task = readDocxPrototype(SOURCE, "test", during.signal)
  setTimeout(() => during.abort(), 0)
  await assert.rejects(task, { name: "AbortError" })
  assert.equal((await readDocxPrototype(SOURCE)).record.assets.size, 1)
})

// HTML 容错不能替代编辑器表格合法性；缺格/越界应拒绝，DOM 深度限制也需独立覆盖。
test("DOCX 表格缺格、合并越界与 HTML 过深拒绝", () => {
  const warnings = new Set()
  for (const html of [
    '<table><tr><td rowspan="3">越界</td></tr></table>',
    "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>"
  ]) assert.throws(() => createDocxContent(html, new Map(), warnings), /表格/)
  assert.throws(() => createDocxContent("<span>".repeat(60) + "x" + "</span>".repeat(60), new Map(), warnings), /过深/)
})

// 转换器将未知元素报成 warning 时，应用仍要提升为失败，不能把正文丢失包装成成功。
test("DOCX 未识别正文元素明确拒绝，不把转换器丢弃警告当成功", async () => {
  const source = await createArchive(zip => addBody(zip, "<w:unknownContent><w:r><w:t>不能丢失</w:t></w:r></w:unknownContent>"))
  await assert.rejects(readDocxPrototype(source), /转换失败.*unrecognised/)
})
