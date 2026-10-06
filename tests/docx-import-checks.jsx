/**
 * Word 导入的浏览器验收连接真实 Worker、图片解码、预览弹窗与父级保存后切换流程。
 * 验证坏包/坏图拒绝、取消卸载清理、保存失败保留预览，以及修复后只执行一次导入。
 */
import ReactDOM from "react-dom"
import JSZip from "jszip"
import { DocxImportAction } from "../src/pages/editor/components/DocxImportAction.jsx"
import { FileActions } from "../src/pages/editor/components/FileActions.jsx"
import { EditorContext } from "../src/pages/editor/components/EditorProvider.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { readDocxDocument } from "../src/pages/editor/tools/docx-import-file.js"
import { runDocxImportWorker } from "../src/pages/editor/tools/docx-import-session.js"
import { createComplexDocxDocument } from "./docx-fixture.js"

const assert = (value, message) => { if (!value) throw new Error(message) }
// 轮询真实 Worker、转换预览与 portal 状态；固定超时防止缺失回调让整组验收无限等待。
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}
// 递归提取转换后的指定节点，用结构断言验证列表、公式和表格，而不是只比较纯文本。
const getNodes = (node, type) => [...(node.type === type ? [node] : []), ...(node.content || []).flatMap(child => getNodes(child, type))]
// 按标准化按钮文案查找真实入口，避免依赖 AntD 内部 wrapper 的固定层级。
const button = (host, text) => [...host.querySelectorAll("button")].find(node => node.textContent.replace(/\s/g, "") === text.replace(/\s/g, ""))

