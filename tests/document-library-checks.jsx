/**
 * 文档库浏览器验收覆盖保存后打开、搜索排序分页、重命名、复制、回收恢复与陈旧版本冲突。
 * 真实 FileActions 与 IndexedDB 贯通，检查资源元信息和原始字节，不依赖假保存成功回调。
 */
import { useEffect, useState } from "react"
import ReactDOM from "react-dom"
import { EditorContent } from "@tiptap/react"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { FileActions } from "../src/pages/editor/components/FileActions.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentAssetUrl } from "../src/pages/editor/tools/attachment-assets.js"
import { getDocuments, getLocalDocument, getDocumentAssets, saveLocalDocument, renameLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
// 轮询真实 UI/仓库条件，条件可异步读取；固定超时防止失败保存或 portal 状态卡住整组验收。
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const result = await read()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}
// 文档库主层与嵌套确认层按各自宿主查询，标准化空白避免 AntD 文案布局影响匹配。
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(node => node.textContent.replace(/\s/g, "") === name.replace(/\s/g, ""))
const libraryDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(node => node.querySelector('[aria-label="文档搜索"]'))
const row = id => libraryDialog()?.querySelector(`[data-document-id="${id}"]`)
const rows = () => [...(libraryDialog()?.querySelectorAll("[data-document-id]") || [])]
// 用原生 setter 触发 React 受控输入的真实事件链，Select 与 Input 分别发送对应 change/input。
const setInput = (element, value) => {
  assert(element, "输入控件不存在")
  // 原生 setter 保留 React 17 的受控输入事件链，直接赋值会被 value tracker 忽略。
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }))
}
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })

// 渲染真实文件操作与正文，暴露会话服务便于核对打开库前保存、选区和撤销是否保留。
function LibraryProbe({ onContext, onRecordChange }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onContext(context) }, [context, onContext])
  return <section style={{ width: 640, margin: 20 }}>
    <FileActions onDocumentChange={onRecordChange} />
    <EditorContent editor={context.editor} />
  </section>
}

// 通过 React key 随文档 ID 重建 Provider，让库打开和回收当前记录覆盖生产会话切换流程。
function LibrarySession({ initialRecord, onContext, onRecord }) {
  const [record, setRecord] = useState(initialRecord)
  const changeRecord = nextRecord => { onRecord(nextRecord); setRecord(nextRecord) }
  return <EditorProvider key={record.document.id} record={record}>
    <LibraryProbe onContext={onContext} onRecordChange={changeRecord} />
  </EditorProvider>
}

/**
 * 这些检查把真实 FileActions、保存队列和 IndexedDB 连在一起；不是用假 save 回调证明落盘。
 * 每轮都记录自己创建的 ID，卸载会话后仅删除这些文档及其已知资源，不清空用户数据库。
 */
