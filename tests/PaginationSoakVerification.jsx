/** M25 持续验收入口，开发服务限定端口；状态与结果通过页面公开展示。 */
import { useEffect, useRef, useState } from "react"
import ReactDOM from "react-dom"
import { runPaginationSoak } from "./pagination-soak-checks.jsx"
import { exportVerification } from "./verification-export.js"

function PaginationSoakVerification() {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState([])
  const controlRef = useRef({
    stopped: false
  })
  const mountedRef = useRef(true)
  const completed = results.filter(item => item.name.startsWith("混合长文第")).length
  const summary = results.find(item => Number.isInteger(item.rounds))

  const handleRun = async minutes => {
    setRunning(true)
    const report = result => {
      if (mountedRef.current) {
        setResults(items => [...items, result])
      }
    }
    try {
      await runPaginationSoak(report, controlRef.current, minutes)
    } catch (error) {
      report({
        name: "启动持续验收",
        passed: false,
        error: error.message
      })
    } finally {
      if (mountedRef.current) {
        setRunning(false)
      }
    }
  }

  const handleStop = () => {
    controlRef.current.stopped = true
  }

  useEffect(() => () => {
    mountedRef.current = false
    controlRef.current.stopped = true
  }, [])

  return (
    <main>
      <h1>M25 混合长文持续验收</h1>
      <p>覆盖分页重排、跨页替换与撤销、详情收起展开、保存重开和资源释放。</p>
      <p>15 分钟按实际运行时间结束；停止会完成当前轮并清理。仅使用专用 4182 / 4190 端口。</p>
      <button
        type="button"
        disabled={running || !!results.length}
        onClick={() => handleRun(0)}
      >运行 6 轮混合长文验收</button>
      <button
        type="button"
        disabled={running || !!results.length}
        onClick={() => handleRun(15)}
      >运行 15 分钟分页持续验收</button>
      <button
        type="button"
        disabled={!running}
        onClick={handleStop}
      >停止并清理</button>
      <button
        type="button"
        disabled={running || !results.length}
        onClick={() => exportVerification("pagination-soak", results)}
      >导出验收结果</button>
      <p role="status">
        {running ? `正在验证：已完成 ${completed} 轮` : results.length ? "验收结束" : "等待运行"}
      </p>
      {summary && (
        <p>
          {summary.stopped ? "已停止并清理" : "完整运行结束"}：
          {summary.elapsedSeconds} 秒，{summary.rounds} 轮，{summary.mounts} 次会话挂载。
        </p>
      )}
      <pre
        aria-label="持续验收 JSON 结果"
        style={{
          maxHeight: 360,
          overflow: "auto"
        }}
      >{JSON.stringify(results, null, 2)}</pre>
    </main>
  )
}

ReactDOM.render(<PaginationSoakVerification />, document.getElementById("root"))
