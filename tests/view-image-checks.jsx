/**
 * M18 图片替换与格式标记专项使用真实 Workspace、图片解码、IndexedDB 和导出服务。
 * 文件输入/选区为明确合成事件；延迟文件头读取覆盖异步竞态，不替代原生文件选择或输入法验收。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import { closeHistory } from "@tiptap/pm/history"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { captureImageSettingsTarget } from "../src/pages/editor/tools/image-settings.js"
import { getDocumentAssets, getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentText } from "../src/pages/editor/tools/document-text.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { TOOLBAR_MODE_KEY, TOOLBAR_MODES } from "../src/pages/editor/tools/toolbar-preferences.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const delay = () => new Promise(resolve => setTimeout(resolve, 40))
const waitFor = async (read, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay() }
  throw new Error(message)
}
const visible = element => !!element?.getClientRects().length && !element.closest("[hidden]") && getComputedStyle(element).visibility !== "hidden"
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(element => visible(element)
  && (element.getAttribute("aria-label") || element.textContent).replace(/\s/g, "") === name.replace(/\s/g, ""))
const content = editor => JSON.stringify(editor.getJSON())
const paragraph = text => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) })
const nodes = (editor, type) => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === type) result.push({ node, pos }) })
  return result
}
const imageAt = (editor, index = 0) => nodes(editor, "image")[index]
const selectImage = (editor, index = 0) => {
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, imageAt(editor, index).pos)))
  editor.view.focus()
}
const marks = (editor, kind) => [...editor.view.dom.querySelectorAll(kind ? `[data-mewoc-format-mark="${kind}"]` : "[data-mewoc-format-mark]")]

function Probe({ onContext }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onContext(context) }, [context, onContext])
  return <EditorWorkspace onDocumentChange={() => {}} />
}

// 保留真实 PNG 字节，只延迟 validateImageBlob 的文件头读取，生产 Image.decode 仍照常执行。
const gatedFile = blob => {
  const file = new File([blob], "延迟替换.png", { type: "image/png" })
  let enter
  let release
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const slice = file.slice.bind(file)
  file.slice = (...args) => {
    const part = slice(...args)
    const arrayBuffer = part.arrayBuffer.bind(part)
    part.arrayBuffer = async () => { enter(); await gate; return arrayBuffer() }
    return part
  }
  return { file, entered, release }
}

const marksFixture = () => ({ type: "doc", content: [
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "格式标记标题" }] },
  paragraph(),
  { type: "paragraph", content: [{ type: "text", text: "普通 空格\u00a0不换行\t制表" }, { type: "hardBreak" }, { type: "text", text: "软换行之后" }] },
  { type: "paragraph", content: [{ type: "hardBreak" }] },
  { type: "bulletList", content: [{ type: "listItem", content: [paragraph("列表正文")] }] },
  { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("已完成待办")] }] },
  { type: "blockquote", content: [paragraph("引用正文")] },
  { type: "table", content: [{ type: "tableRow", content: [
    { type: "tableCell", content: [paragraph("单元格一")] }, { type: "tableCell", content: [paragraph()] }
  ] }] },
  { type: "codeBlock", attrs: { language: "text" }, content: [{ type: "text", text: "代码 空格\t不标记\n下一行" }] },
  { type: "paragraph", content: [{ type: "text", marks: [{ type: "code" }], text: "行内 代码\t不标记" }] }
] })

/** 独立文档/资源 ID 精确清理，保存排空后卸载，结束恢复工具栏和格式标记偏好。 */
export async function runViewImageChecks(report = () => {}) {
  const preferences = new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
  const host = document.createElement("div")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:900px;margin:24px 0"
  document.body.append(host)
  const records = []
  const releases = new Set()
  let current
  const toolbar = () => host.querySelector("[data-toolbar-mode]")
  const activePanel = () => [...host.querySelectorAll('[role="tabpanel"]')].find(visible)
  const menuItem = name => [...document.querySelectorAll('[role="menuitemradio"]')].find(element => visible(element) && element.textContent === name)
  const switchMode = async mode => {
    if (toolbar().dataset.toolbarMode === mode) return
    button(host, "切换工具栏").click()
    const label = TOOLBAR_MODES.find(item => item.key === mode).label
    const item = await waitFor(() => menuItem(label), "M18 工具栏模式菜单未打开")
    item.click()
    await waitFor(() => toolbar().dataset.toolbarMode === mode && !menuItem(label), "M18 工具栏模式未切换")
  }
  const switchTab = async name => {
    if (activePanel()?.getAttribute("aria-label") === `${name}工具`) return activePanel()
    if (toolbar().dataset.toolbarMode === "compact") {
      button(host, "切换工具分组").click()
      const item = await waitFor(() => menuItem(name), `极简模式缺少${name}分组`)
      item.click()
    } else {
      const trigger = [...host.querySelectorAll('[role="tab"]')].find(element => element.textContent === name)
      assert(trigger, `M18 缺少${name}标签`)
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
      trigger.click()
    }
    return waitFor(() => activePanel()?.getAttribute("aria-label") === `${name}工具` && activePanel(), `${name}工具未显示`)
  }
  const setMarks = async value => {
    await switchTab("视图")
    const trigger = button(activePanel(), "格式标记")
    assert(trigger && trigger.hasAttribute("aria-pressed"), "视图缺少格式标记开关按钮")
    if ((trigger.getAttribute("aria-pressed") === "true") !== value) trigger.click()
    await waitFor(() => current.store.getState().formattingMarks === value && (value ? marks(current.editor).length > 0 : marks(current.editor).length === 0), "格式标记开关未同步正文装饰")
  }
  const canvas = document.createElement("canvas")
  canvas.width = 240
  canvas.height = 120
  const png = async color => {
    canvas.getContext("2d").fillStyle = color
    canvas.getContext("2d").fillRect(0, 0, 240, 120)
    return new Promise(resolve => canvas.toBlob(resolve, "image/png"))
  }
  const [originalPng, replacementPng] = [await png("#7659bd"), await png("#26a6ae")]
  const mount = async () => {
    localStorage.removeItem(TOOLBAR_MODE_KEY)
    localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    current = null
    const document = { ...createDocument(), title: `图片与视图验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      content: { type: "doc", content: [paragraph("图片前文"), paragraph("图片后文")] } }
    const assets = new Map()
    const saved = await saveLocalDocument(document, assets, 0)
    records.push({ document, assets })
    ReactDOM.render(<EditorProvider record={{ document, assets, storageVersion: saved.storageVersion }}><Probe onContext={context => { current = context }} /></EditorProvider>, host)
    await waitFor(() => current?.editor && toolbar(), "M18 真实 Workspace 未就绪")
    current.store.getState().updateView({ outlineOpen: false, fitWidth: false, zoom: 1, activeTab: "插入" })
    await switchTab("插入")
    return current
  }
  const seedImages = async (context, count = 1) => {
    const assetId = `m18-image-${Math.random().toString(16).slice(2, 12)}`
    context.assets.set(assetId, { id: assetId, fileName: "原图片.png", mimeType: originalPng.type, byteLength: originalPng.size,
      blob: originalPng, url: URL.createObjectURL(originalPng) })
    context.editor.commands.setContent({ type: "doc", content: [paragraph("图片前文"),
      ...Array.from({ length: count }, (_, index) => ({ type: "image", attrs: { assetId, width: 310.5, height: 190.5, align: "right",
        lockAspectRatio: false, alt: `替代文本${index}`, title: `原说明${index}` } })), paragraph("图片后文")] })
    await waitFor(() => [...context.editor.view.dom.querySelectorAll("figure img")].length === count
      && [...context.editor.view.dom.querySelectorAll("figure img")].every(image => image.complete && image.naturalWidth === 240), "M18 图片未完成真实解码")
    selectImage(context.editor)
    await switchTab("插入")
    return assetId
  }
  const capture = editor => {
    selectImage(editor)
    const target = captureImageSettingsTarget(editor)
    assert(target, "没有捕获原图片目标")
    return target
  }
  const delayedReplace = async context => {
    const gate = gatedFile(replacementPng)
    releases.add(gate.release)
    const completion = context.replaceImage(gate.file, capture(context.editor))
    await gate.entered
    await waitFor(() => current?.uploading, "图片读取期间没有锁定资源入口")
    return { ...gate, completion }
  }
  const uploadViaUi = async editor => {
    selectImage(editor)
    await switchTab("插入")
    const originalId = imageAt(editor).node.attrs.assetId
    const trigger = await waitFor(() => button(activePanel(), "替换图片"), "工具栏没有替换图片入口")
    assert(!trigger.disabled, "选中图片后替换入口仍禁用")
    trigger.click()
    const input = host.querySelector('input[type="file"][aria-label="选择替换图片"]')
    assert(input && !input.multiple, "替换图片不是独立单文件输入")
    const transfer = new DataTransfer()
    transfer.items.add(new File([replacementPng], "替换图片.png", { type: "image/png" }))
    input.files = transfer.files
    input.dispatchEvent(new Event("change", { bubbles: true }))
    await waitFor(() => !current.uploading && imageAt(editor).node.attrs.assetId !== originalId, "UI 图片替换未完成")
  }
  const check = async (name, run) => {
    try { await mount(); await run(current); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
    finally {
      releases.forEach(release => release())
      releases.clear()
      if (current?.editor && !current.editor.isDestroyed) await current.saveDocument()
      ReactDOM.unmountComponentAtNode(host)
      current = null
      await delay()
    }
  }
  try {
    await check("图片替换：两种模式保留尺寸、比例锁定、对齐和说明，分别可撤销重做", async context => {
      for (const mode of ["ribbon", "compact"]) {
        await switchMode(mode)
        const originalId = await seedImages(context)
        const original = content(context.editor)
        const attrs = imageAt(context.editor).node.attrs
        await uploadViaUi(context.editor)
        const replaced = imageAt(context.editor).node.attrs
        assert(replaced.assetId !== originalId, "图片替换未建立新资源身份")
        for (const field of ["width", "height", "align", "lockAspectRatio", "alt", "title"]) assert(replaced[field] === attrs[field], `图片替换改变了${field}`)
        const replacementId = replaced.assetId
        assert(context.assets.has(originalId) && context.assets.has(replacementId), "图片替换没有保留撤销所需的新旧资源")
        context.editor.commands.undo()
        assert(content(context.editor) === original, "一次撤销没有仅恢复原图")
        context.editor.commands.redo()
        assert(imageAt(context.editor).node.attrs.assetId === replacementId, "重做没有恢复替换图片")
      }
    })

    await check("图片替换：取消文件选择不写入，选择前捕获的图片不随后来改选区改变", async context => {
      const originalId = await seedImages(context, 2)
      const trigger = await waitFor(() => button(activePanel(), "替换图片"), "没有替换图片入口")
      const input = host.querySelector('input[type="file"][aria-label="选择替换图片"]')
      const sendFile = () => {
        const transfer = new DataTransfer()
        transfer.items.add(new File([replacementPng], "选择完成.png", { type: "image/png" }))
        input.files = transfer.files
        input.dispatchEvent(new Event("change", { bubbles: true }))
      }
      const before = content(context.editor)
      const size = context.assets.size
      trigger.click()
      input.dispatchEvent(new Event("cancel", { bubbles: true }))
      sendFile()
      await delay()
      assert(content(context.editor) === before && context.assets.size === size && !current.uploading, "取消选择后旧目标仍接收文件或锁定会话")
      selectImage(context.editor)
      trigger.click()
      selectImage(context.editor, 1)
      sendFile()
      await waitFor(() => !current.uploading && imageAt(context.editor).node.attrs.assetId !== originalId, "文件选择完成没有替换开始选择时的图片")
      assert(imageAt(context.editor, 1).node.attrs.assetId === originalId, "文件选择结果误写了后来选中的图片")
    })

    await check("图片替换：读取期间原图移动、说明更新和改选另一图片仍命中原目标", async context => {
      const originalId = await seedImages(context, 2)
      const pending = await delayedReplace(context)
      context.editor.commands.insertContentAt(1, "前方新增", { updateSelection: false })
      context.editor.view.dispatch(context.editor.state.tr.setNodeAttribute(imageAt(context.editor).pos, "title", "期间更新说明"))
      selectImage(context.editor, 1)
      const before = content(context.editor)
      pending.release()
      assert(await pending.completion, "原目标移动后换图失败")
      assert(imageAt(context.editor).node.attrs.assetId !== originalId && imageAt(context.editor, 1).node.attrs.assetId === originalId, "换图跟随了后选图片")
      assert(imageAt(context.editor).node.attrs.title === "期间更新说明", "换图覆盖了读取期间的说明更新")
      context.editor.commands.undo()
      assert(content(context.editor) === before, "撤销换图同时撤掉读取期间的正文或说明更新")
    })

    await check("图片替换：原图删除后同位置同资源重插，旧异步任务不能误写", async context => {
      await seedImages(context)
      const pending = await delayedReplace(context)
      const original = imageAt(context.editor)
      context.editor.view.dispatch(context.editor.state.tr.replaceWith(original.pos, original.pos + original.node.nodeSize, original.node.type.create(original.node.attrs)))
      const before = content(context.editor)
      const size = context.assets.size
      pending.release()
      assert(!await pending.completion, "旧任务接受了同位置重插的图片")
      assert(content(context.editor) === before && context.assets.size === size, "目标失效后登记资源或修改了新图片")
      await waitFor(() => !current.uploading, "失效换图任务没有释放资源锁")
    })

    await check("图片替换：只读、文档切换和组合输入中断后恢复也不提交旧任务", async context => {
      await seedImages(context)
      for (const reason of ["readOnly", "switching", "composition"]) {
        const before = content(context.editor)
        const size = context.assets.size
        const pending = await delayedReplace(context)
        if (reason === "composition") {
          context.editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
          context.editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
          await waitFor(() => !context.editor.view.composing, "合成组合输入没有结束")
        } else {
          context.store.getState().updateView({ [reason]: true })
          await waitFor(() => !context.editor.isEditable, "禁写状态未锁定正文")
          context.store.getState().updateView({ [reason]: false })
          await waitFor(() => context.editor.isEditable, "恢复编辑未生效")
        }
        pending.release()
        assert(!await pending.completion && content(context.editor) === before && context.assets.size === size, `${reason}恢复后仍提交了过期换图任务`)
        await waitFor(() => !current.uploading, "换图中断没有释放资源锁")
      }
      assert(await context.replaceImage(new File([replacementPng], "恢复后替换.png", { type: "image/png" }), capture(context.editor)), "中断后无法重新开始换图")
    })

    await check("图片替换：保存回收磁盘旧 Blob，撤销再保存恢复完整字节，导出只含当前图片", async context => {
      const originalId = await seedImages(context)
      assert(await context.saveDocument(), "原图未保存")
      const original = context.getSnapshot()
      assert(await context.replaceImage(new File([replacementPng], "导出换图.png", { type: "image/png" }), capture(context.editor)), "换图未完成")
      assert(await context.saveDocument(), "替换图未保存")
      const replaced = context.getSnapshot()
      const replacementId = replaced.assets[0].id
      const disk = await getLocalDocument(replaced.id)
      const stored = await getDocumentAssets(disk.document)
      assert(stored.size === 1 && stored.has(replacementId) && context.assets.has(originalId), "持久引用或会话撤销资源不正确")
      let missing = false
      try { await getDocumentAssets(original) } catch (error) { missing = error.message.includes("资源缺失") }
      assert(missing, "保存替换图后磁盘旧 Blob 未回收")
      const portable = await createPortableFile(replaced, context.assets)
      assert(Object.keys(portable.assetData).length === 1 && !portable.assetData[originalId], "便携导出包含旧图撤销缓存")
      const imported = await readPortableFile(new File([JSON.stringify(portable)], "换图.mewoc.json"))
      assert(imported.assets.size === 1 && imported.assets.has(replacementId), "便携文件没有保留新图片")
      const expectedReplacement = new Uint8Array(await replacementPng.arrayBuffer())
      const exportedReplacement = new Uint8Array(await imported.assets.get(replacementId).blob.arrayBuffer())
      assert(exportedReplacement.length === expectedReplacement.length && exportedReplacement.every((byte, index) => byte === expectedReplacement[index]), "便携导出改变图片字节")
      const html = new DOMParser().parseFromString(await createDocumentHtml(replaced, context.assets), "text/html")
      const image = html.querySelector("article img")
      assert(image?.getAttribute("data-mewoc-asset-id") === replacementId && image.src === portable.assetData[replacementId], "HTML 导出不是替换后的图片")
      context.editor.commands.undo()
      assert(context.getSnapshot().assets[0].id === originalId && await context.saveDocument(), "撤销换图后原资源未恢复保存")
      const restored = await getDocumentAssets(context.getSnapshot())
      const expectedOriginal = new Uint8Array(await originalPng.arrayBuffer())
      const restoredOriginal = new Uint8Array(await restored.get(originalId).blob.arrayBuffer())
      assert(restoredOriginal.length === expectedOriginal.length && restoredOriginal.every((byte, index) => byte === expectedOriginal[index]), "撤销保存改变原图字节")
    })

    await check("图片替换：会话卸载后迟到的解码结果不写入旧正文或资源", async context => {
      await seedImages(context)
      const pending = await delayedReplace(context)
      const before = content(context.editor)
      const size = context.assets.size
      await context.saveDocument()
      ReactDOM.unmountComponentAtNode(host)
      current = null
      pending.release()
      assert(!await pending.completion && content(context.editor) === before && context.assets.size === size, "会话卸载后旧任务仍写入图片")
    })

    await check("格式标记：两种模式启闭保留正文、选区和修改序号，撤销只撤正文输入", async ({ editor, store }) => {
      editor.commands.setContent(marksFixture())
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 5)))
      const before = content(editor)
      const selection = JSON.stringify(editor.state.selection.toJSON())
      const revision = store.getState().revision
      for (const mode of ["ribbon", "compact"]) {
        await switchMode(mode)
        await setMarks(true)
        await setMarks(false)
        assert(content(editor) === before && JSON.stringify(editor.state.selection.toJSON()) === selection && store.getState().revision === revision, "格式标记改变了正文、选区或修改序号")
      }
      editor.view.dispatch(closeHistory(editor.state.tr))
      editor.commands.insertContentAt(2, "用户输入")
      editor.view.dispatch(closeHistory(editor.state.tr))
      await setMarks(true)
      await setMarks(false)
      editor.commands.undo()
      assert(content(editor) === before, "格式标记占用了正文撤销步骤")
    })

    await check("格式标记：空段、软换行、列表、待办、引用和单元格均显示，代码区保持原样", async ({ editor }) => {
      editor.commands.setContent(marksFixture())
      await setMarks(true)
      assert(marks(editor, "paragraph").length === nodes(editor, "paragraph").length + nodes(editor, "heading").length, "段落结束标记缺少空段或嵌套段落")
      assert(marks(editor, "hardBreak").length === 2, "软换行标记数量不正确")
      for (const kind of ["space", "nbsp", "tab"]) assert(marks(editor, kind).length === 1, `${kind}空白标记包含代码或遗漏正文`)
      assert(!editor.view.dom.querySelector("pre [data-mewoc-format-mark], code [data-mewoc-format-mark]"), "格式标记进入代码内容")
      for (const marker of [...marks(editor, "paragraph"), ...marks(editor, "hardBreak")]) assert(marker.getAttribute("aria-hidden") === "true" && marker.contentEditable === "false", "段落或软换行标记进入可编辑/读屏内容")
      const count = marks(editor, "paragraph").length
      editor.commands.insertContentAt(editor.state.doc.content.size, paragraph("新增段落"))
      await waitFor(() => marks(editor, "paragraph").length === count + 1, "正文新增段落后标记没有更新")
    })

    await check("格式标记：只读和切换时隐藏，恢复沿用偏好且新的会话读取开关", async ({ editor, store }) => {
      editor.commands.setContent(marksFixture())
      await setMarks(true)
      const before = content(editor)
      for (const key of ["readOnly", "switching"]) {
        store.getState().updateView({ [key]: true })
        await waitFor(() => !editor.isEditable && !marks(editor).length, "禁写状态仍显示格式标记")
        assert(store.getState().formattingMarks && button(activePanel(), "格式标记").getAttribute("aria-pressed") === "true", "暂时隐藏丢失格式标记偏好")
        store.getState().updateView({ [key]: false })
        await waitFor(() => editor.isEditable && marks(editor).length > 0, "恢复编辑没有恢复格式标记")
      }
      assert(content(editor) === before && localStorage.getItem(FORMATTING_MARKS_KEY) === "true", "只读切换改正文或没有保存标记偏好")
      await current.saveDocument()
      ReactDOM.unmountComponentAtNode(host)
      current = null
      const record = records.at(-1)
      const saved = await getLocalDocument(record.document.id)
      ReactDOM.render(<EditorProvider record={{ document: saved.document, assets: record.assets, storageVersion: saved.storageVersion }}><Probe onContext={context => { current = context }} /></EditorProvider>, host)
      await waitFor(() => current?.editor && current.store.getState().formattingMarks && marks(current.editor).length > 0, "重开会话没有沿用格式标记偏好")
    })

    await check("格式标记：JSON、HTML、Markdown、纯文本和剪贴板均不携带编辑装饰", async context => {
      context.editor.commands.setContent(marksFixture())
      const before = context.getSnapshot()
      const textBefore = createDocumentText(before)
      const markdownBefore = (await createDocumentMarkdown(before)).source
      const htmlBefore = await createDocumentHtml(before, context.assets)
      await setMarks(true)
      const snapshot = context.getSnapshot()
      assert(JSON.stringify(snapshot.content) === JSON.stringify(before.content), "格式标记写入文档 JSON")
      const portable = await createPortableFile(snapshot, context.assets)
      assert(!JSON.stringify(portable).includes("data-mewoc-format-mark"), "便携备份携带编辑装饰")
      assert(createDocumentText(snapshot) === textBefore && (await createDocumentMarkdown(snapshot)).source === markdownBefore, "格式标记污染纯文本或 Markdown 导出")
      assert(await createDocumentHtml(snapshot, context.assets) === htmlBefore, "格式标记改变静态 HTML 输出")
      const copied = context.editor.view.serializeForClipboard(context.editor.state.doc.slice(0, context.editor.state.doc.content.size))
      assert(!copied.dom.querySelector("[data-mewoc-format-mark]") && !/[¶↵]/.test(copied.text), "剪贴板携带格式标记符号或装饰")
    })

    await check("格式标记：启闭不改变段落和纸面尺寸，三个缩放比例中的文字坐标一致", async ({ editor, store }) => {
      editor.commands.setContent({ type: "doc", content: [paragraph("连续正文 含有空格，需要在页面中自然换行。".repeat(18)), paragraph(),
        { type: "paragraph", content: [{ type: "text", text: "软换行之前" }, { type: "hardBreak" }, { type: "text", text: "软换行之后" }] }] })
      const shape = () => ({
        height: editor.view.dom.offsetHeight,
        blocks: [...editor.view.dom.querySelectorAll("p")].map(element => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height] }),
        points: [1, 20, 60, editor.state.doc.content.size - 2].map(position => { const rect = editor.view.coordsAtPos(position); return [rect.left, rect.top, rect.bottom] })
      })
      await switchTab("视图")
      for (const zoom of [0.75, 1, 1.25]) {
        store.getState().updateView({ zoom })
        await delay()
        const before = shape()
        await setMarks(true)
        const after = shape()
        assert(before.height === after.height, `缩放${zoom}时格式标记改变正文高度`)
        for (const key of ["blocks", "points"]) assert(before[key].every((rect, index) => rect.every((value, part) => Math.abs(value - after[key][index][part]) < 0.25)), `缩放${zoom}时格式标记改变段落或文字坐标`)
        await setMarks(false)
      }
    })

    await check("格式标记：首个空段提示留在首行，开始输入后恢复普通正文", async ({ editor }) => {
      editor.commands.setContent({ type: "doc", content: [paragraph()] })
      await switchTab("视图")
      const empty = editor.view.dom.querySelector("p")
      const before = empty.getBoundingClientRect()
      await setMarks(true)
      const after = empty.getBoundingClientRect()
      const placeholder = getComputedStyle(empty, "::after")
      assert(Math.abs(before.height - after.height) < 0.25, "空段标记改变首行高度")
      assert(placeholder.position === "absolute" && placeholder.top === "0px" && parseFloat(placeholder.left) > 0,
        "空段提示被光标辅助换行推到下一行，或与段落标记重叠")
      editor.commands.setTextSelection(1)
      editor.commands.insertContent("开始写作")
      assert(editor.getText() === "开始写作" && !editor.view.dom.querySelector(".is-editor-empty"), "开始输入后仍保留空段提示")
    })
  } finally {
    releases.forEach(release => release())
    if (current?.editor && !current.editor.isDestroyed) await current.saveDocument()
    ReactDOM.unmountComponentAtNode(host)
    host.remove()
    await removeVerificationDocuments(records)
    for (const [key, value] of preferences) {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    }
  }
}