export async function runDocumentLibraryChecks(report) {
  // 唯一前缀用于发现本轮新副本，精确记录表用于清理；不会清空整座用户数据库。
  const prefix = `文档库验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const cleanup = new Map()
  const host = document.createElement("div")
  document.body.append(host)
  let current = null
  // 切换/复制产生的新记录也加入清理表，缺运行时资源时按文档元信息建立已知引用集合。
  const track = record => {
    cleanup.set(record.document.id, { document: record.document, assets: record.assets || new Map(record.document.assets.map(asset => [asset.id, asset])) })
    return record
  }
  // 先销毁编辑器与保存队列，再等待库和重命名 portal 卸载，隔离后续场景。
  const unmount = async () => {
    ReactDOM.unmountComponentAtNode(host)
    current = null
    await waitFor(() => !libraryDialog() && !document.querySelector('[aria-label="新文档标题"]'), "文档库弹窗未卸载")
  }
  // 为仓库恢复的 Blob 创建当前会话 URL，随后 Provider 拥有回收职责；就绪条件还核对目标文档 ID。
  const mount = async record => {
    await unmount()
    record.assets.forEach(asset => { asset.url = createDocumentAssetUrl(asset) })
    ReactDOM.render(<LibrarySession initialRecord={record} onContext={context => { current = context }} onRecord={track} />, host)
    return waitFor(() => current?.editor && current.documentId === record.document.id && current, "真实编辑器会话未就绪")
  }
  // fixture 元信息剥离 blob/url 后持久化，正文可含真实图片与附件，便于验证复制和恢复字节独立性。
  const seed = async (title, text = title, assets = new Map()) => {
    const document = { ...createDocument(), title: `${prefix}-${title}`, content: { type: "doc", content: [paragraph(text)] } }
    document.assets = [...assets.values()].map(({ blob: _blob, url: _url, ...metadata }) => metadata)
    if (assets.size) document.content.content.push(
      { type: "image", attrs: { assetId: "library-image", width: 32, height: 16 } },
      { type: "attachment", attrs: { assetId: "library-attachment" } },
      { type: "paragraph" }
    )
    track({ document, assets })
    const saved = await saveLocalDocument(document, assets, 0)
    return { id: document.id, document, assets, storageVersion: saved.storageVersion }
  }
  // 只有保存协调完成且入口可用时点击库按钮，等待真实搜索控件出现后才执行列表操作。
  const open = async () => {
    const trigger = await waitFor(() => button(host, "文档库")?.disabled === false && button(host, "文档库"), "文档库入口不可用")
    trigger.click()
    return waitFor(() => libraryDialog()?.querySelector('[aria-label="文档搜索"]') && libraryDialog(), "文档库未打开")
  }
  // 标题搜索走 UI 输入，短暂等待 React 更新筛选后的本地列表，不另行模拟仓库搜索。
  const search = async value => {
    setInput(libraryDialog()?.querySelector('[aria-label="文档搜索"]'), value)
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  // 等待指定记录行的动作可用后点击，避免 loading/切换期间误测禁用控件。
  const action = async (id, name) => {
    const control = await waitFor(() => button(row(id), name)?.disabled === false && button(row(id), name), `${name}操作不可用`)
    control.click()
  }
  // 重命名经嵌套确认表单，覆盖草稿校验和父级版本保护，不能直接替换仓库标题绕过流程。
  const rename = async (id, title) => {
    await action(id, "重命名")
    const input = await waitFor(() => document.querySelector('[aria-label="新文档标题"]'), "重命名输入未出现")
    setInput(input, title)
    const dialog = input.closest('[role="dialog"]')
    const submit = button(dialog, "保存名称")
    assert(submit, "重命名确认按钮不存在")
    submit.click()
  }
  // 回收必须通过实际确认层，区分库主列表按钮和确认按钮，验证完整用户动作链。
  const trash = async id => {
    await action(id, "移入回收站")
    const confirmation = await waitFor(() => [...document.querySelectorAll('[role="dialog"]')].find(node => node !== libraryDialog() && (button(node, "移入回收站") || button(node, "确定"))), "移入回收站未出现确认")
    const submit = button(confirmation, "移入回收站") || button(confirmation, "确定")
    submit.click()
  }
  const tab = name => [...libraryDialog().querySelectorAll('[role="tab"]')].find(node => node.textContent === name)
  // 恢复/复制的资源从仓库再次读取并加入精确清理，断言不会只依赖原会话内存 Map。
  const readAssets = async record => {
    const assets = await getDocumentAssets(record.document)
    track({ ...record, assets })
    return assets
  }
  // 单项异常记录失败后继续；每项卸载会话，延迟自动保存不会影响下一项库版本。
  const check = async (name, run) => {
    try { await run(); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
    finally { await unmount() }
  }
  // 生成实际可解码 PNG 与附件 Blob，资源断言覆盖数据本身而非只检查节点数量。
  const canvas = document.createElement("canvas")
  canvas.width = 32
  canvas.height = 16
  canvas.getContext("2d").fillRect(0, 0, 32, 16)
  const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
  const attachment = new Blob(["文档库复制与恢复的附件字节"], { type: "text/plain" })
  const assets = () => new Map([
    ["library-image", { id: "library-image", fileName: "验收图片.png", mimeType: png.type, byteLength: png.size, blob: png }],
    ["library-attachment", { id: "library-attachment", kind: "attachment", fileName: "验收附件.txt", mimeType: attachment.type, byteLength: attachment.size, blob: attachment }]
  ])
  // 同时比较资源类型、长度和逐字节内容，检验复制/回收恢复是否完整保留原文件。
  const equalAssets = async (left, right) => {
    assert(left.size === 2 && right.size === 2, "图片或附件丢失")
    for (const [id, asset] of left) {
      const other = right.get(id)
      assert(other?.mimeType === asset.mimeType && other.byteLength === asset.byteLength, `资源 ${id} 的元数据改变`)
      const before = new Uint8Array(await asset.blob.arrayBuffer())
      const after = new Uint8Array(await other.blob.arrayBuffer())
      assert(before.length === after.length && before.every((byte, index) => byte === after[index]), `资源 ${id} 的字节改变`)
    }
  }
  try {
    await check("文档库：打开前保存真实编辑器的最新正文和标题", async () => {
      const record = await seed("打开前保存", "原正文")
      const context = await mount(record)
      context.editor.commands.insertContentAt(1, "尚未落盘的正文-")
      context.store.getState().updateTitle(`${prefix}-打开前保存-最新标题`)
      await open()
      const saved = await getLocalDocument(record.id)
      assert(saved.storageVersion > record.storageVersion && saved.document.content.content[0].content[0].text === "尚未落盘的正文-原正文", "打开文档库没有先提交最新正文")
      assert(saved.document.title.endsWith("最新标题") && saved.storageVersion === context.getStorageVersion(), "标题或保存版本未同步")
      await search(`${prefix}-打开前保存`)
      await waitFor(() => row(record.id), "已保存的当前文档不在文档库")
    })
    await check("文档库：标题按字面搜索、排序、分页并隔离回收站", async () => {
      const records = []
      for (let index = 0; index < 9; index += 1) records.push(await seed(`分页-${String(index).padStart(2, "0")}${index === 1 ? " [.*]" : ""}`))
      await mount(records[0])
      await open()
      await search("[.*")
      await waitFor(() => rows().length === 1 && row(records[1].id), "特殊字符被当成正则或标题未按字面搜索")
      await search(`${prefix}-分页-`)
      const sort = libraryDialog().querySelector('[aria-label="文档排序"]')
      assert(sort, "文档排序控件缺失")
      // rc-select 把展开处理器挂在 selector 上，外层带 aria-label 的根节点不负责展开。
      const selector = sort.closest(".ant-select")?.querySelector(".ant-select-selector")
      assert(selector, "文档排序缺少实际选择区域")
      selector.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
      const titleOption = await waitFor(() => [...document.querySelectorAll(".ant-select-item-option")].find(item => item.textContent === "按标题排序"), "按标题排序选项未出现")
      titleOption.click()
      await waitFor(() => rows().length === 6 && rows().every((node, index) => node.dataset.documentId === records[index].id), "标题排序或首屏 6 份分页错误")
      const next = libraryDialog().querySelector(".ant-pagination-next button")
      assert(next && !next.disabled, "下一页不可用")
      next.click()
      await waitFor(() => rows().length === 3 && rows().every((node, index) => node.dataset.documentId === records[index + 6].id), "第二页文档错误")
      assert(tab("回收站"), "回收站标签缺失")
      tab("回收站").click()
      await waitFor(() => rows().length === 0, "活跃文档进入回收站列表")
    })
    // 当前标题修改应进入原保存队列，保留正文 editor/选区/撤销；文档 ID 不因改名变化。
    await check("文档库：当前重命名保留编辑器、撤销历史并继续保存", async () => {
      const record = await seed("重命名", "原正文")
      const context = await mount(record)
      context.editor.commands.insertContentAt(1, "可撤销的编辑-")
      await open()
      await search(record.document.title)
      await waitFor(() => row(record.id), "重命名目标未出现")
      const title = `${prefix}-重命名-完成`
      await rename(record.id, title)
      await waitFor(async () => (await getLocalDocument(record.id))?.document.title === title && !document.querySelector('[aria-label="新文档标题"]'), "当前文档标题未保存")
      assert(current.editor === context.editor && current.documentId === record.id, "重命名重建了正文会话")
      assert(context.store.getState().title === title && context.editor.can().undo(), "标题或撤销历史丢失")
      const version = context.getStorageVersion()
      context.editor.commands.insertContentAt(1, "继续编辑-")
      assert(await context.saveDocument(), "重命名后的编辑保存失败")
      assert((await getLocalDocument(record.id)).storageVersion === version + 1, "重命名后存储版本没有继续同步")
      assert(context.editor.commands.undo() && !context.editor.getText().startsWith("继续编辑-"), "重命名后撤销不能撤回后续编辑")
      assert(await context.saveDocument(), "撤销后的正文不能保存")
    })
    await check("文档库：复制最新正文及图片附件字节且保持当前会话", async () => {
      const record = await seed("复制资源", "原正文", assets())
      const context = await mount(record)
      context.editor.commands.insertContentAt(1, "复制前最新正文-")
      await open()
      await search(record.document.title)
      await waitFor(() => row(record.id), "复制目标未出现")
      await action(record.id, "复制")
      const copy = await waitFor(async () => (await getDocuments()).find(item => item.document.title === `${record.document.title} - 副本`), "副本未写入数据库")
      track(copy)
      assert(copy.id !== record.id && current.documentId === record.id && current.editor === context.editor, "复制复用了 ID 或切换了会话")
      assert(copy.document.content.content[0].content[0].text.startsWith("复制前最新正文-"), "副本缺少最新正文")
      await equalAssets(record.assets, await readAssets(copy))
      await equalAssets(record.assets, await readAssets(await getLocalDocument(record.id)))
      await waitFor(() => row(copy.id), "副本未显示在文档库")
    })
    await check("文档库：打开时重新读取目标的最新版本和真实资源", async () => {
      const target = await seed("打开目标", "目标旧正文", assets())
      const record = await seed("打开目标-当前", "当前原正文")
      const context = await mount(record)
      context.editor.commands.insertContentAt(1, "切换前保存-")
      await open()
      await search(target.document.title)
      await waitFor(() => row(target.id), "打开目标未出现")
      const externalDocument = { ...target.document, content: structuredClone(target.document.content), updatedAt: new Date().toISOString() }
      externalDocument.content.content[0] = paragraph("其他标签页保存的目标最新正文")
      const external = await saveLocalDocument(externalDocument, target.assets, target.storageVersion)
      await action(target.id, "打开")
      await waitFor(() => current?.documentId === target.id && current?.editor, "打开目标未切换真实编辑器")
      assert(current.editor !== context.editor && current.editor.getText().startsWith("其他标签页保存的目标最新正文"), "打开复用了旧会话或陈旧列表正文")
      assert(current.getStorageVersion() === external.storageVersion, "打开没有使用目标最新保存版本")
      await equalAssets(target.assets, current.assets)
      for (const asset of current.assets.values()) {
        assert(asset.url?.startsWith("blob:"), "打开的资源没有创建会话 URL")
        const loaded = await fetch(asset.url)
        assert(loaded.ok && (await loaded.blob()).size === asset.byteLength, "打开的资源 URL 无法读取")
      }
      const previous = await getLocalDocument(record.id)
      assert(previous.document.content.content[0].content[0].text === "切换前保存-当前原正文", "打开时旧会话最新正文没有落盘")
      await waitFor(() => !libraryDialog(), "打开成功后文档库没有关闭")
    })
    await check("文档库：背景文档回收与恢复保留图片附件", async () => {
      const background = await seed("背景回收资源", "背景正文", assets())
      const record = await seed("背景回收-当前", "当前会话正文")
      const context = await mount(record)
      await open()
      await search(background.document.title)
      await waitFor(() => row(background.id), "背景文档未出现")
      await trash(background.id)
      const deleted = await waitFor(async () => { const item = await getLocalDocument(background.id, { includeDeleted: true }); return item?.deletedAt && item }, "背景文档未移入回收站")
      assert(!await getLocalDocument(background.id), "默认读取还能打开回收文档")
      await equalAssets(background.assets, await readAssets(deleted))
      await waitFor(() => !row(background.id), "回收文档仍在活跃列表")
      tab("回收站").click()
      await waitFor(() => row(background.id), "回收文档未进入回收站列表")
      await action(background.id, "恢复")
      const restored = await waitFor(async () => getLocalDocument(background.id), "恢复没有提交到本地数据库")
      assert(restored.storageVersion === deleted.storageVersion + 1 && current.editor === context.editor, "恢复版本或当前会话错误")
      await equalAssets(background.assets, await readAssets(restored))
      await waitFor(() => !row(background.id), "已恢复的文档仍在回收站")
    })
    // 回收当前记录必须结束旧会话并创建空白，随后等待自动保存窗口验证旧队列不会复活回收记录。
    await check("文档库：回收当前文档切到空白会话且自动保存不能复活", async () => {
      const record = await seed("当前回收", "当前正文", assets())
      const context = await mount(record)
      context.editor.commands.insertContentAt(1, "回收前最新正文-")
      await open()
      await search(record.document.title)
      await waitFor(() => row(record.id), "当前回收目标未出现")
      await trash(record.id)
      await waitFor(() => current?.documentId !== record.id && current?.editor, "回收当前文档后未切换空白会话")
      assert(current.editor.getText() === "" && current.assets.size === 0, "新会话带入了旧正文或资源")
      assert(await current.saveDocument(), "回收后新建空白文档不能保存")
      const deleted = await getLocalDocument(record.id, { includeDeleted: true })
      assert(deleted?.deletedAt && deleted.document.content.content[0].content[0].text.startsWith("回收前最新正文-"), "回收前正文未保存或回收状态丢失")
      assert(!await context.saveDocument(), "已卸载旧会话仍可执行自动保存")
      let rejected = false
      try { await saveLocalDocument(deleted.document, record.assets, deleted.storageVersion) }
      catch (error) { rejected = error.code === "DOCUMENT_TRASHED" }
      assert(rejected && !await getLocalDocument(record.id), "持有最新版本的旧会话仍可复活回收文档")
      await equalAssets(record.assets, await readAssets(deleted))
    })
    // 通过直接仓库写入模拟另一个标签页版本变化，UI 陈旧操作必须拒绝并让原会话继续编辑/保存。
    await check("文档库：陈旧列表变更冲突显示错误并保留当前正文", async () => {
      const background = await seed("并发-背景", "背景原正文")
      const record = await seed("并发-当前", "当前正文")
      const context = await mount(record)
      context.editor.commands.insertContentAt(1, "保留当前编辑-")
      await open()
      await search(background.document.title)
      await waitFor(() => row(background.id), "并发目标未出现")
      const externalTitle = `${prefix}-并发-其他标签页标题`
      const external = await renameLocalDocument(background.id, externalTitle, background.storageVersion)
      await rename(background.id, `${prefix}-并发-陈旧操作`)
      await waitFor(() => [...document.querySelectorAll('[role="alert"]')].some(node => node.textContent.includes("另一标签页")), "陈旧列表冲突未显示错误")
      assert(current.editor === context.editor && context.editor.getText() === "保留当前编辑-当前正文" && context.editor.isEditable, "失败操作替换或冻结了当前正文")
      const saved = await getLocalDocument(background.id)
      assert(saved.document.title === externalTitle && saved.storageVersion === external.storageVersion, "陈旧列表覆盖了其他标签页结果")
      assert(await context.saveDocument(), "冲突后当前会话不能继续保存")
    })
  // 先卸载保存所有者，再按本轮前缀找回可能已写成功但断言失败的副本，最终按精确 ID 删除。
  } finally {
    await unmount()
    // 操作已写入而断言随后失败时，也收拢本轮带唯一标题前缀的副本资源。
    const records = [...await getDocuments(), ...await getDocuments({ deleted: true })]
    records.filter(record => record.document.title.startsWith(prefix)).forEach(track)
    await removeVerificationDocuments([...cleanup.values()])
    host.remove()
    canvas.width = 0
    canvas.height = 0
  }
}
