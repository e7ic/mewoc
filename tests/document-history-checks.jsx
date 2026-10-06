/**
 * 历史版本浏览器验收覆盖检查点、资源独立性、只读预览、恢复备份、另存副本和并发冲突。
 * 真实会话在同 ID 恢复时也重建，预览 URL 生命周期和列表分页回归使用可见 UI/实际仓库核对。
 */
import { useEffect, useState } from "react"
import ReactDOM from "react-dom"
import { EditorContent } from "@tiptap/react"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { FileActions } from "../src/pages/editor/components/FileActions.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentAssetUrl } from "../src/pages/editor/tools/attachment-assets.js"
import { getDocuments, getLocalDocument, getDocumentAssets, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { getDocumentVersions, getDocumentVersion, createDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
// 有界轮询 portal、保存与历史仓库，支持异步读取条件，避免等待固定时长掩盖真实准备阶段。
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const result = await read()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}
// 主文档库、历史弹窗和恢复确认分别定位，确保操作属于对应层而不是另一个同名按钮。
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(node => node.textContent.replace(/\s/g, "") === name.replace(/\s/g, ""))
const libraryDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(node => node.querySelector('[aria-label="文档搜索"]'))
const historyDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(node => node.querySelector('[aria-label="版本说明"]'))
const preview = () => document.querySelector('[aria-label="历史版本正文"]')
const versionRow = id => historyDialog()?.querySelector(`[data-version-id="${id}"]`)
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
// 说明输入经原生 setter/input 驱动 React 草稿，textarea 与普通输入使用各自原型。
const setInput = (element, value) => {
  assert(element, "输入控件不存在")
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

// 真实 FileActions 和 EditorContent 共享一个 Provider，暴露 Context 核对恢复前后正文与编辑器身份。
function HistoryProbe({ onContext, onRecordChange }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onContext(context) }, [context, onContext])
  return <section style={{ width: 640, margin: 20 }}>
    <FileActions onDocumentChange={onRecordChange} />
    <EditorContent editor={context.editor} />
  </section>
}

// 维护额外会话序号，使恢复同 ID 也销毁旧保存队列、资源和撤销栈，覆盖生产会话边界。
function HistorySession({ initialRecord, onContext, onRecord }) {
  const [session, setSession] = useState({ record: initialRecord, id: 0 })
  const changeRecord = record => {
    onRecord(record)
    // 恢复仍然使用相同文档 ID，但必须重新建立正文、资源和保存队列会话。
    setSession(previous => ({ record, id: previous.id + 1 }))
  }
  return <EditorProvider key={`${session.record.document.id}:${session.id}`} record={session.record}>
    <HistoryProbe onContext={onContext} onRecordChange={changeRecord} />
  </EditorProvider>
}

/**
 * 真实 React 17 会话把保存队列、历史库和预览连起来；检查点正文来自编辑器实际输入。
 * 所有 fixture 使用本轮唯一标题前缀，卸载后只按精确文档 ID 清理 live/history 资源。
 */
