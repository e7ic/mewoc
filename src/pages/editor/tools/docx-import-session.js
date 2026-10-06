/**
 * DOCX 导入的主线程会话层：调度一次性 Worker，再验证浏览器资源和编辑器 Schema。
 * 最终产物为独立的新文档记录与预览；所有检查通过之前不进入当前文档或持久化仓库。
 */
import { getSchema, generateText } from "@tiptap/core"
import { createExtensions } from "./create-extensions.js"
import { validatePageSettings } from "./page-settings.js"
import { createDocument, validateDocument } from "./document-schema.js"
import { renderFormula } from "./formula.js"
import { createDocxImportContent } from "./docx-import-content.js"

/** 读取 File 字节并提交后台转换，文件名去扩展名后作为候选标题；取消可阻止下一阶段启动。 */
export async function readDocxSession(file, signal) {
  const bytes = await file.arrayBuffer()
  signal?.throwIfAborted()
  const converted = await runDocxImportWorker(bytes, signal)
  return createDocxImportRecord(converted, file.name.replace(/\.docx$/i, ""), signal)
}

// 一次转换一个 Worker，成功、报错、取消和 30 秒超时统一销毁，压缩包解析不能卡住编辑器主线程。
export function runDocxImportWorker(bytes, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./docx-import-worker.js", import.meta.url), { type: "module" })
    let finished = false
    // 成功、异常、取消及超时共用幂等收口，始终清理计时器/监听并释放 Worker。
    const finish = (error, result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(signal.reason)
    const timer = setTimeout(() => finish(new Error("Word 转换超过 30 秒，已停止，请拆分文档后重试")), 30000)
    // 明确区分业务失败、合法结果与无效协议消息，避免把缺失数据当作成功返回。
    worker.onmessage = event => {
      if (event.data.error) finish(new Error(event.data.error))
      else if (event.data.result) finish(null, event.data.result)
      else finish(new Error("Word 转换结果无效，请重试"))
    }
    worker.onerror = () => finish(new Error("Word 转换程序未能运行，请刷新后重试"))
    worker.onmessageerror = () => finish(new Error("Word 转换结果无法读取，请重试"))
    // 先注册再复查 signal，覆盖 Worker 创建过程中刚好取消的窗口。
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    // 转移缓冲区所有权，避免主线程与 Worker 各持有一份大文件；发送失败也走统一清理。
    try { worker.postMessage(bytes, [bytes]) }
    catch (error) { finish(error) }
  })
}

/**
 * 将转换结果组装成可载入的记录：实际解码图片、预渲染公式、构造 JSON 并执行文档/Schema 校验。
 * assets 保存 Blob，document.assets 只保存持久化元数据，preview 由最终内容生成。
 */
export async function createDocxImportRecord(converted, title, signal) {
  signal?.throwIfAborted()
  const document = createDocument()
  // 在图片解码等工作之前复验 Worker 返回的元信息；独立克隆防止预览来源被后续草稿改写。
  // 旧转换结果没有 page 时沿用原默认值，显式损坏的 page 不允许作为缺省值略过。
  if (converted.page !== undefined) document.page = structuredClone(validatePageSettings(converted.page))
  // 占位 src 到节点尺寸的映射与 assetId 到 Blob 的映射分开，JSON 中不混入临时资源键或 Blob。
  const images = new Map()
  const assets = new Map()
  for (const image of converted.images) {
    let bitmap
    try { bitmap = await createImageBitmap(image.blob) }
    catch { throw new Error("Word 图片无法解码，请更换图片后重试") }
    try {
      signal?.throwIfAborted()
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000) throw new Error("图片尺寸无效或过大，请缩小后重试")
      // 仅限制导入后的显示尺寸并保持比例，资源 Blob 继续保存原图，避免缩放损坏原始备份。
      const ratio = Math.min(1, 520 / bitmap.width, 20000 / bitmap.height)
      images.set(image.key, { id: image.id, width: Math.max(1, Math.round(bitmap.width * ratio)), height: Math.max(1, Math.round(bitmap.height * ratio)) })
      const { key: _key, ...asset } = image
      assets.set(image.id, asset)
    // 即使取消或尺寸检查失败也关闭已解码位图，不让临时像素资源滞留。
    } finally { bitmap.close() }
  }
  // 在建立记录前逐个验证编辑器能渲染该公式；失败时不允许以部分公式缺失的文档继续。
  for (const formula of converted.formulas) {
    signal?.throwIfAborted()
    try { await renderFormula(formula.latex, formula.type === "blockMath") }
    catch { throw new Error("部分 Word 公式无法在编辑器中完整渲染，已停止导入，请保留原文件") }
  }
  const warnings = new Set(converted.warnings)
  document.title = title.slice(0, 100) || "Word 文档"
  document.content = createDocxImportContent(converted.html, images, converted.paragraphs, converted.formulas, warnings)
  document.assets = [...assets.values()].map(({ blob: _blob, ...metadata }) => metadata)
  // 业务校验后再按编辑器 Schema 规范化默认属性/标记顺序，确保预览与真正载入的一致性。
  validateDocument(document)
  document.content = getSchema(createExtensions()).nodeFromJSON(document.content).toJSON()
  signal?.throwIfAborted()
  return { record: { document, assets, storageVersion: 0 }, warnings: [...warnings], preview: generateText(document.content, createExtensions()) }
}
