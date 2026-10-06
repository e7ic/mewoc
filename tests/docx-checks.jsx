/**
 * Word 导出的浏览器验收覆盖真实图片转码、失败回收、重复点击与旧会话异步结果保护。
 * 直接转换测试和 ExportActions 弹窗测试共享图片 fixture，下载行为用局部拦截观察后恢复。
 */
import ReactDOM from "react-dom"
import { EditorContext } from "../src/pages/editor/components/EditorProvider.jsx"
import { ExportActions } from "../src/pages/editor/components/ExportActions.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"

function assert(value, message) {
  if (!value) throw new Error(message)
}

// 有界轮询等实际异步转换和 portal 状态，条件满足立即继续，十秒超时保留具体失败原因。
async function waitFor(read, message) {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

export async function runDocxChecks(report) {
  // 每项单独报告成功或失败，使资源路径失败不掩盖后续界面生命周期问题。
  const check = async (name, action) => {
    try { await action(); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
  }
  // 通过浏览器 Canvas 生成真实图片以覆盖平台解码/转码，WebP 不支持编码时回退固定有效样本。
  const canvas = document.createElement("canvas")
  canvas.width = 32
  canvas.height = 16
  canvas.getContext("2d").fillRect(0, 0, 16, 16)
  const webp = await new Promise(resolve => canvas.toBlob(resolve, "image/webp"))
  // Safari 不一定支持 Canvas 编码 WebP，使用浏览器自带解码器验证固定的无损 WebP 样本。
  const bytes = Uint8Array.from(atob("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="), value => value.charCodeAt(0))
  const blob = webp?.type === "image/webp" ? webp : new Blob([bytes], { type: "image/webp" })
  const asset = { id: "docx-webp", fileName: "透明图片.webp", mimeType: blob.type, byteLength: blob.size, blob }
  const source = createDocument()
  source.assets = [{ id: asset.id, fileName: asset.fileName, mimeType: asset.mimeType, byteLength: asset.byteLength }]
  source.content.content = [{ type: "image", attrs: { assetId: asset.id, width: 32, height: 16 } }]
  const assets = new Map([[asset.id, asset]])
  await check("DOCX 浏览器 WebP 转 PNG 并释放 ImageBitmap", async () => {
    // 暂时包装真实 Bitmap 解码记录创建/关闭次数，验证成功路径的资源配对，而不替换图片处理实现。
    const decode = window.createImageBitmap
    let opened = 0
    let closed = 0
    window.createImageBitmap = async (...args) => {
      const image = await decode(...args)
      opened += 1
      const close = image.close.bind(image)
      image.close = () => { closed += 1; close() }
      return image
    }
    try {
      const result = await createDocumentDocx(source, assets)
      assert(result.blob.size > 1000 && result.warnings.some(text => text.includes("WebP")), "WebP 未完成转换")
      assert(opened === 1 && closed === 1, `Bitmap 未释放：${opened}/${closed}`)
    } finally { window.createImageBitmap = decode }
  })
  await check("DOCX 图片编码失败后仍释放 Bitmap，重试可成功", async () => {
    const encode = HTMLCanvasElement.prototype.toBlob
    const decode = window.createImageBitmap
    let closed = false
    window.createImageBitmap = async (...args) => {
      const image = await decode(...args)
      const close = image.close.bind(image)
      image.close = () => { closed = true; close() }
      return image
    }
    // 只在本用例模拟编码失败，核对拒绝与 Bitmap 清理；finally 恢复方法以允许真实重试。
    HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null) }
    try {
      let rejected = false
      try { await createDocumentDocx(source, assets) } catch { rejected = true }
      assert(rejected && closed, "失败路径未拒绝或未释放图片")
    } finally {
      HTMLCanvasElement.prototype.toBlob = encode
      window.createImageBitmap = decode
    }
    assert((await createDocumentDocx(source, assets)).blob.size > 1000, "失败后不能重试")
  })
  canvas.width = 0
  canvas.height = 0

  // 弹窗测试挂 ExportActions 并提供可观察快照函数，便于确认快速双击只捕获一次正文。
  const host = document.createElement("div")
  document.body.append(host)
  const empty = createDocument()
  let snapshots = 0
  // 轻量 Context 只注入导出实际依赖，避免把无关正文编辑行为带入快照次数断言。
  const mount = (snapshot = empty, entries = new Map()) => ReactDOM.render(
    <EditorContext.Provider value={{ editor: { getText: () => "" }, assets: entries, uploading: false, getSnapshot: () => { snapshots += 1; return snapshot } }}>
      <ExportActions />
    </EditorContext.Provider>, host
  )
  // 先等待上一菜单真正关闭，再模拟悬停打开 Word 选项，避免拾取 portal 中不可见的旧菜单项。
  const openWord = async () => {
    const button = [...host.querySelectorAll("button")].find(button => button.textContent.includes("导出文档"))
    button.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }))
    await waitFor(() => ![...document.querySelectorAll('[role="menuitem"]')].some(item => item.getClientRects().length && !item.closest(".ant-dropdown-hidden")), "上次菜单未关闭")
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }))
    const item = await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === "Word 文档（.docx）" && item.getClientRects().length && !item.closest(".ant-dropdown-hidden")), "导出菜单未打开")
    item.click()
    return item
  }
  try {
    await check("DOCX 连续点击只生成一次，取消弹窗不触发下载", async () => {
      // 截获下载点击只统计行为，测试取消确认不会保存文件；结束后恢复原生方法。
      const click = HTMLAnchorElement.prototype.click
      let downloads = 0
      HTMLAnchorElement.prototype.click = function () { downloads += 1 }
      try {
        mount()
        const item = await openWord()
        item.click()
        const modal = await waitFor(() => document.querySelector('[role="dialog"]'), "导出弹窗未出现")
        assert(snapshots === 1, "重复进入导出")
        assert(modal.textContent.includes("下载 .docx"), "下载按钮缺失")
        const cancel = [...modal.querySelectorAll("button")].find(button => button.textContent.replace(/\s/g, "") === "取消")
        cancel.click()
        await waitFor(() => !document.querySelector('[role="dialog"]'), "取消后弹窗未关闭")
        assert(downloads === 0, "取消仍触发下载")
      } finally { HTMLAnchorElement.prototype.click = click }
    })
    ReactDOM.unmountComponentAtNode(host)
    await check("DOCX 切换会话后旧任务不再打开弹窗", async () => {
      // 较长文档让异步生成跨越卸载时机，用新旧会话结果对照确认清理不会锁住下一轮导出。
      const long = createDocument()
      long.content.content = Array.from({ length: 2000 }, () => ({ type: "paragraph", content: [{ type: "text", text: "旧会话内容" }] }))
      mount(long)
      await openWord()
      ReactDOM.unmountComponentAtNode(host)
      await new Promise(resolve => setTimeout(resolve, 300))
      assert(!document.querySelector('[role="dialog"]'), "旧会话仍弹出结果")
      mount()
      await openWord()
      assert(await waitFor(() => document.querySelector('[role="dialog"]'), "新会话不能导出"), "新会话无结果")
    })
    ReactDOM.unmountComponentAtNode(host)
    await check("DOCX 资源失败收口按钮状态，修复资源后可重新生成", async () => {
      mount(source)
      await openWord()
      await waitFor(() => document.querySelector(".ant-message-error"), "缺失资源未提示错误")
      assert(!host.querySelector(".ant-btn-loading"), "失败后 loading 未释放")
      mount(source, assets)
      await openWord()
      const modal = await waitFor(() => document.querySelector('[role="dialog"]'), `修复后无法导出，快照次数 ${snapshots}，页面反馈 ${[...document.querySelectorAll(".ant-message-notice")].map(item => item.textContent).join("；")}`)
      assert(modal.textContent.includes("WebP"), "转换说明缺失")
    })
  // 销毁导出所有者及测试容器，让 pending 转换、打印清理和 portal 不遗留在后续用例。
  } finally {
    ReactDOM.unmountComponentAtNode(host)
    host.remove()
  }
}
