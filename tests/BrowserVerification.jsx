/** 浏览器功能验收入口：按需创建真实会话，汇总各领域检查结果，结束后清理本轮数据。 */
import { useCallback, useEffect, useRef, useState } from "react"
import ReactDOM from "react-dom"
import { EditorContent } from "@tiptap/react"
import { EditorProvider, useDocumentEditor, useEditorStore } from "../src/pages/editor/components/EditorProvider.jsx"
import { SearchPanel } from "../src/pages/editor/components/SearchPanel.jsx"
import { TextStyleControls } from "../src/pages/editor/components/TextStyleControls.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { runEditorChecks, removeVerificationDocuments } from "./browser-checks.js"
import { runStressChecks } from "./stress-checks.js"
import { exportVerification } from "./verification-export.js"
import { runAssetPersistenceChecks } from "./asset-persistence-checks.js"
import { runDocxImportChecks } from "./docx-import-checks.jsx"
import { runDocxChecks } from "./docx-checks.jsx"
import { runDocumentLibraryChecks } from "./document-library-checks.jsx"
import { runDocumentHistoryChecks } from "./document-history-checks.jsx"
import { runDocumentCommentsChecks } from "./document-comments-checks.jsx"
import { runDocumentTemplateChecks } from "./document-template-checks.jsx"
import { runPrecisionSettingsChecks } from "./precision-settings-checks.jsx"
import { runParagraphSettingsChecks } from "./paragraph-settings-checks.jsx"
import { runEditorInteractionChecks } from "./editor-interaction-checks.jsx"
import { runToolbarRibbonChecks } from "./toolbar-ribbon-checks.jsx"
import { runViewImageChecks } from "./view-image-checks.jsx"
import { runRichBlocksChecks } from "./rich-blocks-checks.jsx"
import { runNavigationChecks } from "./navigation-checks.jsx"
import { runPageSettingsChecks } from "./page-settings-checks.jsx"
import { runDocxPageImportChecks, showDocxPageImportPreview } from "./docx-page-import-checks.jsx"
import { runPageFurnitureChecks, showPageFurnitureExample } from "./page-furniture-checks.jsx"
import { runMediaChecks, showMediaExample } from "./media-checks.jsx"
import { runPagePaginationChecks } from "./page-pagination-checks.jsx"
import { runTablePaginationChecks, showTablePaginationExample } from "./table-pagination-checks.jsx"
import { runParagraphPaginationChecks, showParagraphPaginationExample } from "./paragraph-pagination-checks.jsx"
import "../src/pages/editor/sass/content.scss"

// 运行状态限制重复启动；双会话用于证明编辑器与 Zustand 实例隔离。
function BrowserVerification() {
  const [results, setResults] = useState([])
  const [running, setRunning] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [records] = useState(() => ["left", "right"].map(id => ({
    id, document: { ...createDocument(), title: `浏览器验收-${id}` }, storageVersion: 0, assets: new Map()
  })))
  // 会话上下文不参与渲染，通过 ready 回调确认两侧 editor 都已创建后才开始检查。
  const sessionsRef = useRef({})
  const readyRef = useRef(null)
  const handleReady = useCallback((id, context) => {
    sessionsRef.current[id] = context
    if (sessionsRef.current.left?.editor && sessionsRef.current.right?.editor) readyRef.current?.()
  }, [])

  // 普通与压力验收共用挂载、报告和清理流程；具体领域检查由独立模块执行。
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
    // 先排空保存任务，再卸载和删除精确测试 ID，防止迟到写入重新创建测试记录。
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

  // 每类专项独立触发并逐项展示结果；已运行页面需刷新后再创建新一轮记录。
  return (
    <main>
      <h1>Mewoc 浏览器验收</h1>
      <p>使用真实浏览器排版、React 17、编辑器与 IndexedDB。拖动事件为合成事件，不代替真实输入法或物理鼠标验收。</p>
      <p>请使用专用测试端口。点击运行后才创建测试文档；一次运行完成后刷新可重新测试。</p>
      <button type="button" disabled={running || !!results.length} onClick={() => handleRun(false)}>运行浏览器验收</button>
      <button type="button" disabled={running || !!results.length} onClick={() => handleRun(true)}>运行压力验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runAssetPersistenceChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行资源重复保存验收</button>
      <button type="button" disabled={running || !results.length} onClick={() => exportVerification("browser", results)}>导出验收结果</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runDocxChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行 Word 导出验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runDocxImportChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行 Word 导入验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runDocumentLibraryChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行文档库验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runDocumentHistoryChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行历史版本验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runDocumentCommentsChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行批注验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runDocumentTemplateChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行模板验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runPrecisionSettingsChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行图表精细设置验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runParagraphSettingsChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行段落精细设置验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runEditorInteractionChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行编辑交互验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runToolbarRibbonChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行工具栏验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runViewImageChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行图片替换与格式标记验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runRichBlocksChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行文本框与折叠详情验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runNavigationChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行目录与书签导航验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runPageSettingsChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行页面与水印验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runDocxPageImportChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行 Word 页面往返验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await showDocxPageImportPreview() }
        finally { setRunning(false) }
      }}>打开 Word 页面预览示例</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runPageFurnitureChecks(result => setResults(items => [...items, result])) }
        finally { setRunning(false) }
      }}>运行页眉页脚与页码验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await showPageFurnitureExample() }
        finally { setRunning(false) }
      }}>打开页眉页脚补验示例</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runMediaChecks(result => setResults(items => [...items, result])) }
        catch (error) { setResults(items => [...items, { name: "媒体验收运行异常", passed: false, error: error.message }]) }
        finally { setRunning(false) }
      }}>运行音频与视频验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await showMediaExample() }
        finally { setRunning(false) }
      }}>打开媒体补验示例</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runPagePaginationChecks(result => setResults(items => [...items, result])) }
        catch (error) { setResults(items => [...items, { name: "分页验收运行异常", passed: false, error: error.message }]) }
        finally { setRunning(false) }
      }}>运行自动分页验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runTablePaginationChecks(result => setResults(items => [...items, result])) }
        catch (error) { setResults(items => [...items, { name: "跨页表格验收运行异常", passed: false, error: error.message }]) }
        finally { setRunning(false) }
      }}>运行跨页表格验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await showTablePaginationExample() }
        catch (error) { setResults(items => [...items, { name: "跨页表格示例运行异常", passed: false, error: error.message }]) }
        finally { setRunning(false) }
      }}>显示跨页表格示例</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await runParagraphPaginationChecks(result => setResults(items => [...items, result])) }
        catch (error) { setResults(items => [...items, { name: "段内分页验收运行异常", passed: false, error: error.message }]) }
        finally { setRunning(false) }
      }}>运行段内分页验收</button>
      <button type="button" disabled={running || !!results.length} onClick={async () => {
        setRunning(true)
        try { await showParagraphPaginationExample() }
        catch (error) { setResults(items => [...items, { name: "段内分页示例运行异常", passed: false, error: error.message }]) }
        finally { setRunning(false) }
      }}>显示段内分页示例</button>
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

// 把真实上下文交给检查器，并挂载字号和查找控件以覆盖 DOM 联动。
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
