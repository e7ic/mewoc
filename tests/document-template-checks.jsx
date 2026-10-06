/**
 * 模板库浏览器验收贯通来源保存、只读预览、模板版本校验、独立新建与自定义模板管理。
 * 检查批注剥离、资源字节隔离、损坏数据回退和旧预览拒绝；本轮记录与模板按精确身份清理。
 */
import { useEffect, useState } from "react"
import ReactDOM from "react-dom"
import { EditorContent } from "@tiptap/react"
import { TextSelection } from "@tiptap/pm/state"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { FileActions } from "../src/pages/editor/components/FileActions.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentAssetUrl } from "../src/pages/editor/tools/attachment-assets.js"
import { getDatabase, getDocuments, getLocalDocument, getDocumentAssets, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { getDocumentTemplates, getDocumentTemplate, createDocumentTemplate, renameDocumentTemplate } from "../src/pages/editor/tools/document-template-repository.js"
import { addDocumentComment, getCommentThreads } from "../src/pages/editor/tools/document-comments.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
// 轮询真实 UI 与模板仓库，异步条件可直接查落盘结果，超时返回该阶段具体失败说明。
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}
// 库主层与保存/重命名确认层按宿主查询，避免同名按钮在多个 portal 中混淆。
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(element => element.textContent.replace(/\s/g, "") === name.replace(/\s/g, ""))
const byLabel = (host, name) => host?.querySelector(`[aria-label="${name}"]`)
const dialog = () => [...document.querySelectorAll('[role="dialog"]')].find(element => byLabel(element, "模板搜索"))
const saveDialog = () => byLabel(document, "模板名称")?.closest('[role="dialog"]')
const renameDialog = () => byLabel(document, "新模板名称")?.closest('[role="dialog"]')
const preview = () => byLabel(document, "模板预览正文")
const row = id => dialog()?.querySelector(`[data-template-id="${id}"]`)
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const setInput = (element, value) => {
  assert(element, "模板输入控件不存在")
  // 经原生 setter 发出 input，使 React 17 的受控输入也真实走事件链。
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const hasAlert = (host, pattern) => [...(host?.querySelectorAll('[role="alert"]') || [])].some(element => pattern.test(element.textContent))

// 真实文件动作和正文共享会话服务，允许观察模板操作是否改动来源、冻结编辑或重建撤销历史。
function TemplateProbe({ onContext, onRecordChange }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onContext(context) }, [context, onContext])
  return <section style={{ width: 840, margin: 20 }}>
    <FileActions onDocumentChange={onRecordChange} />
    <EditorContent editor={context.editor} />
  </section>
}

// 以文档 ID 加会话序号重建 Provider，新建或同 ID 切换都必须拥有独立正文与资源生命周期。
function TemplateSession({ initialRecord, onContext, onRecord }) {
  const [session, setSession] = useState({ record: initialRecord, id: 0 })
  const changeRecord = record => {
    onRecord(record)
    setSession(previous => ({ record, id: previous.id + 1 }))
  }
  return <EditorProvider key={`${session.record.document.id}:${session.id}`} record={session.record}>
    <TemplateProbe onContext={onContext} onRecordChange={changeRecord} />
  </EditorProvider>
}

/**
 * 真实 FileActions 把主会话保存队列、模板弹窗和 IndexedDB 事务串在一起。
 * 每轮仅记录自己创建的文档与模板 ID，卸载保存队列后精确清理，不清空用户数据库。
 */
