import { useCallback, useEffect, useRef, useState } from "react"
import ReactDOM from "react-dom"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { PaperCanvas } from "../src/pages/editor/components/PaperCanvas.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { getDocumentAssets, getDocuments } from "../src/pages/editor/tools/local-repository.js"
import { removeVerificationDocuments } from "./browser-checks.js"
import { observeSessionResources } from "./lifecycle-resources.js"
import { exportVerification } from "./verification-export.js"

function LifecycleVerification() {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState([])
  const [rounds, setRounds] = useState(30)
  const hostRef = useRef(null)
  const mountedRef = useRef(true)
  const stopRef = useRef(false)
  const handleReport = useCallback(result => {
    if (mountedRef.current) setResults(items => [...items, result])
  }, [])

  const handleRun = async (minutes = 0) => {
    const count = minutes ? minutes * 12 : 30
    const host = hostRef.current
    const started = performance.now()
    stopRef.current = false
    setRounds(count)
    setRunning(true)
    const resources = observeSessionResources()
    const errors = []
    const handleError = event => errors.push(event.message)
    const handleRejection = event => errors.push(event.reason?.message || String(event.reason))
    window.addEventListener("error", handleError)
    window.addEventListener("unhandledrejection", handleRejection)
    try {
      const file = await createImageFixture()
      for (let index = 0; index < count && !stopRef.current; index += 1) {
        await checkSessionCycle(host, file, resources)
        if (errors.length) throw new Error(errors.join("; "))
        handleReport({
          name: `第 ${index + 1} 轮：图表拖动、附件/公式/代码恢复、异步卸载`, passed: true,
          elapsedSeconds: Math.round((performance.now() - started) / 1000),
          heapBytes: performance.memory?.usedJSHeapSize ?? null,
          domNodes: document.getElementsByTagName("*").length,
          visible: document.visibilityState === "visible", ...resources.getCounts()
        })
        if (minutes && !stopRef.current) await new Promise(resolve => setTimeout(resolve, 5000))
      }
    } catch (error) {
      handleReport({ name: "生命周期验收", passed: false, error: error.message, ...resources.getCounts() })
    } finally {
      window.removeEventListener("error", handleError)
      window.removeEventListener("unhandledrejection", handleRejection)
      resources.restore()
      if (mountedRef.current) setRunning(false)
    }
  }

  useEffect(() => () => {
    mountedRef.current = false
    stopRef.current = true
  }, [])

  return (
    <main>
      <h1>Mewoc 持续切换验收</h1>
      <p>30 轮、60 次真实会话挂载。仅观测指定资源的释放，不作为堆内存无泄漏证明。使用专用端口。</p>
      <p>持续模式可选约 15 分钟（180 轮）或 60 分钟（720 轮）；覆盖图片、表格、附件、公式和代码块。堆数值为 Chromium 非标准估算，不能单独证明无泄漏。停止后完成当前轮清理；结束后刷新可重新运行。</p>
      <button type="button" disabled={running || !!results.length} onClick={() => handleRun()}>运行生命周期验收</button>
      <button type="button" disabled={running || !!results.length} onClick={() => handleRun(15)}>运行 15 分钟持续验收</button>
      <button type="button" disabled={running || !!results.length} onClick={() => handleRun(60)}>运行 60 分钟持续验收</button>
      <button type="button" disabled={!running} onClick={() => { stopRef.current = true }}>停止并清理</button>
      <button type="button" disabled={running || !results.length} onClick={() => exportVerification("lifecycle", results)}>导出验收结果</button>
      <p role="status">{running ? `正在验证：${results.length}/${rounds}` : results.length ? `结束：${results.filter(item => item.passed).length}/${rounds}` : "等待运行"}</p>
      <pre aria-label="生命周期 JSON 结果">{JSON.stringify(results, null, 2)}</pre>
      <div ref={hostRef} />
    </main>
  )
}

const SessionProbe = ({ onReady }) => {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onReady(context) }, [context, onReady])
  return <PaperCanvas />
}

function mountSession(host, record) {
  return new Promise(resolve => {
    ReactDOM.render(<EditorProvider record={record}><SessionProbe onReady={resolve} /></EditorProvider>, host)
  })
}

