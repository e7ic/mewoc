/** M25 原生补验：保留真实 Workspace，观察输入事件；不把打开示例计为验收通过。 */
import { useEffect, useState } from "react"
import ReactDOM from "react-dom"
import {
  EditorProvider,
  useDocumentEditor
} from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { getPagePagination } from "../src/pages/editor/extensions/page-pagination.js"
import { downloadDocument } from "../src/pages/editor/tools/file-transfer.js"
import { TOOLBAR_MODE_KEY } from "../src/pages/editor/tools/toolbar-preferences.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { removeVerificationDocuments } from "./browser-checks.js"
import { requireVisibleBrowser } from "./browser-visibility.js"
import { createWaveFile } from "./media-fixtures.js"
import {
  createPaginationSoakDocument,
  createPaginationSoakImage
} from "./pagination-soak-fixture.js"

const INPUT_TYPES = [
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "beforeinput",
  "input",
  "keydown",
  "pointerdown",
  "pointerup",
  "pointercancel"
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
  const record = {
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
  let closing = false
  let resolveFinished
  let rejectFinished
  const events = []
  const finished = new Promise((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })
  const capture = context => {
    current = context
  }
  const readState = () => {
    if (!current?.editor || current.editor.isDestroyed) {
      return null
    }
    const { doc, selection } = current.editor.state
    const layout = getPagePagination(current.editor)
    return {
      documentId: current.documentId,
      pageCount: layout.pageCount,
      selection: {
        from: selection.from,
        to: selection.to
      },
      boundary: layout.breaks.find(item => Number.isInteger(item.paragraphPos))?.pos ?? null,
      composing: current.editor.view.composing,
      originalMatches: JSON.stringify(current.editor.getJSON()) === original,
      textAroundCaret: doc.textBetween(
        Math.max(0, selection.from - 24),
        Math.min(doc.content.size, selection.to + 24)
      ),
      inputEvents: events.length
    }
  }
  const refresh = () => {
    const panel = host.querySelector('[aria-label="原生混合长文状态"]')
    if (panel) {
      panel.textContent = JSON.stringify(readState(), null, 2)
    }
  }
  const observeInput = event => {
    if (!event.target.closest?.(".ProseMirror")) {
      return
    }
    events.push({
      type: event.type,
      trusted: event.isTrusted,
      data: event.data,
      key: event.key,
      inputType: event.inputType,
      composing: event.isComposing,
      x: event.clientX,
      y: event.clientY,
      selection: readState()?.selection
    })
    if (events.length > 240) {
      events.shift()
    }
    refresh()
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
      events,
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
    for (const type of INPUT_TYPES) {
      host.removeEventListener(type, observeInput, true)
    }
    if (current?.editor) {
      for (const event of ["transaction", "selectionUpdate", "paginationUpdate"]) {
        current.editor.off(event, refresh)
      }
    }
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
  try {
    localStorage.removeItem(TOOLBAR_MODE_KEY)
    localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    ReactDOM.render(<Example />, host)
    const deadline = Date.now() + 12000
    while (!current?.editor) {
      if (Date.now() > deadline) {
        throw new Error("原生补验编辑器未就绪")
      }
      await delay(40)
    }
    current.store.getState().updateView({
      activeTab: "导出",
      outlineOpen: false,
      fitWidth: false,
      zoom: 0.75
    })
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
    for (const event of ["transaction", "selectionUpdate", "paginationUpdate"]) {
      current.editor.on(event, refresh)
    }
    for (const type of INPUT_TYPES) {
      host.addEventListener(type, observeInput, true)
    }
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
