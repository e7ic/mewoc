import React from "react"
import { closeHistory } from "@tiptap/pm/history"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { createDocumentHtml } from "../src/pages/editor/tools/file-transfer.js"
import { getDocuments, getDocumentAssets } from "../src/pages/editor/tools/local-repository.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { checkImageInteractions } from "./interaction-checks.js"
import { checkFormulaFlows } from "./formula-checks.js"
import { checkCodeFlows } from "./code-checks.js"
import { checkMarkdownFlows } from "./markdown-checks.js"
import { checkAttachmentFlows } from "./attachment-checks.js"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function runEditorChecks(sessions, report) {
  const { left, right } = sessions
  const { editor, store } = left
  const check = async (name, action) => {
    try {
      await action()
      report({ name, passed: true })
    } catch (error) {
      report({ name, passed: false, error: error.message })
    }
  }
  await check("React 17 与双编辑器 / 双 Zustand 实例隔离", () => {
    assert(React.version === "17.0.2", React.version)
    editor.commands.setContent("<p>独立编辑</p>")
    store.getState().updateTitle("左侧文档")
    assert(right.editor.getText() === "" && right.store.getState().title !== "左侧文档", "实例状态串联")
  })
  await check("加粗、撤销、重做与格式序列化", () => {
    editor.commands.setTextSelection(5)
    editor.view.dispatch(closeHistory(editor.state.tr))
    editor.commands.insertContent({ type: "text", text: "加粗", marks: [{ type: "bold" }] })
    assert(editor.getHTML().includes("<strong>加粗</strong>"), "加粗未序列化")
    editor.commands.undo()
    assert(!editor.getText().includes("加粗"), "撤销未恢复")
    editor.commands.redo()
    assert(editor.getText().includes("加粗"), "重做未恢复")
  })
  await check("跨段落行距一次应用且可撤销", () => {
    editor.commands.setContent("<p>段落一</p><p>段落二</p>")
    editor.commands.selectAll()
    editor.view.dispatch(closeHistory(editor.state.tr))
    editor.commands.setParagraphSpacing(2)
    assert(editor.getJSON().content.every(node => node.attrs.lineHeight === 2), "行距范围错误")
    editor.commands.undo()
    assert(editor.getJSON().content.every(node => !node.attrs.lineHeight), "撤销行距失败")
  })
  await check("段落缩进进入 HTML / 打印共用输出且不丢失行距", async () => {
    editor.commands.setContent("<p>缩进输出</p>")
    editor.commands.setParagraphSpacing(2)
    editor.commands.setParagraphIndent({ firstLineIndent: 2, leftIndent: 4 })
    const html = await createDocumentHtml(left.getSnapshot(), new Map())
    const output = new DOMParser().parseFromString(html, "text/html").querySelector("article p")
    assert(output.style.textIndent === "2em" && output.style.marginLeft === "4em", "输出缩进丢失")
    assert(output.style.lineHeight === "2", "已有行距丢失")
  })
  await check("查找替换跨文字 mark，全部替换可撤销", async () => {
    editor.commands.setContent("<p>中<strong>文</strong>中文</p><p>中文</p>")
    editor.commands.setSearchTerm("中文")
    await new Promise(resolve => setTimeout(resolve, 200))
    assert(editor.storage.findAndReplace.results.length === 3, "匹配数量错误")
    editor.view.dispatch(closeHistory(editor.state.tr))
    editor.commands.setReplaceTerm("写作")
    editor.commands.replaceAll()
    assert(!editor.getText().includes("中文"), "未完成全部替换")
    editor.commands.undo()
    assert(editor.getText().includes("中文"), "替换不可撤销")
    editor.commands.clearSearch()
  })
  await check("表格增删行列与 schema 保存", () => checkTableCommands(editor, left.getSnapshot))
  for (const scale of [0.5, 1, 1.5]) {
    await check(`表格列宽：${scale * 100}% 缩放下屏幕位移换算`, () => checkTableResize(editor, scale))
  }
  await check("整行合并表格按既有列宽比例拖动且可撤销", () => checkMergedTableResize(editor))
  await check("列宽拖动失去鼠标按键后取消预览，不提交悬停坐标", () => checkReleasedTableDrag(editor))
  await checkImageFlows(left, check)
  await checkImageInteractions(left, check)
  await checkPasteFlows(left, check)
  await checkFormulaFlows(left, check)
  await checkCodeFlows(left, check)
  await checkMarkdownFlows(left, check)
  await checkAttachmentFlows(left, check)
  await check("1 万字输入与快照可用", () => {
    const start = performance.now()
    right.editor.commands.setContent({ type: "doc", content: Array.from({ length: 100 }, () => ({ type: "paragraph", content: [{ type: "text", text: "中".repeat(100) }] })) })
    right.editor.commands.setTextSelection(1)
    right.editor.commands.insertContent("新增")
    assert(right.getSnapshot().content.content[0].content[0].text.startsWith("新增"), "长文档输入失败")
    report({ name: `1 万字载入、编辑、序列化耗时 ${Math.round(performance.now() - start)} ms（本机观测）`, passed: true })
  })
}