export async function runDocxImportChecks(report) {
  const check = async (name, action) => {
    try { await action(); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
  }
  // 保存原生接口并用计数包装 Worker/Bitmap，保留实际转换与解码，只观察资源是否全部回收。
  const nativeWorker = window.Worker
  const nativeDecode = window.createImageBitmap
  let workers = 0
  let closed = 0
  // Worker 终止计数只减一次，防止重复清理让资源断言误报为已全部回收。
  window.Worker = class extends nativeWorker {
    constructor(...args) { super(...args); workers += 1 }
    terminate() {
      if (!this.ended) { workers -= 1; this.ended = true }
      super.terminate()
    }
  }
  window.createImageBitmap = async (...args) => {
    const image = await nativeDecode(...args)
    const close = image.close.bind(image)
    image.close = () => { closed += 1; close() }
    return image
  }
  // 生成可解码 PNG 和附件，再用复杂 Word fixture 覆盖编号、合并单元格与公式等转换内容。
  const canvas = document.createElement("canvas")
  canvas.width = 32
  canvas.height = 16
  canvas.getContext("2d").fillRect(0, 0, 32, 16)
  const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
  const attachment = new Blob(["导入检查附件"], { type: "text/plain" })
  const entries = [{ id: "m5-image", fileName: "图片.png", mimeType: png.type, byteLength: png.size, blob: png }, { id: "m5-attachment", kind: "attachment", fileName: "说明.txt", mimeType: attachment.type, byteLength: attachment.size, blob: attachment }]
  const source = createComplexDocxDocument({ ...createDocument(), assets: entries.map(({ blob: _blob, ...metadata }) => metadata) })
  const host = document.createElement("div")
  document.body.append(host)
  const dialog = () => document.querySelector('[role="dialog"][aria-labelledby]')
  // 使用真实导入按钮等待弹窗，而不是直接调用回调，覆盖 UI 中的草稿/预览生命周期。
  const open = async () => {
    button(host, "导入 Word").click()
    return waitFor(dialog, "导入弹窗未出现")
  }
  // 替换原生 files 后触发 change 模拟选文件；读取、Worker 和类型校验仍走生产流程。
  const choose = file => {
    const input = document.querySelector('input[aria-label="选择 Word 文件"]')
    Object.defineProperty(input, "files", { configurable: true, value: [file] })
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }
  // 等待纯文本预览实际出现，再允许测试点击确认，避免转换未完成时误测禁用按钮。
  const ready = () => waitFor(() => document.querySelector('textarea[aria-label="Word 导入正文预览"]') || (dialog()?.querySelector('[role="alert"]')?.textContent?.includes("失败") ? false : null), "导入预览未生成")
  // 卸载后确认 portal 消失，旧异步任务不会和下一轮弹窗查询混在一起。
  const unmount = async () => {
    ReactDOM.unmountComponentAtNode(host)
    await waitFor(() => !dialog(), "旧弹窗未卸载")
  }
  try {
    const exported = await createDocumentDocx(source, new Map(entries.map(entry => [entry.id, entry])))
    const file = new File([exported.blob], "Word 浏览器导入验收.docx")
    await check("Word 导入：真实 Worker、编号、合并、公式和 Bitmap 释放", async () => {
      const before = closed
      const { record } = await readDocxDocument(file)
      assert(getNodes(record.document.content, "orderedList")[0].attrs.start === 3, "起始编号未保留")
      assert(getNodes(record.document.content, "blockMath").length === 2, "块公式未保留")
      assert(getNodes(record.document.content, "table").length === 2 && record.assets.size === 1, "表格或图片错误")
      assert(workers === 0 && closed === before + 1, "Worker 或 Bitmap 未释放")
    })
    await check("Word 导入：取消真实 Worker 后可重试", async () => {
      // 单独取消真实 Worker 任务并重试，确认信号能终止线程且不污染后续导入。
      const controller = new AbortController()
      const task = runDocxImportWorker(await file.arrayBuffer(), controller.signal)
      assert(workers === 1, "Worker 未创建")
      controller.abort()
      let cancelled = false
      try { await task } catch (error) { cancelled = error.name === "AbortError" }
      assert(cancelled && workers === 0, "取消没有终止 Worker")
      assert((await readDocxDocument(file)).record.assets.size === 1, "取消后不能重试")
    })
    await check("Word 导入：PNG、JPEG、WebP 真实解码，坏图拒绝", async () => {
      // 在有效 Word 包中替换图片字节和 MIME 元信息，分别覆盖浏览器支持类型与实际坏图拒绝。
      const zip = await JSZip.loadAsync(await file.arrayBuffer())
      const media = Object.values(zip.files).find(entry => !entry.dir && entry.name.startsWith("word/media/"))
      const types = await zip.file("[Content_Types].xml").async("string")
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg"))
      const webp = new Blob([Uint8Array.from(atob("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="), value => value.charCodeAt(0))], { type: "image/webp" })
      for (const blob of [jpeg, webp]) {
        zip.file(media.name, await blob.arrayBuffer())
        zip.file("[Content_Types].xml", types.replaceAll("image/png", blob.type))
        const changed = new File([await zip.generateAsync({ type: "arraybuffer" })], "图片.docx")
        const { record } = await readDocxDocument(changed)
        assert([...record.assets.values()][0].mimeType === blob.type, "图片类型未保留")
      }
      zip.file(media.name, await png.slice(0, 24).arrayBuffer())
      zip.file("[Content_Types].xml", types)
      let rejected = false
      try { await readDocxDocument(new File([await zip.generateAsync({ type: "arraybuffer" })], "坏图.docx")) } catch { rejected = true }
      assert(rejected && workers === 0, "坏图没有拒绝或 Worker 未释放")
    })
    await check("Word 导入：取消预览不调用导入，失败文件可重新选择", async () => {
      let imports = 0
      ReactDOM.render(<DocxImportAction onImport={() => { imports += 1 }} />, host)
      await open()
      choose(new File(["bad"], "坏文件.docx"))
      await waitFor(() => dialog()?.textContent.includes("无法读取 Word 文件"), "坏包未提示")
      choose(file)
      await ready()
      button(dialog(), "取消").click()
      await waitFor(() => !dialog(), "取消后仍有弹窗")
      assert(imports === 0, "取消仍导入")
    })
    await unmount()
    await check("Word 导入：保存失败保留旧会话，重试成功后才创建资源 URL", async () => {
      // 用可切换保存结果验证导入契约：保存失败保留旧会话，重试成功才创建新资源 URL。
      let saved = false
      let saves = 0
      let changed = null
      const state = { readOnly: false, updateView: () => {} }
      ReactDOM.render(<EditorContext.Provider value={{ editor: { setEditable: () => {} }, store: { getState: () => state }, uploading: false, saveDocument: async () => { saves += 1; return saved } }}>
        <FileActions onDocumentChange={record => { changed = record }} />
      </EditorContext.Provider>, host)
      await open()
      choose(file)
      await ready()
      button(dialog(), "导入为新文档").click()
      await waitFor(() => dialog()?.textContent.includes("当前文档未能保存"), "保存失败未提示")
      assert(!changed && saves === 1, "失败仍切换会话")
      saved = true
      const confirm = button(dialog(), "导入为新文档")
      confirm.click()
      confirm.click()
      await waitFor(() => changed, "重试后未切换")
      assert(saves === 2 && changed.assets.size === 1, "重复提交或资源丢失")
      changed.assets.forEach(asset => URL.revokeObjectURL(asset.url))
    })
    await unmount()
    await check("Word 导入：组件卸载中止旧任务，迟到结果不复活", async () => {
      ReactDOM.render(<DocxImportAction onImport={() => { throw new Error("不应导入") }} />, host)
      await open()
      choose(file)
      await waitFor(() => workers > 0, "未进入 Worker 阶段")
      await unmount()
      await new Promise(resolve => setTimeout(resolve, 200))
      assert(!dialog() && workers === 0, "卸载后仍有旧任务")
    })
  // 无论中途失败都卸载 UI、恢复 Worker/Bitmap 接口并清空 Canvas，避免验收污染浏览器全局环境。
  } finally {
    ReactDOM.unmountComponentAtNode(host)
    host.remove()
    window.Worker = nativeWorker
    window.createImageBitmap = nativeDecode
    canvas.width = 0
    canvas.height = 0
  }
}
