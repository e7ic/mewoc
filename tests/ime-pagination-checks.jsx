/** 合成 IME 确认回归：逐帧观察真实分页路径；不能替代系统输入法或物理键盘验收。 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import { closeHistory } from "@tiptap/pm/history"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { EditorWorkspace } from "../src/pages/editor/components/EditorWorkspace.jsx"
import { PAGE_PAGINATION_KEY } from "../src/pages/editor/extensions/page-pagination.js"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { TOOLBAR_MODE_KEY } from "../src/pages/editor/tools/toolbar-preferences.js"
import { FORMATTING_MARKS_KEY } from "../src/pages/editor/tools/formatting-marks-preferences.js"
import { removeVerificationDocuments } from "./browser-checks.js"
import { requireVisibleBrowser } from "./browser-visibility.js"

const assert = (value, message) => { if (!value) throw new Error(message) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const json = value => JSON.stringify(value)
const waitFor = async (read, message) => {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const value = read()
    if (value) return value
    await delay(30)
  }
  throw new Error(message)
}

function Probe({ capture }) {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) capture(context) }, [context, capture])
  return <EditorWorkspace onDocumentChange={() => {}} />
}

export async function runImePaginationChecks(report = () => {}) {
  assert(location.hostname === "127.0.0.1" && ["4182", "4190"].includes(location.port), "IME 分页回归仅允许专用本机验收端口")
  await requireVisibleBrowser()
  const preferences = new Map([TOOLBAR_MODE_KEY, FORMATTING_MARKS_KEY].map(key => [key, localStorage.getItem(key)]))
  const source = createDocument()
  source.title = "M25 输入法确认分页回归"
  source.page.size = "A5"
  source.page.marginsMm = { top: 15, right: 15, bottom: 15, left: 15 }
  source.content = { type: "doc", content: [{ type: "paragraph", content: [{
    type: "text", text: "同一段中英文 Mixed text 👩🏽‍💻 跨页后仍保持完整，保存和撤销不能加入视图空隙。".repeat(70)
  }] }] }
  const record = { document: source, assets: new Map(), storageVersion: 0 }
  const host = document.createElement("section")
  host.style.cssText = "position:relative;width:1280px;max-width:100%;height:900px;margin:24px 0"
  document.body.append(host)
  let current
  let observeTransaction
  const capture = context => { current = context }
  const metrics = {
    provenance: "Synthetic composition with production EditorProvider/Workspace/PagePagination; not native IME acceptance",
    sampling: "Geometry is read in a task after requestAnimationFrame callbacks, so a reset repaired in the same frame is not treated as a painted jump.",
    frames: [],
    phases: [],
    transactions: []
  }
  let result
  try {
    localStorage.removeItem(TOOLBAR_MODE_KEY)
    localStorage.setItem(FORMATTING_MARKS_KEY, "false")
    ReactDOM.render(<EditorProvider record={record}><Probe capture={capture} /></EditorProvider>, host)
    await waitFor(() => current?.editor, "IME 分页回归编辑器未就绪")
    const { editor, store } = current
    store.getState().updateView({ outlineOpen: false, fitWidth: false, zoom: 0.75 })
    await document.fonts.ready
    const pagination = () => PAGE_PAGINATION_KEY.getState(editor.state)
    const settle = async () => {
      let previous = ""
      let stable = 0
      await waitFor(() => {
        const state = pagination()
        const signature = json(state.layout)
        stable = !state.pending && signature === previous ? stable + 1 : 0
        previous = signature
        return stable >= 3 && state.layout.pageCount > 1
      }, "IME 确认后分页没有收敛")
    }
    await settle()
    const boundary = pagination().layout.breaks.find(item => Number.isInteger(item.paragraphPos))
    assert(boundary, "最小长段落未产生续页边界")
    editor.commands.focus(boundary.pos, { scrollIntoView: false })
    await waitFor(() => editor.view.hasFocus(), "IME 回归输入位置未获得焦点")
    await settle()
    const bodyBefore = json(editor.getJSON())
    metrics.baselineContent = editor.getJSON()
    const originalText = editor.state.doc.textContent
    const beforeGaps = [...editor.view.dom.querySelectorAll("[data-mewoc-page-gap]")]
    editor.view.dispatch(closeHistory(editor.state.tr))
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    await waitFor(() => editor.view.composing, "合成 composition 未开始")
    editor.commands.insertContentAt(boundary.pos, "中文验收")
    await delay(80)
    assert(beforeGaps.every(node => node.isConnected), "候选期间重建分页装饰")
    const candidateContent = json(editor.getJSON())
    metrics.candidateContent = editor.getJSON()
    assert(editor.state.doc.textContent === originalText.slice(0, boundary.pos - 1) + "中文验收" + originalText.slice(boundary.pos - 1), "候选没有准确插入原段边界一次")
    const startedAt = performance.now()
    const read = () => {
      const state = pagination()
      const caret = editor.view.coordsAtPos(editor.state.selection.head)
      const surface = host.querySelector("[data-mewoc-editor-surface]").getBoundingClientRect()
      const scrolling = []
      for (let node = editor.view.dom.parentElement; node; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) scrolling.push({ top: node.scrollTop, left: node.scrollLeft })
      }
      return {
        elapsedMs: performance.now() - startedAt,
        caretViewportTop: caret.top,
        caretDocumentTop: (caret.top - surface.top) / store.getState().zoom,
        surfaceTop: surface.top,
        scrolling,
        windowScroll: { x: window.scrollX, y: window.scrollY },
        selection: { from: editor.state.selection.from, to: editor.state.selection.to },
        gapCount: editor.view.dom.querySelectorAll("[data-mewoc-page-gap]").length,
        composing: editor.view.composing,
        pending: state.pending,
        pages: state.layout.pageCount
      }
    }
    metrics.boundary = boundary
    let activePhase = "confirm"
    observeTransaction = ({ transaction }) => metrics.transactions.push({ ...read(), phase: activePhase, docChanged: transaction.docChanged })
    editor.on("transaction", observeTransaction)
    const samplePhase = async (name, action) => {
      activePhase = name
      const phase = { name, before: read(), frames: [] }
      metrics.phases.push(phase)
      action()
      const end = performance.now() + 300
      // 同帧内已恢复的测量暂态不计失败；动作可合法改变最终行位，但不能越过前后位置包络再返回。
      while (performance.now() < end) {
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
        phase.frames.push(read())
      }
      await settle()
      phase.after = read()
      phase.content = editor.getJSON()
      const first = phase.before.caretDocumentTop
      const last = phase.after.caretDocumentTop
      const lowest = Math.min(...phase.frames.map(frame => frame.caretDocumentTop))
      const highest = Math.max(...phase.frames.map(frame => frame.caretDocumentTop))
      phase.upwardExcursionPx = Math.max(0, Math.min(first, last) - lowest)
      phase.downwardExcursionPx = Math.max(0, highest - Math.max(first, last))
      phase.tolerancePx = 2
      phase.noPaintableJump = phase.upwardExcursionPx <= 2 && phase.downwardExcursionPx <= 2
      assert(phase.frames.length >= 3, `${name} 未取得足够真实动画帧`)
      return phase
    }
    const confirmation = await samplePhase("confirm", () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文验收" }))
    })
    metrics.beforeConfirm = confirmation.before
    metrics.afterConfirm = confirmation.after
    metrics.frames = confirmation.frames
    metrics.confirmedContent = editor.getJSON()
    metrics.contentUnchangedByConfirmation = json(editor.getJSON()) === candidateContent
    await samplePhase("undo", () => assert(editor.commands.undo(), "候选确认后的撤销不可用"))
    metrics.undoRestoresExactOriginal = json(editor.getJSON()) === bodyBefore
    metrics.undoneContent = editor.getJSON()
    metrics.afterUndo = read()
    await samplePhase("redo", () => assert(editor.commands.redo(), "候选确认后的重做不可用"))
    metrics.redoRestoresExactCandidate = json(editor.getJSON()) === candidateContent
    await samplePhase("undo-again", () => assert(editor.commands.undo(), "重做后的再次撤销不可用"))
    metrics.secondUndoRestoresExactOriginal = json(editor.getJSON()) === bodyBefore
    assert(metrics.secondUndoRestoresExactOriginal, "再次撤销没有恢复完整原文，不能继续取消回归")

    editor.commands.focus(boundary.pos, { scrollIntoView: false })
    await waitFor(() => editor.view.hasFocus(), "取消回归输入位置未获得焦点")
    await settle()
    editor.view.dispatch(closeHistory(editor.state.tr))
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    await waitFor(() => editor.view.composing, "取消回归的合成 composition 未开始")
    editor.commands.insertContentAt(boundary.pos, "取消候选")
    await delay(80)
    metrics.cancelCandidateContent = editor.getJSON()
    metrics.cancelSimulation = "Synthetic removal of active candidate text followed by empty compositionend; not a native Escape key or OS IME event."
    await samplePhase("cancel", () => {
      editor.commands.deleteRange({ from: boundary.pos, to: boundary.pos + 4 })
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }))
    })
    metrics.cancelRestoresExactOriginal = json(editor.getJSON()) === bodyBefore
    metrics.upwardExcursionPx = confirmation.upwardExcursionPx
    metrics.downwardExcursionPx = confirmation.downwardExcursionPx
    metrics.tolerancePx = 2
    metrics.noPaintableJump = metrics.phases.every(phase => phase.noPaintableJump)
    assert(metrics.contentUnchangedByConfirmation && metrics.undoRestoresExactOriginal, "确认或撤销改变原始正文")
    assert(metrics.redoRestoresExactCandidate && metrics.cancelRestoresExactOriginal, "重做或取消没有准确恢复对应正文")
    const failed = metrics.phases.filter(phase => !phase.noPaintableJump).map(phase => `${phase.name} 向上 ${phase.upwardExcursionPx.toFixed(2)}px、向下 ${phase.downwardExcursionPx.toFixed(2)}px`).join("；")
    assert(metrics.noPaintableJump, `候选确认/历史/取消发生分页跳动：${failed}；允许 2px`)
    result = { name: "IME 确认、撤销重做和取消：无分页往返跳动，正文精确恢复", passed: true, metrics }
  } catch (error) {
    result = { name: "IME 确认、撤销重做和取消：无分页往返跳动，正文精确恢复", passed: false, error: error.message, metrics }
  } finally {
    if (current?.editor && observeTransaction) current.editor.off("transaction", observeTransaction)
    let cleanupError
    try {
      if (current?.editor && !current.editor.isDestroyed) assert(await current.saveDocument(), "IME 回归清理前保存失败")
    } catch (error) {
      cleanupError = error
    }
    try {
      ReactDOM.unmountComponentAtNode(host)
      await removeVerificationDocuments([record])
    } catch (error) {
      cleanupError ||= error
    } finally {
      host.remove()
      for (const [key, value] of preferences) {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
      }
    }
    if (cleanupError) result = { ...result, passed: false, error: [result?.error, cleanupError.message].filter(Boolean).join("；") }
  }
  report(result)
}