async function unmountSession(host, session, resources) {
  ReactDOM.unmountComponentAtNode(host)
  // Tiptap React 的销毁延迟一个定时器；等待它自己的生命周期，不代替 destroy。
  await new Promise(resolve => setTimeout(resolve, 20))
  const counts = resources.getCounts()
  if (!session.editor.isDestroyed || host.querySelector(".ProseMirror")) throw new Error("旧编辑器未销毁")
  if (counts.urls || counts.observers || counts.listeners) throw new Error(`资源未释放：${JSON.stringify(counts)}`)
}

async function checkSessionCycle(host, file, resources) {
  const record = { document: createDocument(), storageVersion: 0, assets: new Map() }
  let session = null
  let inserting = null
  try {
    session = await mountSession(host, record)
    session.store.getState().updateView({ fitWidth: true })
    await session.insertImages([file])
    if (session.getSnapshot().assets.length !== 1) throw new Error("会话图片未插入")
    // 在同一真实会话中覆盖后续新增节点，资源仍由原 Provider 持有并按原生命周期销毁。
    session.editor.commands.setTextSelection(1)
    if (!await session.insertAttachment(new File(["M5 附件恢复"], "lifecycle.txt", { type: "text/plain" }))) throw new Error("会话附件未插入")
    session.editor.commands.insertContentAt(session.editor.state.doc.content.size, [
      { type: "blockMath", attrs: { latex: "E = mc^2" } },
      { type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: "const value = 42" }] }
    ])
    if (!await session.saveDocument()) throw new Error("会话保存失败")
    const snapshot = session.getSnapshot()
    startImageResize(session.editor)
    if (resources.getCounts().listeners < 2) throw new Error("未进入图片拖动监听状态")
    // 文件读取会异步返回；在结果返回前卸载，旧结果不允许写回会话。
    inserting = session.insertImages([file])
    ReactDOM.unmountComponentAtNode(host)
    await inserting
    await unmountSession(host, session, resources)
    if (record.assets.size !== 2) throw new Error("迟到图片写入了已卸载会话")
    const saved = (await getDocuments()).find(item => item.id === snapshot.id)
    const assets = await getDocumentAssets(saved.document)
    assets.forEach(asset => { asset.url = URL.createObjectURL(asset.blob) })
    session = await mountSession(host, { ...saved, assets })
    await session.editor.view.dom.querySelector("img").decode()
    if (assets.size !== 2 || await [...assets.values()].find(asset => asset.kind === "attachment")?.blob.text() !== "M5 附件恢复") throw new Error("附件恢复内容不一致")
    if (!session.editor.view.dom.querySelector('[data-type="block-math"]') || !session.editor.view.dom.querySelector("pre")) throw new Error("公式或代码块恢复失败")
    session.editor.commands.setTextSelection(1)
    session.editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
    if (!await session.saveDocument()) throw new Error("恢复会话保存失败")
    const cell = session.editor.view.dom.querySelector("th")
    const rect = cell.getBoundingClientRect()
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: rect.right - 1, clientY: rect.top + 5 }))
    if (resources.getCounts().listeners < 4) throw new Error("未进入表格拖动监听状态")
    await unmountSession(host, session, resources)
  } finally {
    ReactDOM.unmountComponentAtNode(host)
    if (inserting) await inserting
    if (session) await session.saveDocument()
    await removeVerificationDocuments([record])
  }
}

function startImageResize(editor) {
  const handle = editor.view.dom.querySelector("[data-resize-handle]")
  const capture = handle.setPointerCapture
  handle.setPointerCapture = () => undefined
  try {
    handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, buttons: 1, clientX: 100 }))
  } finally {
    handle.setPointerCapture = capture
  }
}

async function createImageFixture() {
  const canvas = document.createElement("canvas")
  canvas.width = 480
  canvas.height = 240
  const context = canvas.getContext("2d")
  context.fillStyle = "#6657d9"
  context.fillRect(0, 0, canvas.width, canvas.height)
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
  return new File([blob], "lifecycle.png", { type: "image/png" })
}

ReactDOM.render(<LifecycleVerification />, document.getElementById("root"))
