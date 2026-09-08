import { useCallback, useEffect, useRef, useState } from "react"
import ReactDOM from "react-dom"
import { EditorContent } from "@tiptap/react"
import { EditorProvider, useDocumentEditor, useEditorStore } from "../src/pages/editor/components/EditorProvider.jsx"
import { SearchPanel } from "../src/pages/editor/components/SearchPanel.jsx"
import { TextStyleControls } from "../src/pages/editor/components/TextStyleControls.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { runEditorChecks, removeVerificationDocuments } from "./browser-checks.js"
import { runStressChecks } from "./stress-checks.js"
import "../src/pages/editor/sass/content.scss"

function BrowserVerification() {
  const [results, setResults] = useState([])
  const [running, setRunning] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [records] = useState(() => ["left", "right"].map(id => ({
    id, document: { ...createDocument(), title: `浏览器验收-${id}` }, storageVersion: 0, assets: new Map()
  })))
  const sessionsRef = useRef({})
  const readyRef = useRef(null)
  const handleReady = useCallback((id, context) => {
    sessionsRef.current[id] = context
    if (sessionsRef.current.left?.editor && sessionsRef.current.right?.editor) readyRef.current?.()
  }, [])

  const handleRun = async stress => {
    setRunning(true)
    const ready = new Promise(resolve => { readyRef.current = resolve })
    setMounted(true)
    const report = result => setResults(items => [...items, result])
    try {
      await ready
      if (stress) await runStressChecks(sessionsRef.current.left, report)
      else await runEditorChecks(sessionsRef.current, report)
    } catch (error) {
      report({ name: "验收运行异常", passed: false, error: error.message })
    } finally {
      await Promise.all(Object.values(sessionsRef.current).map(context => context.saveDocument()))
      setMounted(false)
      readyRef.current = null
      try {
        await removeVerificationDocuments(records)
      } catch (error) {
        report({ name: "清理本轮测试文档", passed: false, error: error.message })
      }
      setRunning(false)
    }
  }

  return (
    <main>
      <h1>Mewoc 浏览器验收</h1>
      <p>使用真实浏览器排版、React 17、编辑器与 IndexedDB。拖动事件为合成事件，不代替真实输入法或物理鼠标验收。</p>
      <p>请使用专用测试端口。点击运行后才创建测试文档；一次运行完成后刷新可重新测试。</p>
      <button type="button" disabled={running || !!results.length} onClick={() => handleRun(false)}>运行浏览器验收</button>
      <button type="button" disabled={running || !!results.length} onClick={() => handleRun(true)}>运行压力验收</button>
      <p role="status">{running ? "正在验证" : results.length ? `完成：${results.filter(result => result.passed).length}/${results.length}` : "等待运行"}</p>
      <ol>{results.map(result => (
        <li key={result.name}>
          {result.passed ? "通过" : "失败"}：{result.name}{result.error && ` — ${result.error}`}
          {result.metrics && <p>{JSON.stringify(result.metrics)}</p>}
        </li>
      ))}</ol>
      {!!results.length && <pre aria-label="验收 JSON 结果">{JSON.stringify(results, null, 2)}</pre>}
      {mounted && records.map(record => (
        <EditorProvider key={record.id} record={record}>
          <EditorProbe id={record.id} onReady={handleReady} />
        </EditorProvider>
      ))}
    </main>
  )
}

const EditorProbe = ({ id, onReady }) => {
  const context = useDocumentEditor()
  const searchOpen = useEditorStore(state => state.searchOpen)
  useEffect(() => { if (context.editor) onReady(id, context) }, [id, context, onReady])
  return (
    <section data-probe={id} style={{ width: 640, margin: 20, transformOrigin: "top left" }}>
      <TextStyleControls />
      <EditorContent editor={context.editor} />
      {searchOpen && <SearchPanel />}
    </section>
  )
}

ReactDOM.render(<BrowserVerification />, document.getElementById("root"))