export async function runDocumentHistoryChecks(report) {
  // 本轮随机前缀隔离文档及副本，cleanup 保存精确资源引用以便结束后清理 live/history 数据。
  const prefix = `历史版本验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const cleanup = new Map()
  const host = document.createElement("div")
  document.body.append(host)
  let current = null
  const track = record => { cleanup.set(record.document.id, { document: record.document, assets: record.assets || new Map() }); return record }
  // 卸载并确认库、历史与预览 DOM 全部消失，让旧保存和异步预览无法进入下一项场景。
  const unmount = async () => {
    ReactDOM.unmountComponentAtNode(host)
    current = null
    await waitFor(() => !historyDialog() && !libraryDialog() && !preview(), "历史版本弹窗未卸载")
  }
  // 恢复 Blob 到新会话 URL 后挂载真实组件，等待 Context 对应指定文档，再读取正文与历史。
  const mount = async record => {
    await unmount()
    record.assets.forEach(asset => { asset.url = createDocumentAssetUrl(asset) })
    ReactDOM.render(<HistorySession initialRecord={record} onContext={context => { current = context }} onRecord={track} />, host)
    return waitFor(() => current?.editor && current.documentId === record.document.id && current, "真实编辑器会话未就绪")
  }
  // 先持久化带可选图片/附件的原记录，后续检查点能从真实存储版本复制资源而非未保存草稿。
  const seed = async (title, text = title, assets = new Map()) => {
    const document = { ...createDocument(), title: `${prefix}-${title}`, content: { type: "doc", content: [paragraph(text)] } }
    document.assets = [...assets.values()].map(({ blob: _blob, url: _url, ...metadata }) => metadata)
    if (assets.size) document.content.content.push(
      { type: "image", attrs: { assetId: "history-image", width: 32, height: 16 } },
      { type: "attachment", attrs: { assetId: "history-attachment" } },
      { type: "paragraph" }
    )
    track({ document, assets })
    const result = await saveLocalDocument(document, assets, 0)
    return { id: document.id, document, assets, storageVersion: result.storageVersion }
  }
  // 从文件栏打开文档库并按标题过滤，历史入口通过真实行按钮进入，不直接挂独立历史组件。
  const openLibrary = async query => {
    const trigger = await waitFor(() => button(host, "文档库")?.disabled === false && button(host, "文档库"), "文档库入口不可用")
    trigger.click()
    const search = await waitFor(() => libraryDialog()?.querySelector('[aria-label="文档搜索"]'), "文档库未打开")
    setInput(search, query)
    return libraryDialog()
  }
  // 等待历史准备结束和版本说明可编辑，保证当前文档的前置保存完成后才进行检查点操作。
  const open = async record => {
    await openLibrary(record.document.title)
    const entry = await waitFor(() => {
      const row = libraryDialog()?.querySelector(`[data-document-id="${record.id}"]`)
      return button(row, "历史版本")?.disabled === false && button(row, "历史版本")
    }, "历史版本入口未出现")
    entry.click()
    return waitFor(() => historyDialog()?.querySelector('[aria-label="版本说明"]')?.disabled === false && historyDialog(), "历史版本弹窗未就绪")
  }
  // 按稳定版本 ID 选择可用行按钮，分页/刷新后重新查询，避免使用旧 DOM 行。
  const versionAction = async (id, name) => {
    const control = await waitFor(() => button(versionRow(id), name)?.disabled === false && button(versionRow(id), name), `${name}操作不可用`)
    control.click()
  }
  // 预览需实际呈现历史正文文本，不能只依据请求完成或 version 元信息证明只读编辑器就绪。
  const showPreview = async (id, text) => {
    await versionAction(id, "预览")
    return waitFor(() => preview()?.textContent.includes(text) && preview(), "历史版本正文未显示")
  }
  // 通过说明输入与保存按钮建立真实检查点，覆盖父级 flush 以及版本同步契约。
  const checkpoint = async label => {
    const input = await waitFor(() => {
      const element = historyDialog()?.querySelector('[aria-label="版本说明"]')
      return element?.disabled === false && element
    }, "版本说明输入尚未就绪")
    setInput(input, label)
    const control = await waitFor(() => button(historyDialog(), "保存检查点")?.disabled === false && button(historyDialog(), "保存检查点"), "保存检查点不可用")
    control.click()
  }
  // 恢复明确经第二层确认弹窗，后续断言可观察确认层错误与同 ID 会话重建。
  const restore = async id => {
    await versionAction(id, "恢复此版本")
    const confirmation = await waitFor(() => [...document.querySelectorAll('[role="dialog"]')].find(node => button(node, "确认恢复")), "恢复未出现确认弹窗")
    button(confirmation, "确认恢复").click()
    return confirmation
  }
  // 每项报告后销毁本项会话，资源地址、预览和正文撤销历史不会跨场景共用。
  const check = async (name, run) => {
    try { await run(); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
    finally { await unmount() }
  }
  // 生成实际 PNG/附件 Blob，历史快照资源断言比对原始文件而非临时 URL。
  const canvas = document.createElement("canvas")
  canvas.width = 32
  canvas.height = 16
  canvas.getContext("2d").fillRect(0, 0, 32, 16)
  const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
  const attachment = new Blob(["历史版本必须独立保留的附件字节"], { type: "text/plain" })
  const assets = () => new Map([
    ["history-image", { id: "history-image", fileName: "历史图片.png", mimeType: png.type, byteLength: png.size, blob: png }],
    ["history-attachment", { id: "history-attachment", kind: "attachment", fileName: "历史附件.txt", mimeType: attachment.type, byteLength: attachment.size, blob: attachment }]
  ])
  // 逐资源比对 MIME、字节长度和所有字节，证明历史、恢复及另存没有丢失原文件数据。
  const equalAssets = async (left, right) => {
    assert(left.size === 2 && right.size === 2, "历史图片或附件丢失")
    for (const [id, asset] of left) {
      const other = right.get(id)
      assert(other?.mimeType === asset.mimeType && other.byteLength === asset.byteLength, `历史资源 ${id} 元数据改变`)
      const before = new Uint8Array(await asset.blob.arrayBuffer())
      const after = new Uint8Array(await other.blob.arrayBuffer())
      assert(before.length === after.length && before.every((byte, index) => byte === after[index]), `历史资源 ${id} 字节改变`)
    }
  }
  try {
    await check("历史版本：检查点先提交弹窗打开后产生的最新正文和标题", async () => {
      const record = await seed("检查点", "原正文")
      const context = await mount(record)
      await open(record)
      context.editor.commands.insertContentAt(1, "检查点前尚未保存-")
      context.store.getState().updateTitle(`${prefix}-检查点-最新标题`)
      await checkpoint("本轮手动检查点")
      const version = await waitFor(async () => (await getDocumentVersions(record.id)).find(item => item.label === "本轮手动检查点"), "检查点没有提交到历史库")
      const snapshot = await getDocumentVersion(record.id, version.id)
      assert(snapshot.version.document.title.endsWith("最新标题") && snapshot.version.document.content.content[0].content[0].text === "检查点前尚未保存-原正文", "历史检查点缺少最新标题或正文")
      const live = await getLocalDocument(record.id)
      assert(version.sourceStorageVersion === live.storageVersion && live.storageVersion === context.getStorageVersion(), "检查点存储版本未与真实保存队列同步")
      assert(current.editor === context.editor && context.editor.can().undo(), "保存检查点重建了正文或撤销历史")
    })
    await check("历史版本：只读预览不修改当前正文、保存版本或编辑状态", async () => {
      const record = await seed("只读预览", "历史原正文")
      const version = await createDocumentVersion(record.id, record.storageVersion, "只读快照")
      const context = await mount(record)
      context.editor.commands.insertContentAt(1, "当前新正文-")
      await open(record)
      const revision = context.store.getState().revision
      const stored = await getLocalDocument(record.id)
      const body = await showPreview(version.id, "历史原正文")
      assert(body.getAttribute("contenteditable") === "false", "历史版本预览不是只读正文")
      assert(body !== context.editor.view.dom && context.editor.getText() === "当前新正文-历史原正文", "预览替换了当前编辑器正文")
      assert(context.store.getState().revision === revision && context.editor.isEditable, "预览触发编辑或冻结当前会话")
      assert((await getLocalDocument(record.id)).storageVersion === stored.storageVersion, "预览触发了文档保存")
    })
    await check("历史版本：删除当前资源引用后历史图片附件仍可预览和读取", async () => {
      const record = await seed("独立资源", "含资源的历史正文", assets())
      const version = await createDocumentVersion(record.id, record.storageVersion, "含资源快照")
      const context = await mount(record)
      context.editor.commands.setContent({ type: "doc", content: [paragraph("当前正文已删除全部资源")] })
      assert(await context.saveDocument(), "删除当前资源后的正文不能保存")
      const live = await getLocalDocument(record.id)
      assert(live.document.assets.length === 0 && (await getDocumentAssets(live.document)).size === 0, "当前文档仍引用已删除资源")
      await equalAssets(record.assets, (await getDocumentVersion(record.id, version.id)).assets)
      await open(record)
      const body = await showPreview(version.id, "含资源的历史正文")
      const urls = [body.querySelector("img")?.src, body.querySelector("[data-attachment-download]")?.href]
      for (let index = 0; index < urls.length; index += 1) {
        assert(urls[index]?.startsWith("blob:"), "历史预览缺少图片或附件 URL")
        const response = await fetch(urls[index])
        const blob = await response.blob()
        assert(response.ok && blob.size === [png, attachment][index].size, "历史预览资源无法读取")
      }
      assert(context.editor.getText() === "当前正文已删除全部资源", "资源预览改写了当前正文")
    })
    // 恢复要先保留当前尚未保存输入作为自动历史备份，再换正文会话；恢复后的首次保存使用新版本。
    await check("历史版本：恢复前备份最新正文并重建同 ID 会话继续保存", async () => {
      const record = await seed("恢复", "历史正文", assets())
      const version = await createDocumentVersion(record.id, record.storageVersion, "恢复目标")
      const context = await mount(record)
      await open(record)
      context.editor.commands.setContent({ type: "doc", content: [paragraph("恢复前必须自动保留的最新正文")] })
      await restore(version.id)
      await waitFor(() => current?.documentId === record.id && current.editor !== context.editor, "同 ID 恢复没有重建正文会话")
      assert(current.editor.getText().startsWith("历史正文") && current.assets.size === 2, "历史正文或资源没有恢复")
      await equalAssets(record.assets, current.assets)
      const versions = await getDocumentVersions(record.id)
      const backup = versions.find(item => item.reason === "before-restore")
      assert(backup && (await getDocumentVersion(record.id, backup.id)).version.document.content.content[0].content[0].text === "恢复前必须自动保留的最新正文", "恢复前没有备份最新正文")
      const restored = await getLocalDocument(record.id)
      assert(restored.storageVersion > backup.sourceStorageVersion && restored.storageVersion === current.getStorageVersion(), "恢复存储版本没有同步到新保存队列")
      assert(!await context.saveDocument(), "旧恢复会话仍能执行保存")
      current.editor.commands.insertContentAt(1, "恢复后继续编辑-")
      assert(await current.saveDocument(), "恢复后编辑保存失败")
      assert((await getLocalDocument(record.id)).storageVersion === restored.storageVersion + 1, "恢复后保存版本没有推进")
    })
    await check("历史版本：另存副本使用历史正文及资源字节且不切会话", async () => {
      const record = await seed("历史另存", "需要另存的旧正文", assets())
      const version = await createDocumentVersion(record.id, record.storageVersion, "另存来源")
      const context = await mount(record)
      context.editor.commands.setContent({ type: "doc", content: [paragraph("当前正文与历史副本不同")] })
      await open(record)
      await versionAction(version.id, "另存副本")
      const copy = await waitFor(async () => (await getDocuments()).find(item => item.document.title === `${record.document.title} - 历史副本`), "历史副本没有提交到文档库")
      track(copy)
      assert(copy.id !== record.id && current.editor === context.editor && current.documentId === record.id, "历史另存复用了文档 ID 或切换会话")
      assert(copy.document.content.content[0].content[0].text === "需要另存的旧正文" && context.editor.getText() === "当前正文与历史副本不同", "副本使用了当前正文或改写原会话")
      await equalAssets(record.assets, await getDocumentAssets(copy.document))
      assert((await getLocalDocument(record.id)).document.assets.length === 0, "历史另存复活了当前文档已删除的资源")
      assert((await getDocumentVersion(record.id, version.id)).version.document.content.content[0].content[0].text === "需要另存的旧正文", "历史另存改变了来源版本")
    })
    await check("历史版本：后台文档检查点和恢复不改变当前会话", async () => {
      const background = await seed("后台历史", "后台旧正文", assets())
      const version = await createDocumentVersion(background.id, background.storageVersion, "后台恢复目标")
      const changed = { ...background.document, content: { type: "doc", content: [paragraph("后台最新正文")] }, assets: [], updatedAt: new Date().toISOString() }
      await saveLocalDocument(changed, new Map(), background.storageVersion)
      const record = await seed("后台历史-当前", "保持当前正文")
      const context = await mount(record)
      await open(background)
      const revision = context.store.getState().revision
      const currentVersion = context.getStorageVersion()
      await checkpoint("后台最新检查点")
      const checkpointVersion = await waitFor(async () => (await getDocumentVersions(background.id)).find(item => item.label === "后台最新检查点"), "后台检查点未生成")
      assert((await getDocumentVersion(background.id, checkpointVersion.id)).version.document.content.content[0].content[0].text === "后台最新正文", "后台检查点捕获了错误正文")
      await restore(version.id)
      const restored = await waitFor(async () => { const item = await getLocalDocument(background.id); return item.document.content.content[0].content[0].text === "后台旧正文" && item }, "后台版本没有恢复")
      await equalAssets(background.assets, await getDocumentAssets(restored.document))
      assert(current.editor === context.editor && current.documentId === record.id && context.editor.getText() === "保持当前正文", "后台历史操作切换或改写当前正文")
      assert(context.store.getState().revision === revision && context.getStorageVersion() === currentVersion, "后台历史操作引发当前文档保存")
    })
    await check("历史版本：外部保存冲突拒绝恢复并保留输入与当前正文", async () => {
      const record = await seed("恢复冲突", "原正文")
      const version = await createDocumentVersion(record.id, record.storageVersion, "冲突恢复目标")
      const context = await mount(record)
      await open(record)
      setInput(historyDialog().querySelector('[aria-label="版本说明"]'), "冲突后应保留的输入")
      context.editor.commands.insertContentAt(1, "尚未保存的当前输入-")
      const externalDocument = { ...record.document, content: { type: "doc", content: [paragraph("其他标签页保存的正文")] }, updatedAt: new Date().toISOString() }
      const external = await saveLocalDocument(externalDocument, new Map(), record.storageVersion)
      await restore(version.id)
      await waitFor(() => [...document.querySelectorAll('[role="alert"]')].some(node => node.textContent.includes("另一标签页")), "恢复并发冲突未显示错误")
      assert(current.editor === context.editor && context.editor.getText() === "尚未保存的当前输入-原正文" && context.editor.isEditable, "恢复冲突丢失或冻结当前正文")
      assert(historyDialog().querySelector('[aria-label="版本说明"]').value === "冲突后应保留的输入", "恢复冲突清空了版本说明输入")
      const saved = await getLocalDocument(record.id)
      assert(saved.storageVersion === external.storageVersion && saved.document.content.content[0].content[0].text === "其他标签页保存的正文", "恢复冲突覆盖了其他标签页结果")
      assert(!(await getDocumentVersions(record.id)).some(item => item.reason === "before-restore"), "失败恢复仍写入恢复前版本")
    })
    // 局部包装 URL 分配/回收观察预览所有者，关闭和卸载迟到读取都不能留下无归属的资源地址。
    await check("历史版本：关闭预览和卸载迟到读取释放全部临时资源 URL", async () => {
      const record = await seed("预览释放", "预览资源正文", assets())
      const version = await createDocumentVersion(record.id, record.storageVersion, "释放来源")
      await mount(record)
      await open(record)
      const createUrl = URL.createObjectURL
      const revokeUrl = URL.revokeObjectURL
      const active = new Set()
      let created = 0
      URL.createObjectURL = blob => { const url = createUrl.call(URL, blob); active.add(url); created += 1; return url }
      URL.revokeObjectURL = url => { active.delete(url); revokeUrl.call(URL, url) }
      try {
        await showPreview(version.id, "预览资源正文")
        assert(created >= 2 && active.size === 2, "历史预览没有创建独立的图片附件 URL")
        button(historyDialog(), "关闭预览").click()
        await waitFor(() => !preview() && active.size === 0, "关闭预览没有释放临时资源 URL")
        await versionAction(version.id, "预览")
        await unmount()
        await new Promise(resolve => setTimeout(resolve, 100))
        assert(!preview() && active.size === 0, "卸载后的迟到历史读取复活了预览或泄漏 URL")
      } finally {
        URL.createObjectURL = createUrl
        URL.revokeObjectURL = revokeUrl
      }
    })
    await check("历史版本：缺失历史资源显示错误并阻止不完整恢复", async () => {
      const record = await seed("损坏资源", "历史资源正文", assets())
      const version = await createDocumentVersion(record.id, record.storageVersion, "缺失资源来源")
      const context = await mount(record)
      context.editor.commands.setContent({ type: "doc", content: [paragraph("必须保留的当前正文")] })
      await open(record)
      const saved = await getLocalDocument(record.id)
      // 只损坏本轮确切版本的一个 Blob，模拟存储资源缺失，不触及其他文档。
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("mewoc")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        await new Promise((resolve, reject) => {
          const transaction = database.transaction("assets", "readwrite")
          transaction.objectStore("assets").delete(`${record.id}:history-asset:${version.id}:history-image`)
          transaction.oncomplete = resolve
          transaction.onerror = () => reject(transaction.error)
        })
      } finally { database.close() }
      await versionAction(version.id, "预览")
      await waitFor(() => [...document.querySelectorAll('[role="alert"]')].some(node => /资源.*(缺失|不存在)/.test(node.textContent)), "缺失历史资源未显示错误")
      const confirmation = await restore(version.id)
      await waitFor(() => [...confirmation.querySelectorAll('[role="alert"]')].some(node => /资源.*(缺失|不存在)/.test(node.textContent)), "缺失资源恢复未显示错误")
      assert(current.editor === context.editor && context.editor.getText() === "必须保留的当前正文", "失败恢复替换了当前正文")
      assert((await getLocalDocument(record.id)).storageVersion === saved.storageVersion, "不完整历史恢复仍提交了当前文档")
      assert(!(await getDocumentVersions(record.id)).some(item => item.reason === "before-restore"), "不完整恢复留下了半提交检查点")
    })
    // 检查历史面板由行外托管：保存检查点触发列表刷新或页号变化时，不应随原行卸载。
    await check("历史版本：文档库第 2 页保存检查点后历史弹窗保持打开", async () => {
      const records = []
      for (let index = 0; index < 7; index += 1) records.push(await seed(`分页历史-${String(index).padStart(2, "0")}`, `分页文档正文 ${index}`))
      const record = await seed("分页存续当前", "分页操作保留当前正文")
      const context = await mount(record)
      await openLibrary(`${prefix}-分页历史-`)
      const sort = await waitFor(() => libraryDialog()?.querySelector('[aria-label="文档排序"]'), "文档排序控件缺失")
      const selector = sort.closest(".ant-select")?.querySelector(".ant-select-selector")
      assert(selector, "文档排序缺少实际选择区域")
      selector.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
      const option = await waitFor(() => [...document.querySelectorAll(".ant-select-item-option")].find(item => item.textContent === "按标题排序"), "按标题排序选项未出现")
      option.click()
      await waitFor(() => libraryDialog()?.querySelectorAll("[data-document-id]").length === 6 && libraryDialog().querySelector(`[data-document-id="${records[0].id}"]`), "文档库首屏没有按标题排列")
      const next = await waitFor(() => {
        const control = libraryDialog()?.querySelector(".ant-pagination-next button")
        return control?.disabled === false && control
      }, "文档库下一页不可用")
      next.click()
      const entry = await waitFor(() => {
        const row = libraryDialog()?.querySelector(`[data-document-id="${records[6].id}"]`)
        return button(row, "历史版本")?.disabled === false && button(row, "历史版本")
      }, "第 2 页历史版本入口未出现")
      entry.click()
      await waitFor(() => historyDialog()?.querySelector('[aria-label="版本说明"]')?.disabled === false, "第 2 页历史弹窗未就绪")
      const currentVersion = context.getStorageVersion()
      await checkpoint("第 2 页仍保持打开的检查点")
      const version = await waitFor(async () => (await getDocumentVersions(records[6].id)).find(item => item.label === "第 2 页仍保持打开的检查点"), "第 2 页检查点未提交")
      // 刷新确实已把文档库翻回第 1 页；原第 2 页行卸载不应连带销毁历史弹窗。
      await waitFor(() => libraryDialog()?.querySelector('.ant-pagination-item-active[title="1"]'), "检查点保存后文档库没有完成刷新")
      await waitFor(() => historyDialog() && versionRow(version.id), "列表刷新卸载了第 2 页历史弹窗")
      assert(current.editor === context.editor && current.documentId === record.id && context.editor.getText() === "分页操作保留当前正文", "第 2 页历史操作切换了当前会话")
      assert(context.getStorageVersion() === currentVersion, "后台检查点修改了当前保存版本")
    })
    await check("历史版本：后台恢复后继续保存检查点使用更新后的存储版本", async () => {
      const background = await seed("后台再次检查点", "再次检查点的历史正文")
      const target = await createDocumentVersion(background.id, background.storageVersion, "再次检查点恢复目标")
      const document = { ...background.document, title: `${background.document.title}-较新标题`, content: { type: "doc", content: [paragraph("恢复前的较新正文")] }, updatedAt: new Date().toISOString() }
      const saved = await saveLocalDocument(document, new Map(), background.storageVersion)
      const record = await seed("后台再次检查点当前", "再次检查点保留当前正文")
      const context = await mount(record)
      await open({ ...background, document, storageVersion: saved.storageVersion })
      await restore(target.id)
      const restored = await waitFor(async () => {
        const item = await getLocalDocument(background.id)
        return item?.document.title === background.document.title && item.storageVersion > saved.storageVersion && item
      }, "后台历史恢复没有提交")
      // 恢复后标题不再命中原文档库搜索；独立历史弹窗仍须收到最新目标记录及版号。
      await waitFor(() => historyDialog() && !historyDialog().textContent.includes(document.title) && historyDialog().textContent.includes(background.document.title), "恢复后的历史弹窗没有同步最新目标记录")
      await checkpoint("后台恢复后再次保存")
      const version = await waitFor(async () => (await getDocumentVersions(background.id)).find(item => item.label === "后台恢复后再次保存"), "后台恢复后检查点因陈旧版号失败")
      const snapshot = await getDocumentVersion(background.id, version.id)
      assert(version.sourceStorageVersion === restored.storageVersion && snapshot.version.document.content.content[0].content[0].text === "再次检查点的历史正文", "再次检查点来源版号或恢复正文错误")
      assert(current.editor === context.editor && current.documentId === record.id && context.editor.getText() === "再次检查点保留当前正文", "后台再次检查点切换或改写了当前会话")
    })
  // 卸载后补收本轮前缀生成的文档副本，再精确删除 live/history 资源；最后回收测试宿主与 Canvas。
  } finally {
    await unmount()
    const records = [...await getDocuments(), ...await getDocuments({ deleted: true })]
    records.filter(record => record.document.title.startsWith(prefix)).forEach(track)
    await removeVerificationDocuments([...cleanup.values()])
    host.remove()
    canvas.width = 0
    canvas.height = 0
  }
}
