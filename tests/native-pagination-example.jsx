/** M25 原生补验：保留真实 Workspace，观察输入事件；不把打开示例计为验收通过。 */
import { useEffect, useState } from "react"
import ReactDOM from "react-dom"
import { redoDepth, undoDepth } from "@tiptap/pm/history"
import {
  EditorProvider,
  useDocumentEditor
} from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { getPagePagination, PAGE_PAGINATION_KEY } from "../src/pages/editor/extensions/page-pagination.js"
import { downloadDocument } from "../src/pages/editor/tools/file-transfer.js"
import { getDocumentAssets, getLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentAssetUrl } from "../src/pages/editor/tools/attachment-assets.js"
import { TOOLBAR_MODE_KEY } from "../src/pages/editor/tools/toolbar-preferences.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { removeVerificationDocuments } from "./browser-checks.js"
import { requireVisibleBrowser } from "./browser-visibility.js"
import { createNativeInputRecorder } from "./native-input-recorder.js"
import { createWaveFile } from "./media-fixtures.js"
import {
  createPaginationSoakDocument,
  createPaginationSoakImage
} from "./pagination-soak-fixture.js"

const INPUT_PHASES = [
  "准备",
  "中文候选确认撤销",
  "跨页拖选",
  "离窗释放",
  "取消后恢复"
]

