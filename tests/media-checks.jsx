/**
 * M24 真实浏览器专项：原生 WAV/WebM 解码与时钟、正式 Workspace、IndexedDB 和导出闭环。
 * 文件框 click 被测试监听取消默认弹框后，明确以 DataTransfer 送入 File；选区/IME 为合成事件。
 * 只创建和清理 M24/M25 专用端口中本轮确实创建的 ID，不宣称合成动作等于物理键鼠或原生选择器。
 */
import { useEffect, useState } from "react"
import ReactDOM from "react-dom"
import JSZip from "jszip"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { DocumentHistoryAction } from "../src/pages/editor/components/DocumentHistoryAction.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { captureMediaInsertionTarget, removeMedia } from "../src/pages/editor/tools/media-commands.js"
import { readMediaFile } from "../src/pages/editor/tools/media-assets.js"
import { createDocumentAssetUrl } from "../src/pages/editor/tools/attachment-assets.js"
import { getDocumentAssets, getLocalDocument, saveLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"
import { createDocumentTemplate, instantiateDocumentTemplate, deleteDocumentTemplate } from "../src/pages/editor/tools/document-template-repository.js"
import { createDocumentHtml, createPortableFile, readPortableFile } from "../src/pages/editor/tools/file-transfer.js"
import { createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { createDocumentText, getDocumentTextWarnings } from "../src/pages/editor/tools/document-text.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { MEDIA_PRINT_WARNING } from "../src/pages/editor/tools/media-export.js"
import { TOOLBAR_MODE_KEY, TOOLBAR_MODES } from "../src/pages/editor/tools/toolbar-preferences.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { createMediaFixtures } from "./media-fixtures.js"
import { removeVerificationDocuments } from "./browser-checks.js"

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const delay = (milliseconds = 40) => new Promise(resolve => setTimeout(resolve, milliseconds))
const waitFor = async (read, message) => { const end = Date.now() + 15000; while (Date.now() < end) { const value = await read(); if (value) return value; await delay() } throw new Error(message) }
const visible = element => !!element?.getClientRects().length && !element.closest("[hidden]") && getComputedStyle(element).visibility !== "hidden"
const button = (host, name) => [...(host?.querySelectorAll("button") || [])].find(element => visible(element) && (element.getAttribute("aria-label") || element.textContent).replace(/\s/g, "") === name.replace(/\s/g, ""))
const dialog = name => [...document.querySelectorAll('[role="dialog"]')].find(element => visible(element) && element.querySelector(".ant-modal-title")?.textContent === name)
const json = value => JSON.stringify(value)
const stableSnapshot = context => { const { updatedAt: _updatedAt, ...snapshot } = context.getSnapshot(); return json({ snapshot, revision: context.store.getState().revision }) }
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const content = () => ({ type: "doc", content: [paragraph("第一段插入位置。"), paragraph("第二段保留完整。"), paragraph("第三段用于映射目标。") ] })
const preferences = () => new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
const restorePreferences = saved => { for (const [key, value] of saved) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } }
const mediaNodes = editor => {
  const nodes = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "media") nodes.push({ node, pos }) })
  return nodes
}
const selectParagraph = (editor, index = 0, offset = 1) => {
  const nodes = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "paragraph") nodes.push({ node, pos }) })
  const target = nodes.at(index)
  assert(target && offset <= target.node.content.size + 1, "媒体插入段落不存在")
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target.pos + offset)))
}
const selectMedia = (editor, index = 0) => {
  const target = mediaNodes(editor)[index]
  assert(target, "没有可选择的媒体节点")
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, target.pos)))
}
const players = editor => [...editor.view.dom.querySelectorAll("[data-media-player]")]
const sameBytes = async (left, right) => {
  const [a, b] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()])
  const first = new Uint8Array(a); const second = new Uint8Array(b)
  return first.length === second.length && first.every((byte, index) => byte === second[index])
}
const playable = async player => {
  assert(player instanceof HTMLMediaElement, "正文没有原生播放器")
  await waitFor(() => player.readyState >= 1 && !player.error, "原生播放器未识别媒体元数据")
  if (player instanceof HTMLVideoElement) assert(player.videoWidth === 480 && player.videoHeight === 270, "视频未解码到真实画面尺寸")
  assert(player.controls && player.preload === "metadata" && !player.autoplay, "播放器缺少原生控件或意外自动播放")
  return player
}
const exercisePlayback = async player => {
  await playable(player)
  player.muted = true
  player.currentTime = 0
  await player.play()
  await waitFor(() => !player.paused && player.currentTime > 0.15, "原生播放时钟没有实际增加")
  const progressed = player.currentTime
  player.pause()
  await delay(120)
  assert(player.paused && Math.abs(player.currentTime - progressed) < 0.08, "暂停后媒体仍继续播放")
  player.currentTime = 0.65
  await waitFor(() => !player.seeking && Math.abs(player.currentTime - 0.65) < 0.1, "原生进度定位未生效")
}