export async function runDocumentTemplateChecks(report = () => {}) {
  // 随机前缀隔离本轮模板与文档，records/templates 分别追踪待清理身份，results 汇总各项反馈。
  const prefix = `模板验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const records = new Map()
  const templates = new Set()
  const results = []
  const host = document.createElement("div")
  document.body.append(host)
  let current = null
  // 切换产生的新文档加入精确清理表；模板另用 ID 集合追踪，避免删除来源或用户已有模板。
  const track = record => { records.set(record.document.id, { document: record.document, assets: record.assets || new Map() }); return record }
  const trackTemplate = template => { templates.add(template.id); return template }
  // 卸载保存队列后等待库、确认层与预览全部消失，旧模板请求不能与下一轮 UI 查询竞争。
  const unmount = async () => {
    ReactDOM.unmountComponentAtNode(host)
    current = null
    await waitFor(() => !dialog() && !saveDialog() && !renameDialog() && !preview(), "模板弹窗未卸载")
  }
  // 资源 Blob 先获得当前会话 URL，再挂真实模板入口，Context ID 对齐后才执行操作。
  const mount = async record => {
    await unmount()
    record.assets.forEach(asset => { asset.url = createDocumentAssetUrl(asset) })
    ReactDOM.render(<TemplateSession initialRecord={record} onContext={context => { current = context }} onRecord={track} />, host)
    return waitFor(() => current?.editor && current.documentId === record.document.id && current, "模板编辑器会话未就绪")
  }
  // 将运行时 Blob/URL 从文档元信息剥离后真实保存，模板复制依据仓库版本和原资源字节。
  const seed = async (name, text = name, assets = new Map()) => {
    const document = { ...createDocument(), title: `${prefix}-${name}`, content: { type: "doc", content: [paragraph(text)] } }
    document.assets = [...assets.values()].map(({ blob: _blob, url: _url, ...metadata }) => metadata)
    if (assets.size) document.content.content.push(
      { type: "image", attrs: { assetId: "template-image", width: 32, height: 16 } },
      { type: "attachment", attrs: { assetId: "template-attachment" } },
      { type: "paragraph" }
    )
    track({ document, assets })
    const saved = await saveLocalDocument(document, assets, 0)
    return { id: document.id, document, assets, storageVersion: saved.storageVersion }
  }
  // 打开模板前等待入口可用，打开后等待搜索控件可用，覆盖父级保存准备而非跳过准备直接断言。
  const open = async () => {
    const trigger = await waitFor(() => button(host, "模板")?.disabled === false && button(host, "模板"), "模板入口不可用")
    trigger.click()
    return waitFor(() => byLabel(dialog(), "模板搜索")?.disabled === false && dialog(), "模板弹窗未就绪")
  }
  // 分类切换通过实际 Tabs 按钮，等待 aria-selected，避免只改 store 旁路 UI 的预览清理。
  const customTab = async () => {
    const tab = [...(dialog()?.querySelectorAll('[role="tab"]') || [])].find(element => element.textContent === "我的模板")
    assert(tab, "我的模板页签不存在")
    tab.click()
    await waitFor(() => tab.getAttribute("aria-selected") === "true", "我的模板页签没有切换")
  }
  const search = async value => {
    setInput(await waitFor(() => byLabel(dialog(), "模板搜索"), "模板搜索控件不存在"), value)
  }
  // 通过模板 ID 锁定当前可用行，列表刷新后重新查询按钮，避免沿用旧版本行引用。
  const action = async (id, name) => {
    const control = await waitFor(() => button(row(id), name)?.disabled === false && button(row(id), name), `模板${name}操作不可用`)
    control.click()
  }
  // 确认独立只读正文实际含预期文本再使用，列表元信息本身不能证明快照与资源已验证。
  const showPreview = async (id, text) => {
    await action(id, "预览")
    return waitFor(() => preview()?.textContent.includes(text) && preview(), "模板只读正文没有显示")
  }
  // 保存经名称草稿与确认按钮，再读仓库确认并追踪真实模板 ID，确保完成写入后才继续管理。
  const saveTemplate = async name => {
    const trigger = await waitFor(() => button(dialog(), "将当前文档保存为模板")?.disabled === false && button(dialog(), "将当前文档保存为模板"), "保存模板入口不可用")
    trigger.click()
    setInput(await waitFor(() => byLabel(saveDialog(), "模板名称"), "模板名称弹窗没有打开"), name)
    button(saveDialog(), "保存模板").click()
    const template = await waitFor(async () => (await getDocumentTemplates()).find(item => item.name === name), "模板没有提交到独立存储")
    trackTemplate(template)
    await waitFor(() => !saveDialog() && row(template.id), "模板保存后没有刷新我的模板列表")
    return template
  }
  // 新建必须从已完成且无错误的预览入口触发，返回按钮供用例覆盖快速双击互斥。
  const createFromPreview = async () => {
    const control = await waitFor(() => button(dialog(), "用此模板新建")?.disabled === false && button(dialog(), "用此模板新建"), "模板新建入口不可用")
    control.click()
    return control
  }
  // 类型/长度/逐字节同时比较，验证来源、模板与新建文档复制独立数据，临时 URL 不作为相等依据。
  const equalAssets = async (left, right) => {
    assert(left.size === 2 && right.size === 2, "模板图片或附件丢失")
    for (const [id, asset] of left) {
      const other = right.get(id)
      assert(other?.mimeType === asset.mimeType && other.byteLength === asset.byteLength, `模板资源 ${id} 元数据改变`)
      const before = new Uint8Array(await asset.blob.arrayBuffer())
      const after = new Uint8Array(await other.blob.arrayBuffer())
      assert(before.length === after.length && before.every((byte, index) => byte === after[index]), `模板资源 ${id} 字节改变`)
    }
  }
  // 每项单独报告并卸载 Provider/portal；错误继续后续检查，精确清理由最外层 finally 承担。
  const check = async (name, run) => {
    try { await run(); const result = { name, passed: true }; results.push(result); report(result) }
    catch (error) { const result = { name, passed: false, error: error.message }; results.push(result); report(result) }
    finally { await unmount() }
  }
  // 准备可解码 PNG 与附件 Blob，支持真实预览和资源独立性检查。
  const canvas = document.createElement("canvas")
  canvas.width = 32
  canvas.height = 16
  canvas.getContext("2d").fillRect(0, 0, 32, 16)
  const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
  const attachment = new Blob(["模板必须独立保留的附件字节"], { type: "text/plain" })
  const assets = () => new Map([
    ["template-image", { id: "template-image", fileName: "模板图片.png", mimeType: png.type, byteLength: png.size, blob: png }],
    ["template-attachment", { id: "template-attachment", kind: "attachment", fileName: "模板附件.txt", mimeType: attachment.type, byteLength: attachment.size, blob: attachment }]
  ])
  try {
    await check("模板：内置只读预览不修改当前会话或触发保存", async () => {
      const record = await seed("只读预览", "预览期间保留的当前正文")
      const context = await mount(record)
      await open()
      const builtins = (await getDocumentTemplates()).filter(item => item.builtin)
      assert(builtins.length === 3 && ["会议纪要", "项目周报", "工作报告"].every(name => builtins.some(item => item.name === name)), "三份内置模板没有完整展示")
      const revision = context.store.getState().revision
      const stored = await getLocalDocument(record.id)
      const template = builtins.find(item => item.name === "会议纪要")
      const body = await showPreview(template.id, "会议")
      assert(body.getAttribute("contenteditable") === "false" && body.getAttribute("aria-readonly") === "true", "内置模板预览没有保持只读")
      assert(body !== context.editor.view.dom && context.editor.getText() === "预览期间保留的当前正文" && context.editor.isEditable, "模板预览替换或冻结了当前正文")
      assert(context.store.getState().revision === revision && (await getLocalDocument(record.id)).storageVersion === stored.storageVersion, "预览产生了编辑或持久化")
    })
    await check("模板：内置新建先保存当前最新输入且快速双击只生成一份", async () => {
      const record = await seed("内置新建", "必须保存的原正文")
      const context = await mount(record)
      await open()
      const template = (await getDocumentTemplates()).find(item => item.builtin && item.name === "项目周报")
      await showPreview(template.id, "周")
      context.editor.commands.insertContentAt(1, "新建前尚未保存的输入-")
      context.store.getState().updateTitle(`${prefix}-内置新建-最新标题`)
      const before = new Set((await getDocuments()).map(item => item.id))
      const trigger = await createFromPreview()
      trigger.click()
      await waitFor(() => current?.editor && current.documentId !== record.id, "内置模板没有建立新文档会话")
      const old = await getLocalDocument(record.id)
      const created = (await getDocuments()).filter(item => !before.has(item.id))
      assert(old.document.title.endsWith("最新标题") && old.document.content.content[0].content[0].text === "新建前尚未保存的输入-必须保存的原正文", "从模板新建丢失了原会话最新正文或标题")
      assert(created.length === 1 && created[0].id === current.documentId && current.editor !== context.editor, "快速双击创建了多份文档或沿用了旧编辑器")
      assert(current.store.getState().title === template.name && current.getStorageVersion() === 1 && current.editor.getText().includes("周"), "模板新文档名称、正文或初始存储版本错误")
      current.editor.commands.insertContentAt(1, "模板新建后继续编辑-")
      assert(await current.saveDocument(), "从模板新建后无法继续保存")
      assert((await getLocalDocument(current.documentId)).storageVersion === 2, "模板新文档后续保存没有推进版本")
    })
    await check("模板：保存最新正文及格式，剥离批注但保留来源批注和撤销历史", async () => {
      const record = await seed("保存批注", "模板来源带格式与批注")
      const context = await mount(record)
      await open()
      context.editor.commands.setTextSelection({ from: 1, to: 6 })
      context.editor.commands.toggleBold()
      const commentId = addDocumentComment(context.editor, TextSelection.create(context.editor.state.doc, 3, 9), "只属于来源文档的批注")
      assert(commentId, "模板来源批注没有创建")
      context.editor.commands.insertContentAt(1, "模板保存前最新输入-")
      const template = await saveTemplate(`${prefix}-含格式模板`)
      const saved = await getDocumentTemplate(template.id)
      const source = await getLocalDocument(record.id)
      const json = JSON.stringify(saved.template.document.content)
      assert(json.includes("模板保存前最新输入-") && json.includes('"type":"bold"'), "模板缺少最新正文或原有粗体格式")
      assert(!json.includes("commentAnchor") && getCommentThreads(saved.template.document.content).length === 0, "模板带入了来源批注线程或锚点")
      assert(getCommentThreads(source.document.content)[0].id === commentId && getCommentThreads(context.editor.state.doc)[0].id === commentId, "保存模板删除了来源文档批注")
      assert(current.editor === context.editor && context.editor.can().undo() && context.editor.isEditable, "保存模板重建了主会话或丢失撤销历史")
      await showPreview(template.id, "模板保存前最新输入-")
      assert(!preview().querySelector("[data-mewoc-comment-id]") && preview().querySelector("strong"), "模板预览没有保留格式或仍带批注高亮")
    })
    await check("模板：来源删除资源后模板仍可预览，新建资源和模板互不覆盖", async () => {
      const record = await seed("独立资源", "模板独立资源正文", assets())
      const context = await mount(record)
      await open()
      const template = await saveTemplate(`${prefix}-独立资源模板`)
      context.editor.commands.setContent({ type: "doc", content: [paragraph("来源已经删除图片和附件")] })
      assert(await context.saveDocument(), "来源删除资源后不能保存")
      const source = await getLocalDocument(record.id)
      assert(source.document.assets.length === 0 && (await getDocumentAssets(source.document)).size === 0, "来源仍保留资源引用")
      await equalAssets(record.assets, (await getDocumentTemplate(template.id)).assets)
      const body = await showPreview(template.id, "模板独立资源正文")
      const urls = [body.querySelector("img")?.src, body.querySelector("[data-attachment-download]")?.href]
      for (let index = 0; index < urls.length; index += 1) {
        assert(urls[index]?.startsWith("blob:"), "模板预览缺少图片或附件 URL")
        const response = await fetch(urls[index])
        assert(response.ok && (await response.blob()).size === [png, attachment][index].size, "独立模板资源无法读取")
      }
      await createFromPreview()
      const first = await waitFor(() => current?.documentId !== record.id && current?.editor && current, "自定义模板新建没有切换会话")
      await equalAssets(record.assets, first.assets)
      const firstId = first.documentId
      first.editor.commands.setContent({ type: "doc", content: [paragraph("第一份新文档删除自己的资源")] })
      assert(await first.saveDocument(), "模板实例删除资源后无法保存")
      await open()
      await customTab()
      await search(template.name)
      await showPreview(template.id, "模板独立资源正文")
      await createFromPreview()
      const second = await waitFor(() => current?.documentId !== firstId && current?.editor && current, "第二次模板新建没有生成新文档")
      assert(second.documentId !== record.id && second.documentId !== firstId, "多次模板新建复用了来源或实例 ID")
      await equalAssets(record.assets, second.assets)
      await equalAssets(record.assets, (await getDocumentTemplate(template.id)).assets)
      assert((await getLocalDocument(firstId)).document.assets.length === 0, "第二次新建恢复了第一份实例已删除的资源")
    })
    await check("模板：重命名刷新列表，删除模板保留已创建文档和资源", async () => {
      const record = await seed("管理模板", "模板删除后实例仍要保留", assets())
      await mount(record)
      await open()
      const template = await saveTemplate(`${prefix}-待重命名模板`)
      await action(template.id, "重命名")
      const nextName = `${prefix}-已重命名模板`
      setInput(await waitFor(() => byLabel(renameDialog(), "新模板名称"), "模板重命名弹窗未打开"), nextName)
      button(renameDialog(), "确认重命名").click()
      const renamed = await waitFor(async () => (await getDocumentTemplates()).find(item => item.id === template.id && item.name === nextName), "模板重命名没有持久化")
      await waitFor(() => !renameDialog() && row(template.id)?.textContent.includes(nextName), "模板列表没有展示重命名结果")
      assert(renamed.storageVersion === template.storageVersion + 1, "重命名没有推进模板存储版本")
      await showPreview(template.id, "模板删除后实例仍要保留")
      await createFromPreview()
      const instance = await waitFor(() => current?.documentId !== record.id && current?.editor && current, "重命名模板没有创建实例")
      const instanceId = instance.documentId
      await open()
      await customTab()
      await search(nextName)
      await action(template.id, "删除")
      const confirmation = await waitFor(() => [...document.querySelectorAll('[role="dialog"]')].find(element => button(element, "确认删除")), "模板删除没有确认弹窗")
      assert(/不(会)?影响.*文档/.test(confirmation.textContent), "删除模板提示没有说明已有文档保留")
      button(confirmation, "确认删除").click()
      await waitFor(async () => !(await getDocumentTemplates()).some(item => item.id === template.id), "模板删除没有完成")
      await waitFor(() => !row(template.id), "已删除模板仍显示在列表")
      const persisted = await getLocalDocument(instanceId)
      assert(persisted.document.title === nextName && persisted.document.content.content[0].content[0].text === "模板删除后实例仍要保留", "删除模板改写了已创建文档")
      await equalAssets(record.assets, await getDocumentAssets(persisted.document))
      assert(current.documentId === instanceId && current.editor === instance.editor && instance.editor.isEditable, "删除模板切换或冻结了当前实例")
    })
    await check("模板：关闭预览和卸载迟到读取释放全部临时资源 URL", async () => {
      const record = await seed("预览释放", "必须释放预览资源", assets())
      const template = trackTemplate(await createDocumentTemplate(record.id, record.storageVersion, `${prefix}-释放模板`))
      await mount(record)
      await open()
      await customTab()
      await search(template.name)
      const createUrl = URL.createObjectURL
      const revokeUrl = URL.revokeObjectURL
      const active = new Set()
      let created = 0
      URL.createObjectURL = blob => { const url = createUrl.call(URL, blob); active.add(url); created += 1; return url }
      URL.revokeObjectURL = url => { active.delete(url); revokeUrl.call(URL, url) }
      try {
        await showPreview(template.id, "必须释放预览资源")
        assert(created >= 2 && active.size === 2, "模板预览没有分配独立资源 URL")
        button(dialog(), "关闭预览").click()
        await waitFor(() => !preview() && active.size === 0, "关闭模板预览没有释放 URL")
        // 在异步仓库读返回前卸载，迟到结果不得复活弹窗或遗留 object URL。
        await action(template.id, "预览")
        await unmount()
        await new Promise(resolve => setTimeout(resolve, 100))
        assert(!preview() && active.size === 0, "卸载后的迟到模板读取泄漏 URL 或复活预览")
      } finally {
        URL.createObjectURL = createUrl
        URL.revokeObjectURL = revokeUrl
      }
    })
    await check("模板：来源保存冲突保留未提交正文和模板名称草稿", async () => {
      const record = await seed("来源保存冲突", "冲突前的当前正文")
      const context = await mount(record)
      await open()
      button(dialog(), "将当前文档保存为模板").click()
      const name = `${prefix}-冲突草稿模板`
      setInput(await waitFor(() => byLabel(saveDialog(), "模板名称"), "保存模板弹窗未打开"), name)
      context.editor.commands.insertContentAt(1, "必须保留的未保存输入-")
      const externalDocument = { ...record.document, content: { type: "doc", content: [paragraph("另一标签页保存的正文")] }, updatedAt: new Date().toISOString() }
      const external = await saveLocalDocument(externalDocument, new Map(), context.getStorageVersion())
      button(saveDialog(), "保存模板").click()
      await waitFor(() => hasAlert(saveDialog(), /另一标签页|变更|保存/), "模板保存冲突没有显示错误")
      assert(byLabel(saveDialog(), "模板名称").value === name && current.editor === context.editor && context.editor.getText() === "必须保留的未保存输入-冲突前的当前正文" && context.editor.isEditable, "保存模板失败丢失了当前正文、名称草稿或编辑状态")
      const stored = await getLocalDocument(record.id)
      assert(stored.storageVersion === external.storageVersion && stored.document.content.content[0].content[0].text === "另一标签页保存的正文", "模板保存覆盖了其他标签页结果")
      assert(!(await getDocumentTemplates()).some(item => item.name === name), "保存冲突仍写入了模板")
    })
    // 用仓库外部重命名模拟另一标签页，旧预览版本必须在新建事务中拒绝，不能默默换成新模板。
    await check("模板：已预览模板被外部重命名后拒绝陈旧新建，保持当前会话", async () => {
      const record = await seed("模板版本冲突", "模板冲突期间保留当前正文")
      const template = trackTemplate(await createDocumentTemplate(record.id, record.storageVersion, `${prefix}-版本冲突模板`))
      const context = await mount(record)
      await open()
      await customTab()
      await search(template.name)
      await showPreview(template.id, "模板冲突期间保留当前正文")
      const stored = await getLocalDocument(record.id)
      const before = new Set((await getDocuments()).map(item => item.id))
      await renameDocumentTemplate(template.id, `${prefix}-外部重命名`, template.storageVersion)
      await createFromPreview()
      await waitFor(() => hasAlert(dialog(), /另一标签页|变更|刷新/), "陈旧模板新建没有显示版本冲突")
      assert(current.editor === context.editor && current.documentId === record.id && context.editor.getText() === "模板冲突期间保留当前正文" && context.editor.isEditable, "模板版本冲突切换或冻结了当前正文")
      assert((await getLocalDocument(record.id)).storageVersion === stored.storageVersion && (await getDocuments()).every(item => before.has(item.id)), "模板版本冲突仍产生了持久化文档")
    })
    await check("模板：缺失资源阻止预览和不完整新建，当前文档继续保留", async () => {
      const record = await seed("缺失资源", "资源缺失时保留当前正文", assets())
      const template = trackTemplate(await createDocumentTemplate(record.id, record.storageVersion, `${prefix}-缺失资源模板`))
      const context = await mount(record)
      await open()
      await customTab()
      await search(template.name)
      const stored = await getLocalDocument(record.id)
      // 故意删除本轮确切模板的一份 Blob，模拟局部损坏；不碰来源或其他模板资源。
      const database = await getDatabase()
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("assets", "readwrite")
        transaction.objectStore("assets").delete(`template-asset:${template.id}:template-image`)
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(transaction.error)
      })
      await action(template.id, "预览")
      await waitFor(() => hasAlert(dialog(), /资源.*(缺失|不存在)/), "模板缺失资源没有显示错误")
      assert(!preview() && (!button(dialog(), "用此模板新建") || button(dialog(), "用此模板新建").disabled), "不完整模板仍可预览或新建")
      assert(current.editor === context.editor && context.editor.getText().startsWith("资源缺失时保留当前正文") && context.editor.isEditable, "损坏模板改变了当前会话")
      assert((await getLocalDocument(record.id)).storageVersion === stored.storageVersion, "损坏模板预览触发了保存")
      await equalAssets(record.assets, await getDocumentAssets(stored.document))
    })
    // 损坏自定义元信息时错误需要可见，内置模板仍可独立预览/新建；fixture 修改只针对已知测试记录。
    await check("模板：自定义元信息损坏时显示错误，内置模板仍可只读预览和新建", async () => {
      const record = await seed("损坏元信息", "内置回落期间保留的原正文")
      const template = trackTemplate(await createDocumentTemplate(record.id, record.storageVersion, `${prefix}-损坏元信息模板`))
      const snapshot = await getDocumentTemplate(template.id)
      const builtin = (await getDocumentTemplates()).find(item => item.builtin && item.name === "工作报告")
      const database = await getDatabase()
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("assets", "readwrite")
        // 仅改坏自己刚创建的元信息，模拟仓库中出现无法验证的自定义模板。
        transaction.objectStore("assets").put({ id: `template:${template.id}`, template: { ...snapshot.template, name: "" } })
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(transaction.error)
      })
      try {
        const context = await mount(record)
        await open()
        await waitFor(() => hasAlert(dialog(), /我的模板读取失败.*内置模板仍可预览/), "损坏自定义模板未显示明确的读取失败提示")
        await waitFor(() => dialog()?.querySelectorAll("[data-template-id]").length === 3, "自定义读取失败后未保留三份内置模板")
        const stored = await getLocalDocument(record.id)
        const body = await showPreview(builtin.id, "工作报告")
        assert(body.getAttribute("contenteditable") === "false" && current.editor === context.editor && context.editor.getText() === "内置回落期间保留的原正文", "内置回落预览不是只读或改变了主会话")
        assert((await getLocalDocument(record.id)).storageVersion === stored.storageVersion, "内置回落预览触发了保存")
        await customTab()
        assert(!row(template.id) && !preview(), "损坏的自定义模板仍显示为可操作条目")
        const builtinTab = [...dialog().querySelectorAll('[role="tab"]')].find(element => element.textContent === "内置模板")
        builtinTab.click()
        await showPreview(builtin.id, "工作报告")
        await createFromPreview()
        const instance = await waitFor(() => current?.documentId !== record.id && current?.editor && current, "自定义列表损坏阻止了内置新建")
        assert(instance.store.getState().title === builtin.name && instance.getStorageVersion() === 1, "内置回落新建文档标题或版号错误")
      } finally {
        // getDocumentTemplates 会整体拒绝坏元信息；先精确删除这个故障 fixture，再做全轮清理。
        await new Promise((resolve, reject) => {
          const transaction = database.transaction("assets", "readwrite")
          transaction.objectStore("assets").delete(`template:${template.id}`)
          transaction.oncomplete = resolve
          transaction.onerror = () => reject(transaction.error)
        })
      }
    })
  // 先卸载保存和预览所有者，再找回本轮已写入但未记录成功的身份，按精确 ID 清理模板及资源。
  } finally {
    await unmount()
    // UI 创建后即使某条断言提前失败，也按本轮唯一名称找回其确切 ID，避免测试垃圾遗留。
    const storedTemplates = await getDocumentTemplates()
    storedTemplates.filter(item => !item.builtin && item.name.startsWith(prefix)).forEach(trackTemplate)
    const storedDocuments = [...await getDocuments(), ...await getDocuments({ deleted: true })]
    storedDocuments.filter(item => item.document.title.startsWith(prefix)).forEach(track)
    const database = await getDatabase()
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("assets", "readwrite")
      for (const id of templates) {
        transaction.objectStore("assets").delete(`template:${id}`)
        const keyPrefix = `template-asset:${id}:`
        const request = transaction.objectStore("assets").openCursor(IDBKeyRange.bound(keyPrefix, keyPrefix + "\uffff"))
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          cursor.delete()
          cursor.continue()
        }
      }
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
    })
    await removeVerificationDocuments([...records.values()])
    host.remove()
    canvas.width = 0
    canvas.height = 0
  }
  return results
}
