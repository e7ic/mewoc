/** 开发验收记录器：只观察真实编辑会话；isTrusted 不单独证明输入来自物理硬件。 */
import { PAGE_PAGINATION_KEY } from "../src/pages/editor/extensions/page-pagination.js"

const INPUT_EVENTS = [
  "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "keydown"
]
const POINTER_EVENTS = [
  "pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "mouseup"
]

export function createNativeInputRecorder({ getContext, original, onChange }) {
  const editor = getContext().editor
  const doc = editor.view.dom.ownerDocument
  const win = doc.defaultView
  const startedAt = new Date().toISOString()
  const startedMs = performance.now()
  const events = []
  const checkpoints = []
  let phase = "准备"
  let sequence = 0
  let droppedEvents = 0
  let throttledMoves = 0
  let frame = 0
  let destroyed = false
  let sessionChanged = false
  let pointerSession = false
  let pointerPressed = false
  let editorActivity = false
  let lastMoveMs = 0
  let composition = null
  let renderGroup = 0
  let renderSampling = null

  const readState = () => {
    const current = getContext()
    if (current?.editor !== editor || editor.isDestroyed) return null
    const { selection, doc: content } = editor.state
    const pagination = PAGE_PAGINATION_KEY.getState(editor.state)
    const layout = pagination.layout
    const selected = doc.getSelection()
    const scrolling = []
    for (let node = editor.view.dom.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight &&
        /auto|scroll/.test(win.getComputedStyle(node).overflowY)) {
        scrolling.push({
          className: node.className,
          top: node.scrollTop,
          left: node.scrollLeft
        })
      }
    }
    const state = {
      documentId: current.documentId,
      phase,
      pageCount: layout.pageCount,
      pending: pagination.pending,
      layoutSignature: JSON.stringify(layout.breaks),
      selection: {
        from: selection.from,
        to: selection.to,
        anchor: selection.anchor,
        head: selection.head,
        empty: selection.empty
      },
      domSelection: null,
      caretRect: null,
      boundary: layout.breaks.find(item => Number.isInteger(item.paragraphPos))?.pos ?? null,
      composing: editor.view.composing,
      editorFocused: editor.view.hasFocus(),
      windowFocused: doc.hasFocus(),
      visibility: doc.visibilityState,
      scrolling,
      windowScroll: { x: win.scrollX, y: win.scrollY },
      originalMatches: JSON.stringify(editor.getJSON()) === original,
      textLength: content.textContent.length,
      textAroundCaret: content.textBetween(
        Math.max(0, selection.from - 24),
        Math.min(content.content.size, selection.to + 24)
      ),
      inputEvents: events.length,
      droppedEvents,
      throttledMoves
    }
    if (selected?.anchorNode && editor.view.dom.contains(selected.anchorNode)) {
      try {
        state.domSelection = {
          anchor: editor.view.posAtDOM(selected.anchorNode, selected.anchorOffset),
          focus: editor.view.posAtDOM(selected.focusNode, selected.focusOffset),
          collapsed: selected.isCollapsed,
          text: selected.toString()
        }
      } catch (error) {
        // IME 暂态 DOM 可能尚未映射进模型；保留错误证据，不猜测原文位置。
        state.domSelection = { mappingError: error.message }
      }
    }
    try {
      const rect = editor.view.coordsAtPos(selection.head)
      state.caretRect = {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      }
    } catch (error) {
      state.caretRect = { measurementError: error.message }
    }
    if (composition) {
      state.compositionObservation = {
        initialGapCount: composition.gaps.length,
        connectedInitialGaps: composition.gaps.filter(node => node.isConnected).length,
        breaksUnchanged: state.layoutSignature === composition.layoutSignature
      }
    }
    return state
  }

  const refresh = () => {
    // 合并状态面板写入，避免指针移动频率改变被验收的编辑布局。
    if (destroyed || frame) return
    frame = win.requestAnimationFrame(() => {
      frame = 0
      onChange()
    })
  }

  const record = (type, detail = {}) => {
    if (destroyed) return
    if (getContext().editor !== editor) {
      if (sessionChanged) return
      sessionChanged = true
      type = "session-changed"
      detail = { stopped: "编辑器实例已切换，后续事件不混入原夹具记录" }
    }
    events.push({
      sequence: ++sequence,
      at: new Date().toISOString(),
      elapsedMs: performance.now() - startedMs,
      phase,
      type,
      geometryTiming: "synchronous-observer",
      ...detail,
      state: readState()
    })
    // 保留有界记录，并显式报告丢弃数量，不能把截断轨迹当作完整验收。
    if (events.length > 2000) {
      events.shift()
      droppedEvents += 1
    }
    refresh()
    return sequence
  }

  const recordAfterDispatch = type => {
    // 捕获监听先于 ProseMirror；补记事件处理后的模型，不能把旧选区当确认结果。
    queueMicrotask(() => record(`${type}:after-dispatch`, {
      geometryTiming: "after-dispatch-microtask"
    }))
  }

  const stopRenderFrames = reason => {
    if (!renderSampling) return
    const group = renderSampling
    renderSampling = null
    if (group.frame) win.cancelAnimationFrame(group.frame)
    if (group.timer) win.clearTimeout(group.timer)
    win.clearTimeout(group.deadline)
    record("render-frame-group-end", {
      renderGroup: group.id,
      endSeq: group.endSeq,
      samples: group.samples,
      afterEndMs: performance.now() - group.startedMs,
      reason
    })
  }

  const startRenderFrames = endSeq => {
    stopRenderFrames("new-composition-end")
    const group = {
      id: ++renderGroup,
      endSeq,
      startedMs: performance.now(),
      samples: 0,
      frame: 0,
      timer: 0,
      deadline: 0
    }
    renderSampling = group
    record("render-frame-group-start", {
      renderGroup: group.id,
      endSeq,
      samplingWindowMs: 300
    })
    const sampleNextFrame = () => {
      group.frame = win.requestAnimationFrame(frameTimeStamp => {
        group.frame = 0
        if (destroyed || renderSampling !== group) return
        // RAF 内仍可能发生同步重排；下一任务读取绘制周期后的几何，不能冒充录屏像素。
        group.timer = win.setTimeout(() => {
          group.timer = 0
          if (destroyed || renderSampling !== group) return
          if (getContext().editor !== editor || editor.isDestroyed) {
            stopRenderFrames("editor-session-ended")
            return
          }
          group.samples += 1
          const afterEndMs = performance.now() - group.startedMs
          record("render-frame", {
            geometryTiming: "animation-frame-then-task",
            renderGroup: group.id,
            endSeq,
            sample: group.samples,
            frameTimeStamp,
            afterEndMs
          })
          if (afterEndMs >= 300) stopRenderFrames("sampling-window-complete")
          else sampleNextFrame()
        }, 0)
      })
    }
    // 后台窗口可能停止 RAF；350 ms 上限明确结束缺少帧的采样，不伪造绘制结果。
    group.deadline = win.setTimeout(() => {
      if (renderSampling === group) stopRenderFrames("frame-deadline-reached")
    }, 350)
    sampleNextFrame()
  }

  const handleInput = event => {
    if (!editor.view.dom.contains(event.target)) return
    editorActivity = true
    if (event.type === "compositionstart") {
      composition = {
        gaps: [...editor.view.dom.querySelectorAll("[data-mewoc-page-gap]")],
        layoutSignature: readState().layoutSignature
      }
    }
    const detail = {
      trusted: event.isTrusted,
      eventTimeStamp: event.timeStamp,
      data: event.data,
      key: event.key,
      code: event.code,
      inputType: event.inputType,
      eventComposing: event.isComposing,
      modifiers: {
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key?.toLowerCase() === "z") {
      detail.historyAction = event.shiftKey ? "redo" : "undo"
    }
    const eventSequence = record(event.type, detail)
    recordAfterDispatch(event.type)
    if (event.type === "compositionend") startRenderFrames(eventSequence)
  }

  const handlePointer = event => {
    const inside = event.target instanceof win.Node && editor.view.dom.contains(event.target)
    if (event.type === "pointerdown") {
      pointerSession = inside
      pointerPressed = inside && event.button === 0
      editorActivity = inside
    }
    if (!pointerSession) return
    if (event.type === "pointermove") {
      // 每 80 ms 取一个移动点；按下、释放、失焦等边界事件不节流。
      if (performance.now() - lastMoveMs < 80) {
        throttledMoves += 1
        return
      }
      lastMoveMs = performance.now()
    }
    record(event.type, {
      trusted: event.isTrusted,
      eventTimeStamp: event.timeStamp,
      insideEditor: inside,
      pointerPressedBefore: pointerPressed,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: event.button,
      buttons: event.buttons,
      client: { x: event.clientX, y: event.clientY },
      screen: { x: event.screenX, y: event.screenY }
    })
    if (["pointerup", "mouseup", "pointercancel", "lostpointercapture"].includes(event.type)) {
      // 捕获丢失不等于按钮释放，保留仍按住的观察状态等待返回事件确认。
      if (event.type !== "lostpointercapture" || event.buttons === 0) pointerPressed = false
      recordAfterDispatch(event.type)
    }
    if (event.type === "pointermove" && event.buttons === 0 && pointerPressed) {
      pointerPressed = false
      record("pointer-return-without-buttons")
    }
  }

  const handleWindow = event => {
    // blur 到达时浏览器焦点已丢失，必须保留此前由夹具发起的活动归属。
    if (!pointerSession && !editorActivity && !editor.view.composing) return
    record(`window-${event.type}`, { trusted: event.isTrusted, eventTimeStamp: event.timeStamp })
    recordAfterDispatch(`window-${event.type}`)
  }

  const handleSelection = event => {
    const selected = doc.getSelection()
    if (!pointerSession && !editor.view.dom.contains(selected?.anchorNode)) return
    record("selectionchange", { trusted: event.isTrusted, eventTimeStamp: event.timeStamp })
  }

  const handleTransaction = ({ transaction }) => {
    record("editor-transaction", {
      geometryTiming: "synchronous-transaction",
      docChanged: transaction.docChanged,
      selectionSet: transaction.selectionSet,
      addToHistory: transaction.getMeta("addToHistory")
    })
  }

  const handlePagination = () => {
    record("pagination-update", { geometryTiming: "synchronous-pagination-notification" })
    if (!editor.view.composing) composition = null
  }

  for (const type of INPUT_EVENTS) editor.view.dom.addEventListener(type, handleInput, true)
  for (const type of POINTER_EVENTS) win.addEventListener(type, handlePointer, true)
  win.addEventListener("blur", handleWindow)
  win.addEventListener("focus", handleWindow)
  doc.addEventListener("selectionchange", handleSelection)
  editor.on("transaction", handleTransaction)
  editor.on("paginationUpdate", handlePagination)
  record("recording-start")

  return {
    readState,
    setPhase(value) {
      phase = value
      record("phase-change")
    },
    recordCheckpoint() {
      const checkpoint = {
        sequence: sequence + 1,
        at: new Date().toISOString(),
        phase,
        state: readState(),
        content: editor.getJSON(),
        page: JSON.parse(JSON.stringify(getContext().store.getState().page))
      }
      checkpoints.push(checkpoint)
      record("checkpoint", { checkpointIndex: checkpoints.length - 1 })
    },
    getEvidence() {
      return {
        startedAt,
        phase,
        baselineContent: JSON.parse(original),
        events,
        checkpoints,
        droppedEvents,
        throttledMoves,
        sessionChanged,
        renderSampling: {
          windowMs: 300,
          deadlineMs: 350,
          activeGroup: renderSampling?.id ?? null,
          note: "render-frame 为真实 RAF 后下一任务采样，区别于同步事务；不单独证明物理屏幕已显示该帧。"
        },
        limitations: "仅观察当前夹具；窗口外系统事件不可直接读取。isTrusted 不证明物理硬件来源，候选窗口和人工动作需独立记录。"
      }
    },
    destroy() {
      stopRenderFrames("recorder-destroyed")
      destroyed = true
      if (frame) win.cancelAnimationFrame(frame)
      for (const type of INPUT_EVENTS) editor.view.dom.removeEventListener(type, handleInput, true)
      for (const type of POINTER_EVENTS) win.removeEventListener(type, handlePointer, true)
      win.removeEventListener("blur", handleWindow)
      win.removeEventListener("focus", handleWindow)
      doc.removeEventListener("selectionchange", handleSelection)
      editor.off("transaction", handleTransaction)
      editor.off("paginationUpdate", handlePagination)
    }
  }
}