async function checkPasteFlows(left, check) {
  const { editor } = left
  await check("富文本粘贴清理脚本、事件、外链图片与危险 URL", () => {
    const html = cleanPastedHtml('<p onclick="bad()">文字</p><script>bad()</script><a href="javascript:bad()">链接</a>')
    assert(!/onclick|script|javascript/.test(html), "危险 HTML 未清理")
  })
  await check("内部粘贴保留支持的颜色、字体、字号与段落行距", () => {
    editor.commands.setContent("<p>格式保留</p>")
    editor.commands.selectAll()
    editor.commands.setColor("#6657d9")
    editor.commands.setFontSize("18pt")
    editor.commands.setFontFamily("SimSun, Songti SC, serif")
    editor.commands.setParagraphSpacing(2)
    editor.commands.setContent(cleanPastedHtml(editor.getHTML()))
    const node = editor.getJSON().content[0]
    const mark = node.content[0].marks.find(item => item.type === "textStyle")
    assert(mark.attrs.color === "#6657d9" && mark.attrs.fontSize === "18pt" && mark.attrs.fontFamily === "SimSun, Songti SC, serif", "文字格式丢失")
    assert(node.attrs.lineHeight === 2, "段落行距丢失")
    left.getSnapshot()
  })
}

async function checkImageFlows(left, check) {
  const { editor, store, assets } = left
  await check("真实图片解码、插入与节点视图", async () => {
    editor.commands.setContent("<p>图片测试</p>")
    const file = await createImageFixture()
    await left.insertImages([file])
    assert(getImage(editor)?.attrs.width === 240, "图片没有插入")
    const image = editor.view.dom.querySelector("figure img")
    await image.decode()
    assert(image.naturalWidth === 240, "图片没有解码")
  })
  for (const scale of [0.5, 1, 1.5]) {
    await check(`图片宽度：${scale * 100}% 缩放下键盘调整`, () => checkImageKeyboard(editor, scale))
    await check(`图片拖动：${scale * 100}% 缩放坐标（模拟指针捕获）`, () => checkImagePointer(editor, scale))
  }
  await check("带图文件跨会话还原与静态 HTML 图片输出", async () => {
    const snapshot = left.getSnapshot()
    const portable = await createPortableFile(snapshot, assets)
    const restored = await readPortableFile(new File([JSON.stringify(portable)], "test.mewoc.json"))
    assert(restored.document.id !== snapshot.id && restored.assets.size === 1, "图片文件无法独立恢复")
    const html = await createDocumentHtml(snapshot, assets)
    assert(html.includes("data:image/png;base64,") && !html.includes("blob:"), "HTML 引用了临时 URL")
    const rendered = new DOMParser().parseFromString(html, "text/html")
    assert(!rendered.body.querySelector("[data-resize-handle]"), "HTML 泄漏编辑控制柄")
  })
  await check("浏览器 IndexedDB 保存正文与 Blob 后可重新读取", async () => {
    assert(await left.saveDocument(), store.getState().saveError)
    const record = (await getDocuments()).find(item => item.id === left.getSnapshot().id)
    const loadedAssets = await getDocumentAssets(record.document)
    assert(loadedAssets.size === 1 && record.document.content.content.some(node => node.type === "image"), "资源保存失败")
  })
  await check("删图保存回收资源，撤销后可再次保存并恢复图片", () => checkDeletedImage(left))
  await check("只读期间异步图片结果不写入正文", async () => {
    const file = await createImageFixture()
    const content = editor.getJSON()
    const inserting = left.insertImages([file])
    editor.setEditable(false, false)
    await inserting
    assert(JSON.stringify(editor.getJSON()) === JSON.stringify(content), "只读仍写入图片")
    editor.setEditable(true, false)
  })
  await check("同一文档内部复制图片保留稳定资源引用", () => {
    const snapshot = left.getSnapshot()
    const html = cleanPastedHtml(editor.getHTML(), id => assets.has(id))
    editor.commands.setContent(html)
    assert(getImage(editor)?.attrs.assetId === snapshot.assets[0].id, "内部图片复制丢失资源")
    left.getSnapshot()
  })
}