function Probe({ onReady, onChange }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onReady(context) }, [context, onReady])
  return <EditorWorkspace onDocumentChange={onChange} />
}

// 只延迟真实文件的读取边界；释放后仍进入生产容器验证和浏览器解码器。
function gatedFile(source) {
  const file = new File([source], `延迟-${source.name}`, { type: source.type })
  let enter; let release
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const read = file.arrayBuffer.bind(file)
  file.arrayBuffer = async () => { enter(); await gate; return read() }
  return { file, entered, release }
}

export async function runMediaChecks(report = () => {}) {
  assert(location.hostname === "127.0.0.1" && ["4189", "4190"].includes(location.port), "媒体验收仅允许在专用 127.0.0.1:4189 或 :4190 运行")
  const fixtures = await createMediaFixtures()
  const savedPreferences = preferences()
  const host = document.createElement("section")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:950px;margin:24px 0"
  document.body.append(host)
  const records = new Map(); const templates = new Map(); const releases = new Set(); const pending = new Set()
  let current
  const capture = context => { current = context }
  const panel = () => [...host.querySelectorAll('[role="tabpanel"]')].find(visible)
  const toolbar = () => host.querySelector("[data-toolbar-mode]")
  function SessionHost({ record }) {
    const [selected, setSelected] = useState(record)
    const change = next => { if (!next.id && !next.storageVersion) records.set(next.document.id, next); setSelected(next) }
    return <EditorProvider key={selected.document.id} record={selected}><Probe onReady={capture} onChange={change} /></EditorProvider>
  }
  const unmount = async () => {
    releases.forEach(release => release()); releases.clear()
    await Promise.allSettled([...pending]); pending.clear()
    if (current?.editor && !current.editor.isDestroyed) {
      current.store.getState().updateView({ readOnly: false, switching: false })
      players(current.editor).forEach(player => player.pause())
      assert(await current.saveDocument(), "媒体专项清理前保存未排空")
    }
    ReactDOM.unmountComponentAtNode(host); current = null
    await waitFor(() => !dialog("历史版本") && !dialog("导出 Word 文档") && !dialog("导出 Markdown"), "媒体专项弹窗未卸载")
  }
  const mount = async record => {
    await unmount()
    localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    if (!record) {
      const document = { ...createDocument(), title: `M24媒体验收-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, content: content() }
      const assets = new Map(); const saved = await saveLocalDocument(document, assets, 0)
      record = { document, assets, storageVersion: saved.storageVersion }
    }
    records.set(record.document.id, record)
    record.assets.forEach(asset => { if (!asset.url) asset.url = createDocumentAssetUrl(asset) })
    ReactDOM.render(<SessionHost key={record.document.id} record={record} />, host)
    await waitFor(() => current?.editor && current.documentId === record.document.id && toolbar(), "媒体正式 Workspace 未就绪")
    current.store.getState().updateView({ activeTab: "插入", outlineOpen: false, fitWidth: false, zoom: 1 })
    await waitFor(() => panel()?.getAttribute("aria-label") === "插入工具", "媒体插入工具未就绪")
    return current
  }
  const switchMode = async mode => {
    if (toolbar().dataset.toolbarMode === mode) return
    button(host, "切换工具栏").click()
    const label = TOOLBAR_MODES.find(item => item.key === mode).label
    const item = await waitFor(() => [...document.querySelectorAll('[role="menuitemradio"]')].find(element => visible(element) && element.textContent === label), "媒体工具栏模式菜单未显示")
    item.click(); await waitFor(() => toolbar().dataset.toolbarMode === mode, "媒体工具栏模式切换失败")
  }
  const input = kind => host.querySelector(`input[aria-label="选择${kind === "audio" ? "音频" : "视频"}"]`)
  const openChooser = async kind => {
    current.store.getState().updateView({ activeTab: "插入" })
    const field = input(kind)
    assert(field && !field.multiple, "媒体没有独立单文件输入")
    field.addEventListener("click", event => event.preventDefault(), { once: true })
    const trigger = await waitFor(() => button(panel(), kind === "audio" ? "音频" : "视频"), "媒体插入按钮不存在")
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
    trigger.click()
    return field
  }
  const chooseFile = (field, file) => {
    const transfer = new DataTransfer(); transfer.items.add(file)
    field.files = transfer.files; field.dispatchEvent(new Event("change", { bubbles: true }))
  }
  const insertViaUi = async kind => {
    const count = mediaNodes(current.editor).length
    const field = await openChooser(kind)
    chooseFile(field, fixtures[kind])
    await waitFor(() => !current.uploading && mediaNodes(current.editor).length === count + 1, `UI ${kind}插入未完成`)
    return playable(players(current.editor).at(-1))
  }
  const insertBoth = async context => {
    for (const kind of ["audio", "video"]) {
      selectParagraph(context.editor, -1)
      assert(await context.insertMedia(fixtures[kind], kind), `${kind}服务插入失败`)
    }
    for (const player of players(context.editor)) await playable(player)
  }
  const tracked = context => captureMediaInsertionTarget(context.editor, {
    canEdit: () => !context.store.getState().readOnly && !context.store.getState().switching,
    subscribeSession: callback => context.store.subscribe(callback)
  })
  const gatedInsert = async context => {
    selectParagraph(context.editor, 0, 3)
    const gate = gatedFile(fixtures.audio); releases.add(gate.release)
    const completion = context.insertMedia(gate.file, "audio", tracked(context)); pending.add(completion)
    await gate.entered; await waitFor(() => current.uploading, "媒体读取未锁定共享资源任务")
    return { ...gate, completion }
  }
  const check = async (name, run) => {
    try { await mount(); const metrics = await run(current); report({ name, passed: true, ...(metrics ? { metrics } : {}) }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
    finally { await unmount() }
  }

  try {
    await check("媒体UI：完整/极简模式分别插入音频视频，原书签与一次撤销重做", async context => {
      for (const mode of ["ribbon", "compact"]) {
        await switchMode(mode)
        for (const kind of ["audio", "video"]) {
          context.editor.commands.setContent(content()); selectParagraph(context.editor, 0, 3)
          const before = json(context.editor.getJSON())
          const field = await openChooser(kind)
          selectParagraph(context.editor, 2)
          chooseFile(field, fixtures[kind])
          await waitFor(() => !current.uploading && mediaNodes(context.editor).length === 1, "文件选择结果没有进入原插入目标")
          assert(mediaNodes(context.editor)[0].pos < 15 && context.editor.state.doc.lastChild.textContent === "第三段用于映射目标。", "文件选择结果跟随了后来的光标")
          const inserted = json(context.editor.getJSON())
          assert(context.editor.commands.undo() && json(context.editor.getJSON()) === before, "媒体插入不能一次独立撤销")
          assert(context.editor.commands.redo() && json(context.editor.getJSON()) === inserted, "媒体重做丢失资源引用")
          await playable(players(context.editor)[0])
        }
      }
      return { chooser: "click默认弹框取消后合成DataTransfer，不替代原生文件选择器", modes: 2, formats: ["WAV", "WebM"] }
    })
    await check("媒体UI：取消选择、选择前只读/组合输入中断，旧目标永不复活", async context => {
      for (const reason of ["cancel", "readOnly", "composition"]) {
        selectParagraph(context.editor)
        const before = json(context.editor.getJSON()); const size = context.assets.size
        const field = await openChooser("audio")
        if (reason === "cancel") field.dispatchEvent(new Event("cancel", { bubbles: true }))
        else if (reason === "readOnly") {
          context.store.getState().updateView({ readOnly: true }); await waitFor(() => !context.editor.isEditable, "只读未启用")
          context.store.getState().updateView({ readOnly: false }); await waitFor(() => context.editor.isEditable, "只读未恢复")
        } else {
          context.editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
          context.editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
          await waitFor(() => !context.editor.view.composing, "合成IME未结束")
        }
        chooseFile(field, fixtures.audio); await delay(200)
        assert(json(context.editor.getJSON()) === before && context.assets.size === size && !current.uploading, `${reason}后仍提交了旧文件选择`)
      }
    })
    await check("原生媒体：MP3/WAV/WebM真实解码、静音播放时钟、暂停及进度定位，无自动播放", async context => {
      await insertBoth(context)
      for (const player of players(context.editor)) { assert(player.paused && player.currentTime === 0, "媒体插入后自动开始播放"); await exercisePlayback(player) }
      selectParagraph(context.editor, 0); assert(await context.insertMedia(fixtures.mp3, "audio"), "静音 MP3 无法通过原生解码检查")
      await exercisePlayback(players(context.editor)[0])
      if (fixtures.mp4) {
        selectParagraph(context.editor, 0); assert(await context.insertMedia(fixtures.mp4, "video"), "本浏览器支持录制的MP4无法插入")
        await exercisePlayback(players(context.editor)[0])
      }
      return { audio: "WAV 4秒原始PCM、MP3 4秒静音帧", video: "WebM原生录制", mp4: fixtures.mp4 ? "原生录制与播放已验证" : "浏览器录制器不支持，未验证MP4播放" }
    })
    await check("媒体NodeView：正文事务与选区改变持续播放，同资源两个播放器彼此独立", async context => {
      selectParagraph(context.editor); await insertViaUi("audio")
      const first = players(context.editor)[0]; first.muted = true; await first.play()
      await waitFor(() => first.currentTime > 0.15, "音频未开始")
      const time = first.currentTime
      selectParagraph(context.editor, 1); context.editor.commands.insertContent("继续编辑")
      assert(players(context.editor)[0] === first && !first.paused, "无关正文事务重建或暂停了播放器")
      await waitFor(() => first.currentTime > time + 0.12, "正文事务后播放时钟停止")
      const assetId = mediaNodes(context.editor)[0].node.attrs.assetId
      context.editor.commands.insertContentAt(context.editor.state.doc.content.size, { type: "media", attrs: { assetId } })
      const second = await playable(players(context.editor)[1]); assert(second !== first && second.paused && second.currentTime === 0 && !first.paused, "同资源播放器共用播放状态")
      second.muted = true; await second.play(); first.pause()
      assert(!second.paused, "暂停第一个播放器停止了第二个")
      first.dispatchEvent(new Event("error")); assert(!first.closest('[data-type="media"]').querySelector("[data-media-error]").hidden, "播放失败没有显示可下载说明")
      assert(first.closest('[data-type="media"]').querySelector("[data-media-download]").href === first.src, "错误卡片丢失原文件下载")
      second.pause()
    })
    await check("媒体只读：原生播放/原文件下载可用，插入删除禁用且资源不变", async context => {
      await insertBoth(context); selectMedia(context.editor)
      const before = json(context.editor.getJSON()); const revision = context.store.getState().revision
      context.store.getState().updateView({ readOnly: true }); await waitFor(() => !context.editor.isEditable && button(panel(), "删除音频")?.disabled, "媒体删除未随只读禁用")
      assert(button(panel(), "音频").disabled && button(panel(), "视频").disabled, "只读仍可打开媒体选择器")
      for (const player of players(context.editor)) await exercisePlayback(player)
      for (const link of context.editor.view.dom.querySelectorAll("[data-media-download]")) {
        const asset = context.assets.get(link.closest('[data-type="media"]').dataset.mewocAssetId)
        assert(link.download === asset.fileName && await sameBytes(await (await fetch(link.href)).blob(), asset.blob), "只读下载改变原格式或字节")
      }
      assert(!await context.insertMedia(fixtures.audio, "audio") && !removeMedia(context.editor), "只读服务仍执行写操作")
      assert(json(context.editor.getJSON()) === before && context.store.getState().revision === revision, "只读播放改变正文修订")
    })
    await check("媒体删除：工具栏一次撤销恢复原字节，旧播放器暂停清源，卸载不后台播放", async context => {
      selectParagraph(context.editor); await insertViaUi("audio")
      const old = players(context.editor)[0]; old.muted = true; await old.play(); await waitFor(() => old.currentTime > 0.15, "删除前未开始播放")
      const before = json(context.editor.getJSON()); const assetId = mediaNodes(context.editor)[0].node.attrs.assetId
      selectMedia(context.editor); const remove = await waitFor(() => button(panel(), "删除音频"), "选中音频没有删除入口")
      remove.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); remove.click()
      assert(!mediaNodes(context.editor).length && old.paused && !old.hasAttribute("src"), "删除节点后旧音频仍播放或保留src")
      assert(context.assets.has(assetId) && context.editor.commands.undo() && json(context.editor.getJSON()) === before, "撤销删除丢失媒体资源")
      const restored = await playable(players(context.editor)[0]); assert(restored !== old && restored.paused, "撤销恢复了旧播放状态")
      restored.muted = true; await restored.play(); await unmount()
      assert(restored.paused && !restored.hasAttribute("src"), "会话卸载后音频仍在后台播放")
    })
    await check("媒体持久化：IndexedDB重开和Mewoc独立往返保持原字节、类型与可播放控件", async context => {
      await insertBoth(context); assert(await context.saveDocument(), "媒体文档保存失败")
      const snapshot = context.getSnapshot(); const saved = await getLocalDocument(context.documentId)
      const assets = await getDocumentAssets(saved.document)
      for (const metadata of saved.document.assets) assert(await sameBytes(assets.get(metadata.id).blob, context.assets.get(metadata.id).blob), "IndexedDB改变媒体字节")
      const portable = await createPortableFile(snapshot, context.assets)
      const imported = await readPortableFile(new File([json(portable)], "媒体.mewoc.json"))
      assert(imported.document.id !== context.documentId && imported.assets.size === 2, "Mewoc往返未建立独立资源文档")
      for (const metadata of snapshot.assets) assert(await sameBytes(imported.assets.get(metadata.id).blob, context.assets.get(metadata.id).blob), "便携媒体字节改变")
      await mount({ ...saved, assets }); for (const player of players(current.editor)) await exercisePlayback(player)
      await mount(imported); assert(mediaNodes(current.editor).length === 2, "便携重开丢失媒体节点")
      for (const player of players(current.editor)) await playable(player)
    })
    await check("媒体HTML：内嵌原格式数据离线解码播放，下载字节一致，打印CSS只保留说明", async context => {
      await insertBoth(context)
      const html = await createDocumentHtml(context.getSnapshot(), context.assets)
      assert(!html.includes("blob:") && html.includes("data:audio/wav;base64,") && html.includes("data:video/webm;base64,"), "HTML保留了临时地址或丢失原格式")
      const frame = document.createElement("iframe"); frame.style.cssText = "width:850px;max-width:100%;height:620px;border:0"; host.append(frame)
      try {
        await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = () => reject(new Error("媒体HTML载入失败")); frame.srcdoc = html })
        const doc = frame.contentDocument
        assert(doc.querySelectorAll("[data-media-player]").length === 2 && !doc.querySelector("[data-resize-handle]"), "HTML不含完整媒体播放器或泄漏编辑控件")
        for (const player of doc.querySelectorAll("[data-media-player]")) {
          // iframe 播放器属于另一个 Realm，不用本窗 instanceof 代替真实元数据校验。
          await waitFor(() => player.readyState >= 1 && !player.error, "HTML原生解码未就绪")
          player.muted = true; await player.play(); await waitFor(() => player.currentTime > 0.12, "HTML播放时钟未增加"); player.pause()
        }
        for (const link of doc.querySelectorAll("[data-media-download]")) {
          const asset = context.assets.get(link.closest('[data-type="media"]').dataset.mewocAssetId)
          assert(await sameBytes(await (await fetch(link.href)).blob(), asset.blob), "HTML下载改变原始媒体字节")
        }
        const printRules = [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.conditionText === "print").map(rule => rule.cssText).join("\n")
        assert(printRules.includes("[data-media-player]") && printRules.includes("[data-media-print]") && doc.querySelectorAll("[data-media-print]").length === 2, "打印没有媒体控件隐藏与文件说明契约")
      } finally { [...(frame.contentDocument?.querySelectorAll("[data-media-player]") || [])].forEach(player => player.pause()); frame.remove() }
    })
    await check("媒体历史/模板：历史只读预览真实播放，关闭释放播放器，独立模板实例可重开", async context => {
      await insertBoth(context); assert(await context.saveDocument(), "媒体检查点前保存失败")
      const saved = await getLocalDocument(context.documentId)
      const version = await createDocumentVersion(context.documentId, saved.storageVersion, "M24媒体检查点")
      const template = await createDocumentTemplate(context.documentId, saved.storageVersion, "M24媒体独立模板")
      templates.set(template.id, template.storageVersion)
      const before = stableSnapshot(context); const previewHost = document.createElement("div"); host.append(previewHost)
      let previewPlayer
      try {
        ReactDOM.render(<DocumentHistoryAction record={{ id: context.documentId, document: saved.document }} currentDocumentId={context.documentId} initialOpen onPrepare={() => true} />, previewHost)
        const modal = await waitFor(() => dialog("历史版本")?.querySelector(`[data-version-id="${version.id}"]`) && dialog("历史版本"), "媒体历史检查点未显示")
        button(modal.querySelector(`[data-version-id="${version.id}"]`), "预览").click()
        const preview = await waitFor(() => modal.querySelector('[aria-label="历史版本正文"] audio'), "历史只读媒体未显示")
        previewPlayer = preview; assert(preview.closest('[aria-readonly="true"]'), "历史正文不是只读")
        await exercisePlayback(preview); assert(stableSnapshot(context) === before, "历史播放改变当前正文")
        preview.muted = true; await preview.play(); button(modal, "关闭预览").click()
        await waitFor(() => preview.paused && !preview.hasAttribute("src"), "历史关闭后音频仍后台播放")
      } finally { ReactDOM.unmountComponentAtNode(previewHost); previewHost.remove(); previewPlayer?.pause(); await delay() }
      const instance = await instantiateDocumentTemplate(template.id, template.storageVersion)
      assert(instance.document.id !== context.documentId && instance.assets.size === 2, "模板实例没有独立保留媒体")
      await mount(instance); for (const player of players(current.editor)) await exercisePlayback(player)
    })
    await check("媒体异步：只读/切换/IME/删除永久取消，映射与共享忙碌锁拒绝并发", async context => {
      for (const reason of ["readOnly", "switching", "composition", "delete"]) {
        context.editor.commands.setContent(content())
        const delayed = await gatedInsert(context)
        const size = context.assets.size
        assert(!await context.insertMedia(fixtures.video, "video"), "媒体读取期间接受了另一次资源任务")
        if (reason === "delete") context.editor.commands.deleteRange({ from: 1, to: 6 })
        else if (reason === "composition") {
          context.editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
          context.editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
          await waitFor(() => !context.editor.view.composing, "异步合成IME没有结束")
        } else {
          context.store.getState().updateView({ [reason]: true }); await waitFor(() => !context.editor.isEditable, "异步禁写未生效")
          context.store.getState().updateView({ [reason]: false }); await waitFor(() => context.editor.isEditable, "异步禁写未恢复")
        }
        const before = json(context.editor.getJSON()); delayed.release()
        assert(!await delayed.completion && json(context.editor.getJSON()) === before && context.assets.size === size, `${reason}恢复后仍提交旧媒体任务`)
        await waitFor(() => !current.uploading, "取消没有释放共享资源锁")
      }
      context.editor.commands.setContent(content()); const delayed = await gatedInsert(context)
      context.editor.commands.insertContentAt(1, "前方映射", { updateSelection: false }); selectParagraph(context.editor, 2)
      const before = json(context.editor.getJSON()); delayed.release()
      assert(await delayed.completion && mediaNodes(context.editor)[0].pos < 20, "前方插字后没有映射原目标")
      assert(context.editor.commands.undo() && json(context.editor.getJSON()) === before, "撤销媒体插入撤掉了等待期间的正文编辑")
    })
    await check("媒体粘贴与降级：外部播放器不创建资源，Word/Markdown/TXT保留说明并明确提示", async context => {
      const external = '<audio src="https://example.invalid/a.mp3" autoplay controls></audio><video src="data:video/mp4;base64,AAAA" autoplay></video><div data-type="media" data-mewoc-asset-id="unknown"><a href="https://example.invalid/v.webm">远端视频</a></div><p>粘贴正文</p>'
      const cleaned = cleanPastedHtml(external, (id, kind) => context.assets.has(id) && context.assets.get(id).kind === kind)
      assert(!/audio|video|data-type="media"|example\.invalid/.test(cleaned), "外部媒体URL或节点仍保留")
      context.editor.commands.setContent(cleaned); assert(!mediaNodes(context.editor).length && !context.assets.size && context.editor.getText().includes("粘贴正文"), "外部媒体粘贴建立资源或丢正文")
      context.editor.commands.setContent(content()); await insertBoth(context)
      const before = stableSnapshot(context); const markdown = await createDocumentMarkdown(context.getSnapshot()); const text = createDocumentText(context.getSnapshot())
      for (const asset of context.getSnapshot().assets) assert(markdown.source.includes(asset.fileName) && text.includes(asset.fileName), "文本降级丢失媒体文件说明")
      assert(markdown.warnings.some(item => /音频|视频/.test(item)) && getDocumentTextWarnings(context.getSnapshot()).some(item => /音频|视频/.test(item)) && /音频和视频/.test(MEDIA_PRINT_WARNING), "降级没有明确媒体提示")
      const word = await createDocumentDocx(context.getSnapshot(), context.assets)
      const zip = await JSZip.loadAsync(word.blob); const xml = await zip.file("word/document.xml").async("string")
      assert(word.warnings.some(item => /音频|视频/.test(item)) && context.getSnapshot().assets.every(asset => xml.includes(asset.fileName)), "Word缺少说明或转换提示")
      assert(!Object.keys(zip.files).some(path => path.startsWith("word/media/") && !zip.files[path].dir), "Word错误地声称内嵌可播放媒体")
      assert(stableSnapshot(context) === before, "导出改写当前媒体文档")
    })
  } finally {
    await unmount()
    for (const [id, version] of templates) await deleteDocumentTemplate(id, version)
    await removeVerificationDocuments([...records.values()]); host.remove(); restorePreferences(savedPreferences)
  }
}

/** 补验仅展示正式 Workspace，不增加 passed 结果；结束时排空保存并精确清理自己的文档。 */
export async function showMediaExample() {
  assert(location.hostname === "127.0.0.1" && location.port === "4189", "媒体补验仅允许在专用 127.0.0.1:4189 运行")
  const fixtures = await createMediaFixtures(); const savedPreferences = preferences()
  const source = { ...createDocument(), title: "M24 · 本地音频与视频补验", content: { type: "doc", content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "M24 · 音频与视频" }] },
    paragraph("使用原生播放控件播放、暂停与定位。音频为四秒 WAV，视频为原生录制的 WebM；它们保留原始字节。"),
    paragraph("可在插入工具栏选择自己的 MP3/WAV 或 MP4/WebM；单个 5 MiB、总计 20 MiB。"),
    paragraph("保存、Mewoc 备份和 HTML 保留原资源。Word、Markdown、纯文本及纸面仅保留文件说明。")
  ] } }
  const assets = new Map()
  for (const kind of ["audio", "video"]) {
    const asset = await readMediaFile(fixtures[kind], kind); assets.set(asset.id, asset)
  }
  // 资源元信息与节点在保存前成对建立，不把 Blob 或 URL 带入正文快照。
  source.assets = [...assets.values()].map(({ blob: _blob, url: _url, ...metadata }) => metadata)
  source.content.content.splice(2, 0, ...[...assets.keys()].map(assetId => ({ type: "media", attrs: { assetId } })))
  const saved = await saveLocalDocument(source, assets, 0)
  const first = { document: source, assets, storageVersion: saved.storageVersion }; const records = new Map([[source.id, first]])
  const host = document.createElement("section"); host.dataset.mediaExample = ""
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:950px;margin:24px 0"; document.body.append(host)
  let current; let closing = false; let resolveFinished; let rejectFinished
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
  const finish = async () => {
    if (closing) return
    closing = true
    let failure
    try { if (current?.editor && !current.editor.isDestroyed && !await current.saveDocument()) throw new Error("媒体补验保存未排空") }
    catch (error) { failure = error }
    try { ReactDOM.unmountComponentAtNode(host); await removeVerificationDocuments([...records.values()]) }
    catch (error) { failure ||= error }
    finally { host.remove(); restorePreferences(savedPreferences) }
    if (failure) rejectFinished(failure); else resolveFinished()
  }
  const capture = context => { current = context }
  function ExampleHost() {
    const [record, setRecord] = useState(first)
    const change = next => { if (!next.id && !next.storageVersion) records.set(next.document.id, next); setRecord(next) }
    return <>
      <p>媒体补验专用文档：可以试听、播放、切换只读或工具栏，再检查各格式输出。播放需要手动点击，页面不自动播放。</p>
      <button type="button" aria-label="结束媒体补验" onClick={finish}>结束媒体补验</button>
      <EditorProvider key={record.document.id} record={record}><Probe onReady={capture} onChange={change} /></EditorProvider>
    </>
  }
  try {
    localStorage.removeItem(TOOLBAR_MODE_KEY); localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    ReactDOM.render(<ExampleHost />, host)
    await waitFor(() => current?.editor && current.documentId === source.id && host.querySelector("[data-mewoc-editor-surface]"), "媒体补验 Workspace 未就绪")
    current.store.getState().updateView({ activeTab: "插入", outlineOpen: false, fitWidth: false, zoom: 1 })
    for (const player of players(current.editor)) await playable(player)
    await finished
  } catch (error) { if (!closing) { await finish(); await finished.catch(() => {}) } throw error }
}