export async function showNativePaginationExample() {
  if (location.hostname !== "127.0.0.1" || !["4182", "4190"].includes(location.port)) {
    throw new Error("原生分页补验仅允许使用专用本机 4182 / 4190 端口")
  }
  await requireVisibleBrowser()
  const source = createPaginationSoakDocument()
  source.title = "M25 原生混合长文验收"
  source.page.size = "A5"
  source.page.marginsMm = {
    top: 15,
    right: 15,
    bottom: 15,
    left: 15
  }
  source.page.watermark = {
    text: "M25 原生验收",
    color: "#6554C0",
    opacity: 0.12,
    angle: -35
  }
  let record = {
    document: source,
    storageVersion: 0,
    assets: new Map()
  }
  const records = new Map()
  records.set(source.id, record)
  const preferenceKeys = [TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY]
  const preferences = new Map(preferenceKeys.map(key => [key, localStorage.getItem(key)]))
  const host = document.createElement("section")
  host.dataset.nativePaginationExample = ""
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:950px;margin:24px 0"
  document.body.append(host)
  let current
  let original
  let recorder
  let initialization
  let closing = false
  let resolveFinished
  let rejectFinished
  const finished = new Promise((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })
  const capture = context => {
    current = context
  }
  const readState = () => {
    const state = recorder?.readState()
    if (!state) return null
    return {
      ...state,
      initialization,
      undoAvailable: undoDepth(current.editor.state) > 0,
      redoAvailable: redoDepth(current.editor.state) > 0
    }
  }
  const refresh = () => {
    const panel = host.querySelector('[aria-label="原生混合长文状态"]')
    if (panel) {
      panel.textContent = JSON.stringify(readState(), null, 2)
    }
  }
  const handleLocate = () => {
    if (!current?.editor) {
      return
    }
    const boundaries = getPagePagination(current.editor).breaks
    const boundary = boundaries.find(item => Number.isInteger(item.paragraphPos))
    if (boundary) {
      current.editor.commands.focus(boundary.pos)
    }
  }
  const handleExportEvidence = () => {
    const evidence = {
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      url: location.href,
      state: readState(),
      snapshot: current.getSnapshot(),
      initialization,
      ...recorder.getEvidence(),
      note: "仅记录实际事件和当前快照，不自动判定原生输入或打印通过。"
    }
    const blob = new Blob(
      [
        JSON.stringify(evidence, null, 2)
      ],
      {
        type: "application/json"
      }
    )
    downloadDocument(blob, "M25-native-evidence", "json")
  }
  const finish = async () => {
    if (closing) {
      return
    }
    closing = true
    let failure
    recorder?.destroy()
    try {
      if (current?.editor && !current.editor.isDestroyed && !await current.saveDocument()) {
        throw new Error("原生补验保存未完成")
      }
    } catch (error) {
      failure = error
    }
    try {
      ReactDOM.unmountComponentAtNode(host)
      await removeVerificationDocuments([...records.values()])
    } catch (error) {
      failure ||= error
    } finally {
      // 挂载前失败时资源还没有 Provider 所有者，显式回收本夹具已创建的 URL。
      for (const item of records.values()) {
        item.assets.forEach(asset => {
          if (asset.url) URL.revokeObjectURL(asset.url)
        })
      }
      host.remove()
      for (const [key, value] of preferences) {
        if (value === null) {
          localStorage.removeItem(key)
        } else {
          localStorage.setItem(key, value)
        }
      }
    }
    if (failure) {
      rejectFinished(failure)
    } else {
      resolveFinished()
    }
  }
  const Example = ({ ready = false }) => {
    const [selected, setSelected] = useState(record)
    const [phase, setPhase] = useState(INPUT_PHASES[0])
    const handlePhase = event => {
      setPhase(event.target.value)
      recorder?.setPhase(event.target.value)
    }
    const handleChange = next => {
      // 仅清理示例内新建或导入的记录；用户已有的文档库记录不归本例所有。
      if (!next.storageVersion && !next.id) {
        records.set(next.document.id, next)
      }
      setSelected(next)
    }
    return <>
      <p>
        混合长文原生补验：通过正式导出工具保存 Mewoc、Word 和系统 PDF；
        使用真实输入法与指针后导出事件证据。
      </p>
      <label>
        验收阶段
        <select
          aria-label="原生验收阶段"
          disabled={!ready}
          value={phase}
          onChange={handlePhase}
        >
          {INPUT_PHASES.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <button
        type="button"
        disabled={!ready}
        onClick={() => recorder.recordCheckpoint()}
      >记录当前检查点</button>
      <button
        type="button"
        disabled={!ready}
        onClick={handleLocate}
      >定位跨页输入位置</button>
      <button
        type="button"
        disabled={!ready}
        onClick={handleExportEvidence}
      >导出原生混合长文证据</button>
      <button
        type="button"
        disabled={!ready}
        onClick={finish}
      >结束原生混合长文补验</button>
      <pre
        aria-label="原生混合长文状态"
        style={{
          maxHeight: 180,
          overflow: "auto"
        }}
      >等待编辑器就绪</pre>
      <EditorProvider
        key={selected.document.id}
        record={selected}
      >
        <NativeWorkspace capture={capture} onChange={handleChange} />
      </EditorProvider>
    </>
  }
  const mountExample = async () => {
    current = null
    ReactDOM.render(<Example />, host)
    const deadline = Date.now() + 12000
    while (!current?.editor) {
      if (Date.now() > deadline) throw new Error("原生补验编辑器未就绪")
      await delay(40)
    }
    current.store.getState().updateView({
      activeTab: "导出",
      outlineOpen: false,
      fitWidth: false,
      zoom: 0.75
    })
  }
  try {
    localStorage.removeItem(TOOLBAR_MODE_KEY)
    localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    await mountExample()
    current.editor.commands.setTextSelection(1)
    await current.insertImages([
      await createPaginationSoakImage()
    ])
    const attachment = new File(
      [
        "M25 原生验收附件"
      ],
      "native-check.txt",
      {
        type: "text/plain"
      }
    )
    await current.insertAttachment(attachment)
    await current.insertMedia(createWaveFile("native-check.wav"), "audio")
    if (!await current.saveDocument()) {
      throw new Error("原生补验初始保存失败")
    }
    original = JSON.stringify(current.editor.getJSON())
    const saved = await getLocalDocument(source.id)
    if (!saved || JSON.stringify(saved.document.content) !== original) {
      throw new Error("原生补验初始保存正文不一致")
    }
    const assets = await getDocumentAssets(saved.document)
    const previousEditor = current.editor
    // 通过正常重开建立空历史，不将准备阶段的资源插入留作真人撤销目标。
    ReactDOM.unmountComponentAtNode(host)
    await delay(30)
    if (!previousEditor.isDestroyed) throw new Error("原生补验准备会话未销毁")
    record = { ...saved, assets }
    records.set(source.id, record)
    assets.forEach(asset => { asset.url = createDocumentAssetUrl(asset) })
    await mountExample()
    await settleNativePagination(current)
    initialization = {
      reopenedFromSavedRecord: true,
      storageVersion: record.storageVersion,
      undoDepth: undoDepth(current.editor.state),
      redoDepth: redoDepth(current.editor.state),
      originalMatches: JSON.stringify(current.editor.getJSON()) === original,
      assets: assets.size
    }
    if (!initialization.originalMatches || initialization.undoDepth || initialization.redoDepth) {
      throw new Error("原生补验重开后正文或初始撤销历史不一致")
    }
    recorder = createNativeInputRecorder({
      getContext: () => current,
      original,
      onChange: refresh
    })
    ReactDOM.render(<Example ready />, host)
    refresh()
    host.scrollIntoView({
      block: "start"
    })
    await finished
  } catch (error) {
    if (!closing) {
      await finish()
    }
    // 清理失败已由原始错误路径报告，消费完成信号的拒绝，避免遗留未处理 Promise。
    await finished.catch(() => undefined)
    throw error
  }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function settleNativePagination(context) {
  await document.fonts.ready
  const deadline = Date.now() + 15000
  let previous = ""
  let stable = 0
  while (Date.now() < deadline) {
    const state = PAGE_PAGINATION_KEY.getState(context.editor.state)
    const signature = JSON.stringify({
      layout: state.layout,
      height: context.editor.view.dom.getBoundingClientRect().height
    })
    stable = signature === previous && !state.pending ? stable + 1 : 0
    previous = signature
    // 连续三次真实布局不变后才开放操作；沿用混合长文持续验收的 60 ms 间隔。
    if (stable >= 3 && state.layout.pageCount > 1) return
    await delay(60)
  }
  throw new Error("原生补验重开后的分页在 15 秒内未收敛")
}

const NativeWorkspace = ({ capture, onChange }) => {
  const context = useDocumentEditor()
  useEffect(() => {
    if (context.editor) {
      capture(context)
    }
  }, [
    context,
    capture
  ])
  return <EditorWorkspace onDocumentChange={onChange} />
}