async function checkDeletedImage({ editor, getSnapshot, saveDocument, assets }) {
  const before = getSnapshot()
  let position = null
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "image") position = pos })
  assert(position !== null, "没有可删除的图片")
  editor.view.dispatch(closeHistory(editor.state.tr))
  editor.commands.deleteRange({ from: position, to: position + 1 })
  assert(getSnapshot().assets.length === 0 && await saveDocument(), "删除图片没有保存")
  let missing = false
  try {
    await getDocumentAssets(before)
  } catch (error) {
    missing = error.message.includes("资源缺失")
  }
  assert(missing && assets.size > 0, "磁盘旧资源未回收或会话撤销缓存丢失")
  editor.commands.undo()
  assert(getSnapshot().assets.length === 1 && await saveDocument(), "撤销未恢复图片引用")
  const restored = await getDocumentAssets(getSnapshot())
  assert(restored.get(before.assets[0].id).blob.size === before.assets[0].byteLength, "撤销后图片未重新写回磁盘")
}

function checkTableCommands(editor, getSnapshot) {
  editor.commands.setContent("<p></p>")
  editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
  editor.commands.addRowAfter()
  editor.commands.addColumnAfter()
  let table = editor.getJSON().content.find(node => node.type === "table")
  assert(table.content.length === 4 && table.content[0].content.length === 4, "表格增加失败")
  editor.commands.deleteRow()
  editor.commands.deleteColumn()
  table = editor.getJSON().content.find(node => node.type === "table")
  assert(table.content.length === 3 && table.content[0].content.length === 3, "表格删除失败")
  const cells = []
  editor.state.doc.descendants((node, pos) => { if (["tableCell", "tableHeader"].includes(node.type.name)) cells.push(pos) })
  editor.commands.setCellSelection({ anchorCell: cells[0], headCell: cells[1] })
  editor.commands.mergeCells()
  assert(editor.getJSON().content.find(node => node.type === "table").content[0].content[0].attrs.colspan === 2, "合并单元格失败")
  editor.commands.splitCell()
  assert(editor.getJSON().content.find(node => node.type === "table").content[0].content[0].attrs.colspan === 1, "拆分单元格失败")
  getSnapshot()
}

function checkTableResize(editor, scale) {
  const wrapper = editor.view.dom.closest("[data-probe]")
  wrapper.style.transform = `scale(${scale})`
  const cell = editor.view.dom.querySelector("th, td")
  const rect = cell.getBoundingClientRect()
  const before = rect.width / scale
  const x = rect.right - 1
  cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: rect.top + 10 }))
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: x + 20, clientY: rect.top + 10 }))
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x + 20, clientY: rect.top + 10 }))
  const table = editor.getJSON().content.find(node => node.type === "table")
  const width = table.content[0].content[0].attrs.colwidth?.[0]
  assert(Math.abs(width - before - 20 / scale) < 3, `宽度错误：${before} → ${width}`)
  wrapper.style.transform = ""
}

