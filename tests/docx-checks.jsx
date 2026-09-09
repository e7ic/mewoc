import ReactDOM from "react-dom"
import { EditorContext } from "../src/pages/editor/components/EditorProvider.jsx"
import { ExportActions } from "../src/pages/editor/components/ExportActions.jsx"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createDocumentDocx } from "../src/pages/editor/tools/docx-file.js"

function assert(value, message) {
  if (!value) throw new Error(message)
}

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
  const check = async (name, action) => {
    try { await action(); report({ name, passed: true }) }
    catch (error) { report({ name, passed: false, error: error.message }) }
  }
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

  const host = document.createElement("div")
  document.body.append(host)
  const empty = createDocument()
  let snapshots = 0
  const mount = (snapshot = empty, entries = new Map()) => ReactDOM.render(
    <EditorContext.Provider value={{ editor: { getText: () => "" }, assets: entries, uploading: false, getSnapshot: () => { snapshots += 1; return snapshot } }}>
      <ExportActions />
    </EditorContext.Provider>, host
  )
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
  } finally {
    ReactDOM.unmountComponentAtNode(host)
    host.remove()
  }
}
