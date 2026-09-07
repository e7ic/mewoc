import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { createDocumentHtml } from "../src/pages/editor/tools/file-transfer.js"
import { getDocumentAssets, getDocuments } from "../src/pages/editor/tools/local-repository.js"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function runStressChecks(session, report) {
  for (const [name, action] of [["10 万字独立样例", checkLongDocument], ["100×10 表格独立样例", checkLargeTable], ["20 张图片独立样例", checkManyImages]]) {
    try {
      const metrics = await action(session)
      report({ name, passed: true, metrics })
    } catch (error) {
      report({ name, passed: false, error: error.message })
    }
  }
}

async function checkLongDocument({ editor, getSnapshot, saveDocument }) {
  const start = performance.now()
  const content = Array.from({ length: 1000 }, (_, index) => ({
    type: "paragraph", content: [{ type: "text", text: `${String(index).padStart(4, "0")}${"中".repeat(96)}` }]
  }))
  editor.commands.setContent({ type: "doc", content })
  const loaded = performance.now()
  await nextPaint()
  const laidOut = performance.now()
  const edits = []
  const frames = []
  for (let index = 0; index < 30; index += 1) {
    editor.commands.setTextSelection(index % 2 ? editor.state.doc.content.size - 1 : 1)
    const before = performance.now()
    editor.commands.insertContent("字")
    edits.push(performance.now() - before)
    await nextPaint()
    frames.push(performance.now() - before)
  }
  const snapshotStart = performance.now()
  const snapshot = getSnapshot()
  const snapshotMs = performance.now() - snapshotStart
  assert(editor.state.doc.textContent.length === 100030, "长文档编辑后字数错误")
  assert(snapshot.content.content.length === 1000, "序列化丢失段落")
  const saveStart = performance.now()
  assert(await saveDocument(), "长文档保存失败")
  const records = await getDocuments()
  assert(records.find(record => record.id === snapshot.id).document.content.content.length === 1000, "本地恢复丢失段落")
  return { loadMs: loaded - start, layoutWaitMs: laidOut - loaded, commandP95Ms: percentile(edits), twoFrameP95Ms: percentile(frames), snapshotMs, saveAndReadMs: performance.now() - saveStart }
}

async function checkLargeTable({ editor, getSnapshot, saveDocument }) {
  editor.commands.setContent("<p></p>")
  const start = performance.now()
  editor.commands.insertTable({ rows: 100, cols: 10, withHeaderRow: true })
  await nextPaint()
  const laidOut = performance.now()
  editor.commands.insertContent("表格编辑")
  editor.commands.addColumnAfter()
  editor.commands.deleteColumn()
  const commandEnd = performance.now()
  const snapshot = getSnapshot()
  const table = snapshot.content.content.find(node => node.type === "table")
  assert(table.content.length === 100 && table.content.every(row => row.content.length === 10), "大表格行列数错误")
  assert(editor.view.dom.querySelectorAll("td, th").length === 1000, "表格 DOM 单元格丢失")
  assert(await saveDocument(), "大表格保存失败")
  return { loadAndLayoutMs: laidOut - start, editColumnMs: commandEnd - laidOut, snapshotAndSaveMs: performance.now() - commandEnd }
}

async function checkManyImages({ editor, assets, insertImages, getSnapshot, saveDocument }) {
  editor.commands.setContent("<p>20 张图片验收</p>")
  const canvas = document.createElement("canvas")
  canvas.width = 1200
  canvas.height = 800
  const context = canvas.getContext("2d")
  context.fillStyle = "#6657d9"
  context.fillRect(0, 0, 1200, 800)
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
  const start = performance.now()
  await insertImages(Array.from({ length: 20 }, (_, index) => new File([blob], `stress-${index}.png`, { type: blob.type })))
  await Promise.all([...editor.view.dom.querySelectorAll("img")].map(image => image.decode()))
  await nextPaint()
  const inserted = performance.now()
  const snapshot = getSnapshot()
  assert(snapshot.assets.length === 20, `应插入 20 张图，实际 ${snapshot.assets.length}`)
  assert(await saveDocument(), "20 张图保存失败")
  const restored = await getDocumentAssets(snapshot)
  assert(restored.size === 20, "图片存储恢复数量错误")
  const portable = await createPortableFile(snapshot, assets)
  const imported = await readPortableFile(new File([JSON.stringify(portable)], "stress.mewoc.json"))
  assert(imported.assets.size === 20, "带图文件资源丢失")
  const html = await createDocumentHtml(snapshot, assets)
  assert(new DOMParser().parseFromString(html, "text/html").images.length === 20, "HTML 导出丢图")
  return { imageSize: "1200×800", totalBytes: blob.size * 20, insertDecodeLayoutMs: inserted - start, storageAndExportsMs: performance.now() - inserted }
}

function percentile(values) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
}

function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}