function checkMergedTableResize(editor) {
  const cell = { type: "tableCell", attrs: { colspan: 3, rowspan: 1, colwidth: [100, 200, 300] }, content: [{ type: "paragraph" }] }
  editor.commands.setContent({ type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [cell] }] }] })
  const before = editor.getJSON()
  editor.view.dispatch(closeHistory(editor.state.tr))
  const element = editor.view.dom.querySelector("td")
  const rect = element.getBoundingClientRect()
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: rect.right - 1, clientY: rect.top + 5 }))
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: rect.right + 29, clientY: rect.top + 5 }))
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  const widths = editor.getJSON().content.find(node => node.type === "table").content[0].content[0].attrs.colwidth
  assert(Math.abs(widths[0] - 100) < 2 && Math.abs(widths[1] - 200) < 2 && Math.abs(widths[2] - 330) < 2, `合并列宽错误：${widths}`)
  editor.commands.undo()
  assert(JSON.stringify(editor.getJSON()) === JSON.stringify(before), "列宽拖动无法撤销")
}

function checkReleasedTableDrag(editor) {
  const before = JSON.stringify(editor.getJSON())
  const cell = editor.view.dom.querySelector("td, th")
  const rect = cell.getBoundingClientRect()
  const table = cell.closest("table")
  const style = table.getAttribute("style")
  cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1, clientX: rect.right - 1, clientY: rect.top + 5 }))
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: rect.right + 29 }))
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 0, clientX: 100 }))
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  assert(JSON.stringify(editor.getJSON()) === before, "已松开鼠标的悬停事件仍然改变文档")
  assert(table.getAttribute("style") === style, "取消后未恢复表格预览宽度")
}

async function createImageFixture() {
  const canvas = document.createElement("canvas")
  canvas.width = 240
  canvas.height = 120
  const context = canvas.getContext("2d")
  context.fillStyle = "#6657d9"
  context.fillRect(0, 0, 240, 120)
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"))
  return new File([blob], "verification.png", { type: "image/png" })
}

function getImage(editor) {
  return editor.getJSON().content.find(node => node.type === "image")
}

function checkImageKeyboard(editor, scale) {
  const wrapper = editor.view.dom.closest("[data-probe]")
  wrapper.style.transform = `scale(${scale})`
  const width = getImage(editor).attrs.width
  const handle = editor.view.dom.querySelector("[data-resize-handle]")
  handle.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
  assert(getImage(editor).attrs.width === width + 10, "图片尺寸受页面缩放影响")
  wrapper.style.transform = ""
}

function checkImagePointer(editor, scale) {
  const wrapper = editor.view.dom.closest("[data-probe]")
  wrapper.style.transform = `scale(${scale})`
  const width = getImage(editor).attrs.width
  const handle = editor.view.dom.querySelector("[data-resize-handle]")
  const capture = handle.setPointerCapture
  // 合成指针没有系统捕获会话；此用例仅验证应用的坐标与提交逻辑。
  handle.setPointerCapture = () => undefined
  try {
    handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, pointerId: 1 }))
    handle.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 120, pointerId: 1, buttons: 1 }))
    handle.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 120, pointerId: 1 }))
    assert(Math.abs(getImage(editor).attrs.width - width - 20 / scale) < 2, "图片拖动幅度错误")
  } finally {
    handle.setPointerCapture = capture
    wrapper.style.transform = ""
  }
}

export async function removeVerificationDocuments(records) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("mewoc")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(["documents", "assets"], "readwrite")
    records.forEach(record => {
      transaction.objectStore("documents").delete(record.document.id)
      record.assets.forEach(asset => transaction.objectStore("assets").delete(`${record.document.id}:${asset.id}`))
    })
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}
