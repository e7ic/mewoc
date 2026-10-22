/** 持续使用真实 Provider/PaperCanvas，按原始 DOM 行矩形验收；不调用生产测量函数。 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import JSZip from "jszip"
import { closeHistory } from "@tiptap/pm/history"
import {
  EditorProvider,
  useDocumentEditor
} from "../src/pages/editor/components/EditorProvider.jsx"
import { PaperCanvas } from "../src/pages/editor/components/PaperCanvas.jsx"
import { PAGE_PAGINATION_KEY } from "../src/pages/editor/extensions/page-pagination.js"
import { getLocalDocument, getDocumentAssets } from "../src/pages/editor/tools/local-repository.js"
import {
  createDocumentHtml,
  createPortableFile,
  readPortableFile
} from "../src/pages/editor/tools/file-transfer.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"
import { observeSessionResources } from "./lifecycle-resources.js"
import { removeVerificationDocuments } from "./browser-checks.js"
import { createWaveFile } from "./media-fixtures.js"
import { requireVisibleBrowser } from "./browser-visibility.js"
import {
  createPaginationSoakDocument,
  createPaginationSoakImage,
  SOAK_END_TEXT
} from "./pagination-soak-fixture.js"

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const json = value => JSON.stringify(value)
const assert = (value, message) => {
  if (!value) {
    throw new Error(message)
  }
}

const SessionProbe = ({ capture }) => {
  const context = useDocumentEditor()
  useEffect(() => {
    if (context.editor) {
      capture(context)
    }
  }, [
    context,
    capture
  ])
  return <PaperCanvas />
}

async function mountSession(host, record) {
  return new Promise(resolve => {
    ReactDOM.render(
      <EditorProvider record={record}>
        <SessionProbe capture={resolve} />
      </EditorProvider>,
      host
    )
  })
}

async function settlePagination(session) {
  await document.fonts.ready
  const started = performance.now()
  let previous = ""
  let stable = 0
  while (performance.now() - started < 15000) {
    const state = PAGE_PAGINATION_KEY.getState(session.editor.state)
    const signature = json({
      layout: state.layout,
      height: session.editor.view.dom.getBoundingClientRect().height
    })
    stable = signature === previous && !state.pending ? stable + 1 : 0
    previous = signature
    if (stable >= 3 && state.layout.pageCount > 1) {
      return Math.round(performance.now() - started)
    }
    await delay(60)
  }
  throw new Error("混合长文分页在 15 秒内未收敛")
}

// DOM Range 一次读取一段文本节点的所有可见行；排除屏幕副本与隐藏详情。
function verifyGeometry(session, host) {
  const state = session.store.getState()
  const layout = state.pagination
  const origin = host.querySelector("[data-mewoc-editor-surface]").getBoundingClientRect().top
  let rectangles = 0
  const verifyRect = rect => {
    if (rect.height <= 0 || rect.width <= 0) {
      return
    }
    const top = (rect.top - origin) / state.zoom
    const bottom = (rect.bottom - origin) / state.zoom
    const page = layout.pages.find(item =>
      top >= item.top - 2 && top < item.top + item.height - 2)
    const topMargin = state.page.marginsMm.top * 96 / 25.4
    const bottomMargin = state.page.marginsMm.bottom * 96 / 25.4
    assert(
      page && top >= page.top + topMargin - 2 &&
        bottom <= page.top + page.height - bottomMargin + 2,
      `原始内容覆盖页边距：${top.toFixed(2)}–${bottom.toFixed(2)}`
    )
    rectangles += 1
  }
  session.editor.state.doc.descendants((node, pos) => {
    const dom = session.editor.view.nodeDOM(pos)
    if (!(dom instanceof HTMLElement) || dom.closest("[hidden]")) {
      return false
    }
    if (["paragraph", "heading", "codeBlock"].includes(node.type.name)) {
      const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const text = walker.currentNode
        if (text.parentElement.closest("[data-mewoc-page-gap],[data-mewoc-format-mark]")) {
          continue
        }
        const range = document.createRange()
        range.selectNodeContents(text)
        for (const rect of range.getClientRects()) {
          verifyRect(rect)
        }
      }
    }
    if (["tableRow", "image", "media", "attachment"].includes(node.type.name)) {
      verifyRect(dom.getBoundingClientRect())
    }
  })
  assert(layout.pageCount >= 8 && layout.overflowCount === 0, "混合长文未安全拆成标准页")
  return {
    pages: layout.pageCount,
    rectangles,
    gaps: layout.breaks.length
  }
}

async function checkReflow(session, host, index) {
  const { editor, store } = session
  const before = json(editor.getJSON())
  const originalPage = structuredClone(store.getState().page)
  const variants = [
    {
      size: "A5",
      orientation: "portrait"
    },
    {
      size: "Letter",
      orientation: "landscape"
    },
    {
      size: "A4",
      orientation: "portrait"
    }
  ]
  store.getState().updatePage({
    ...originalPage,
    ...variants[index % variants.length]
  })
  store.getState().updateView({
    zoom: [0.5, 0.75, 1.5][index % 3],
    fitWidth: false
  })
  const settleMs = await settlePagination(session)
  const geometry = verifyGeometry(session, host)
  const toggle = editor.view.dom.querySelector("[data-details-toggle]")
  const revision = store.getState().revision
  toggle.click()
  await settlePagination(session)
  assert(store.getState().pagination.pageCount < geometry.pages, "详情收起后未减少分页")
  toggle.click()
  await settlePagination(session)
  verifyGeometry(session, host)
  assert(json(editor.getJSON()) === before && store.getState().revision === revision,
    "缩放或详情重排改变了正文或保存修订")

  const gap = store.getState().pagination.breaks.find(item => Number.isInteger(item.paragraphPos))
  assert(gap, "缺少可执行跨页编辑的段内断点")
  const replacement = closeHistory(editor.state.tr).insertText(
    "M25_EDIT", gap.pos - 2, gap.pos + 2
  )
  editor.view.dispatch(replacement)
  editor.view.dispatch(closeHistory(editor.state.tr))
  await settlePagination(session)
  verifyGeometry(session, host)
  const edited = json(editor.getJSON())
  assert(edited !== before && editor.commands.undo(), "跨页替换未写入正文撤销")
  await settlePagination(session)
  assert(json(editor.getJSON()) === before, "跨页替换未一次撤销恢复")
  assert(editor.commands.redo(), "跨页替换不能重做")
  await settlePagination(session)
  assert(json(editor.getJSON()) === edited, "跨页重做结果改变")
  assert(editor.commands.undo(), "跨页重做后未恢复原文")
  await settlePagination(session)
  assert(json(editor.getJSON()) === before, "最终原文不一致")
  return {
    ...geometry,
    settleMs,
    size: store.getState().page.size,
    zoom: store.getState().zoom
  }
}

async function checkExports(session, index) {
  const snapshot = session.getSnapshot()
  const portable = await createPortableFile(snapshot, session.assets)
  const text = json(portable)
  assert(!/mewoc-page-gap|mewoc-container-clip/.test(text), "便携文件混入视图装饰")
  const restored = await readPortableFile(new File([
    text
  ], "soak.mewoc.json"))
  assert(json(restored.document.content) === json(snapshot.content), "备份正文往返不一致")
  for (const [id, asset] of session.assets) {
    const original = new Uint8Array(await asset.blob.arrayBuffer())
    const reopened = new Uint8Array(await restored.assets.get(id).blob.arrayBuffer())
    const sameBytes = original.length === reopened.length &&
      original.every((value, offset) => value === reopened[offset])
    assert(sameBytes, "备份资源字节不一致")
  }
  const html = await createDocumentHtml(snapshot, session.assets)
  assert(html.includes(SOAK_END_TEXT) && !/data-mewoc-page-gap|data-mewoc-repeat-header/.test(html),
    "HTML 丢失尾段或混入分页装饰")
  if (index % 10 !== 0) {
    return false
  }
  const word = await createDocumentDocx(snapshot, session.assets)
  const zip = await JSZip.loadAsync(await word.blob.arrayBuffer())
  const xml = await zip.file("word/document.xml").async("string")
  assert(xml.split(SOAK_END_TEXT).length === 2 && !xml.includes("mewoc-page-gap"),
    "Word 尾段重复、丢失或混入视图装饰")
  return true
}

async function unmountSession(host, session) {
  try {
    if (session && !session.editor.isDestroyed) {
      assert(await session.saveDocument(), "卸载前保存失败")
    }
  } finally {
    ReactDOM.unmountComponentAtNode(host)
    await delay(30)
  }
  if (session) {
    assert(session.editor.isDestroyed, "旧编辑器没有销毁")
  }
}

async function checkSessionCycle(host, file, index) {
  const record = {
    document: createPaginationSoakDocument(),
    storageVersion: 0,
    assets: new Map()
  }
  let session
  try {
    session = await mountSession(host, record)
    await settlePagination(session)
    session.editor.commands.setTextSelection(1)
    await session.insertImages([
      file
    ])
    await session.insertAttachment(new File([
      "M25 持续验收附件"
    ], "soak.txt", {
      type: "text/plain"
    }))
    await session.insertMedia(createWaveFile("soak.wav"), "audio")
    assert(session.assets.size === 3, "图片、附件或音频未插入")
    await settlePagination(session)
    const metrics = await checkReflow(session, host, index)
    assert(await session.saveDocument(), "混合长文保存失败")
    const snapshot = session.getSnapshot()
    const word = await checkExports(session, index)
    const oldStore = session.store
    await unmountSession(host, session)
    const oldLayout = oldStore.getState().pagination
    const saved = await getLocalDocument(record.document.id)
    assert(json(saved.document.content) === json(snapshot.content) &&
      json(saved.document.page) === json(snapshot.page), "数据库没有保存最新正文和纸张")
    const assets = await getDocumentAssets(saved.document)
    assets.forEach(asset => {
      asset.url = URL.createObjectURL(asset.blob)
    })
    session = await mountSession(host, {
      ...saved,
      assets
    })
    await settlePagination(session)
    assert(json(session.editor.getJSON()) === json(snapshot.content), "重开正文与保存快照不一致")
    verifyGeometry(session, host)
    assert(oldStore.getState().pagination === oldLayout, "旧分页结果在新会话中继续更新")
    assert(host.querySelectorAll(".ProseMirror").length === 1 &&
      host.querySelectorAll("audio").length === 1, "会话切换残留正文或重复媒体")
    return {
      ...metrics,
      word,
      assets: assets.size
    }
  } finally {
    try {
      await unmountSession(host, session)
    } finally {
      await removeVerificationDocuments([
        record
      ])
    }
  }
}

export async function runPaginationSoak(report, control, minutes = 0) {
  const allowedPorts = ["4182", "4190"]
  assert(
    location.hostname === "127.0.0.1" && allowedPorts.includes(location.port),
    "分页持续验收仅允许在专用 127.0.0.1:4182 或 :4190 运行"
  )
  await requireVisibleBrowser()
  const host = document.createElement("section")
  host.style.cssText = "position:relative;width:1200px;max-width:100%;height:900px"
  document.body.append(host)
  const resources = observeSessionResources()
  const started = performance.now()
  const errors = []
  const onError = event => errors.push(event.message || String(event.reason))
  window.addEventListener("error", onError)
  window.addEventListener("unhandledrejection", onError)
  let rounds = 0
  try {
    const file = await createPaginationSoakImage()
    do {
      const cycleStarted = performance.now()
      const metrics = await checkSessionCycle(host, file, rounds)
      const counts = resources.getCounts()
      assert(!counts.urls && !counts.observers && !counts.mutationObservers && !counts.listeners,
        `资源未释放：${json(counts)}；来源：${json(resources.getDetails())}`)
      assert(errors.length === 0, errors.join("；"))
      rounds += 1
      report({
        name: `混合长文第 ${rounds} 轮`,
        passed: true,
        elapsedSeconds: Math.round((performance.now() - started) / 1000),
        cycleMs: Math.round(performance.now() - cycleStarted),
        visible: document.visibilityState === "visible",
        ...metrics,
        ...counts
      })
      if (minutes && !control.stopped) {
        await delay(Math.max(0, 5000 - performance.now() + cycleStarted))
      }
    } while (!control.stopped && (
      minutes ? performance.now() - started < minutes * 60000 : rounds < 6
    ))
    report({
      name: control.stopped ? "持续验收已停止并清理" : "持续验收完成",
      passed: true,
      stopped: control.stopped,
      rounds,
      mounts: rounds * 2,
      elapsedSeconds: Math.round((performance.now() - started) / 1000)
    })
  } catch (error) {
    report({
      name: "分页持续验收失败",
      passed: false,
      error: error.message,
      ...resources.getCounts()
    })
  } finally {
    window.removeEventListener("error", onError)
    window.removeEventListener("unhandledrejection", onError)
    resources.restore()
    host.remove()
  }
}
