/**
 * 验证图片草稿、比例计算、异步弹窗书签以及 NodeView 拖动/键盘调整的一致行为。
 * 只提交用户变化字段，坐标与尺寸按未缩放像素计算；取消、销毁和旧目标失效不得写正文。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { TableKit } from "@tiptap/extension-table"
import { NodeSelection, Plugin } from "@tiptap/pm/state"
import { DocumentImage } from "../src/pages/editor/extensions/document-image.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import {
  applyImageSettings, captureImageSettingsTarget, changeImageDimension, getImageNaturalSize,
  getImageSettingsDraft, getImageSettingsError, removeSelectedImage,
  restoreImageAspectRatio, setImageAspectRatioLock
} from "../src/pages/editor/tools/image-settings.js"

// 安装编辑器需要的浏览器对象和帧调度，让 Node 测试执行真实 schema/事务逻辑；JSDOM 不承担原生版式验收。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

// 用固定会话 URL 区分两张资源，NodeView 身份验证不依赖网络加载或第二次 Blob 读取。
const assetUrls = new Map([["image-a", "blob:image-a"], ["image-b", "blob:image-b"]])
// 每个场景创建独立编辑器并在 finally 销毁，隔离正文、插件和撤销历史；扩展组合只提供该组验证所需能力。
const createEditor = (attrs = {}) => new Editor({
  element: document.createElement("div"), extensions: [StarterKit, DocumentImage.configure({ getAssetUrl: id => assetUrls.get(id) || "" })],
  content: { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "前" }] },
    { type: "image", attrs: { assetId: "image-a", width: 240, height: 120, ...attrs } },
    { type: "paragraph", content: [{ type: "text", text: "后" }] }
  ] }
})
// 每次从最新正文寻找实际图片位置，前方插入或插件修复后不沿用旧偏移。
const imagePosition = editor => {
  let position
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "image" && position === undefined) position = pos })
  return position
}
const imageAttrs = editor => editor.state.doc.nodeAt(imagePosition(editor)).attrs
// 真实选中图片再捕获书签，复现设置弹窗打开时的节点选择及其自动事务监听。
const captureTarget = editor => {
  editor.commands.setNodeSelection(imagePosition(editor))
  return captureImageSettingsTarget(editor)
}
// JSDOM 缺少完整指针实现，手动补 pointerId/按钮/坐标后派发真实 DOM 事件，驱动 NodeView 处理器。
const dispatchPointer = (handle, type, values = {}) => {
  const event = new DOM.window.Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries({ pointerId: 1, button: 0, buttons: 1, clientX: 100, ...values })) {
    Object.defineProperty(event, key, { value })
  }
  handle.dispatchEvent(event)
}
// 分离布局 offsetWidth 与乘缩放的屏幕矩形，并模拟指针捕获，检出拖动把屏幕增量直接存成正文尺寸。
const prepareResize = (editor, scale = 1) => {
  const image = editor.view.dom.querySelector("figure img")
  const handle = editor.view.dom.querySelector("[data-resize-handle]")
  Object.defineProperty(image, "offsetWidth", { configurable: true, get: () => Number.parseFloat(image.style.width) })
  Object.defineProperty(editor.view.dom, "clientWidth", { configurable: true, value: 1000 })
  image.getBoundingClientRect = () => ({ width: image.offsetWidth * scale })
  let captured
  handle.setPointerCapture = id => { captured = id }
  handle.hasPointerCapture = id => captured === id
  handle.releasePointerCapture = () => { captured = undefined }
  return { image, handle }
}

test("图片草稿保留旧小数、省略属性默认值，锁定宽高双向计算且重新锁定当前比例", () => {
  const old = getImageSettingsDraft({ width: 240.5, height: 120.25 })
  assert.equal(old.width, 240.5)
  assert.equal(old.height, 120.25)
  assert.equal(old.align, "left")
  assert.equal(old.lockAspectRatio, true)
  assert.equal(changeImageDimension(old, "width", 360).height, 180)
  assert.equal(changeImageDimension(old, "height", 180).width, 360)
  let free = setImageAspectRatioLock(old, false)
  free = changeImageDimension(free, "height", 100)
  assert.equal(free.width, 240.5)
  const relocked = setImageAspectRatioLock(free, true)
  assert.equal(changeImageDimension(relocked, "height", 200).width, 481)
  assert.equal(changeImageDimension(old, "width", null).height, old.height)
  assert.equal(changeImageDimension(old, "title", 500), old)
})

test("图片尺寸、对齐、比例状态与文本验证拒绝非法值，不把越界比例计算钳制成合法尺寸", () => {
  const draft = getImageSettingsDraft({ width: 240, height: 120 })
  assert.equal(getImageSettingsError(draft), "")
  for (const value of [null, "240", 0, -1, 20001, NaN, Infinity]) {
    assert.ok(getImageSettingsError({ ...draft, width: value }))
    assert.ok(getImageSettingsError({ ...draft, height: value }))
  }
  for (const patch of [{ align: "justify" }, { lockAspectRatio: "false" }, { alt: 1 }, { title: "x".repeat(1001) }]) {
    assert.ok(getImageSettingsError({ ...draft, ...patch }))
  }
  assert.equal(getImageSettingsError({ ...draft, width: 1, height: 20000, alt: "x".repeat(1000), title: "x".repeat(1000) }), "")
  const extreme = getImageSettingsDraft({ width: 20000, height: 1 })
  assert.equal(changeImageDimension(extreme, "width", 1).height, 0)
  assert.ok(getImageSettingsError(changeImageDimension(extreme, "width", 1)))
})

test("恢复原始比例只采用已解码NodeView，保留当前宽度并避免额外资源读取", () => {
  const editor = createEditor({ width: 250, height: 250, lockAspectRatio: false })
  try {
    const selection = NodeSelection.create(editor.state.doc, imagePosition(editor))
    const image = editor.view.dom.querySelector("figure img")
    assert.equal(getImageNaturalSize(editor, selection), null)
    Object.defineProperties(image, {
      complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 240 }, naturalHeight: { configurable: true, value: 120 }
    })
    const draft = getImageSettingsDraft(imageAttrs(editor))
    assert.deepEqual(getImageNaturalSize(editor, selection), { width: 240, height: 120 })
    const restored = restoreImageAspectRatio(draft, getImageNaturalSize(editor, selection))
    assert.equal(restored.width, 250)
    assert.equal(restored.height, 125)
    assert.equal(restored.lockAspectRatio, false)
    assert.equal(restoreImageAspectRatio(draft, null), draft)
    assert.equal(restoreImageAspectRatio(draft, { width: 0, height: 120 }), draft)
    assert.equal(image.getAttribute("src"), "blob:image-a")
  } finally { editor.destroy() }
})

// 打开草稿后先修改当前节点其他字段，提交只允许覆盖用户编辑部分，检出用完整旧草稿覆盖当前 attrs。
test("图片设置保存一次事务且独立撤销，未改字段不覆盖期间更新，小数不被静默取整", () => {
  const editor = createEditor({ width: 240.5, height: 120.25 })
  let target
  try {
    editor.commands.insertContentAt(1, "新增")
    target = captureTarget(editor)
    editor.view.dispatch(editor.state.tr.setNodeAttribute(imagePosition(editor), "title", "期间说明"))
    let updates = 0
    editor.on("update", () => { updates += 1 })
    assert.equal(applyImageSettings(editor, target, { ...target.original, alt: "新替代文本", align: "right" }), true)
    assert.equal(updates, 1)
    assert.equal(imageAttrs(editor).title, "期间说明")
    assert.equal(imageAttrs(editor).width, 240.5)
    assert.equal(imageAttrs(editor).height, 120.25)
    assert.equal(imageAttrs(editor).alt, "新替代文本")
    assert.equal(editor.commands.undo(), true)
    assert.equal(imageAttrs(editor).alt, "")
    assert.equal(imageAttrs(editor).align, "left")
    assert.equal(imageAttrs(editor).title, "期间说明")
    assert.equal(editor.state.doc.firstChild.textContent, "新增前")
  } finally { target?.dispose(); editor.destroy() }
})

test("没有改动的保存与取消释放书签不产生正文事务", () => {
  const editor = createEditor()
  try {
    let updates = 0
    const target = captureTarget(editor)
    editor.on("update", () => { updates += 1 })
    assert.equal(applyImageSettings(editor, target, target.original), true)
    assert.equal(updates, 0)
    target.dispose()
    assert.equal(applyImageSettings(editor, target, { ...target.original, alt: "取消后的旧草稿" }), false)
    assert.equal(updates, 0)
  } finally { editor.destroy() }
})

test("图片书签随前方插入映射，删除后同位置同资源重插也拒绝旧草稿", () => {
  const editor = createEditor()
  let target
  try {
    target = captureTarget(editor)
    editor.commands.insertContentAt(1, "插入文字")
    assert.equal(target.getSelection().from, imagePosition(editor))
    assert.equal(applyImageSettings(editor, target, { ...target.original, title: "映射说明" }), true)
    target.dispose()
    target = captureTarget(editor)
    const position = imagePosition(editor)
    const attrs = { ...imageAttrs(editor) }
    editor.view.dispatch(editor.state.tr.delete(position, position + 1))
    editor.commands.insertContentAt(position, { type: "image", attrs })
    assert.equal(target.getSelection(), null)
    assert.equal(applyImageSettings(editor, target, { ...target.original, alt: "误写" }), false)
    assert.equal(imageAttrs(editor).alt, "")
  } finally { target?.dispose(); editor.destroy() }
})

test("图片前方表格自动修复的追加事务会移动书签，保存仍命中原图片", () => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit.configure({ trailingNode: false }), TableKit,
      DocumentImage.configure({ getAssetUrl: id => assetUrls.get(id) || "" })],
    content: '<table><tr><td><p>a</p></td><td><p>b</p></td></tr><tr><td><p>c</p></td><td><p>d</p></td></tr></table><img data-mewoc-asset-id="image-a" width="240" height="120"><p>后</p>'
  })
  let target
  try {
    target = captureTarget(editor)
    const originalPosition = target.getSelection().from
    let cellPosition
    editor.state.doc.descendants((node, pos) => { if (node.type.name === "tableCell" && cellPosition === undefined) cellPosition = pos })
    let appended = []
    editor.on("transaction", event => { appended = event.appendedTransactions || [] })
    // 主事务只改 colspan，不移动图片；fixTables 补齐短行时才在图片前新增节点。
    editor.view.dispatch(editor.state.tr.setNodeAttribute(cellPosition, "colspan", 2))
    assert.ok(appended.length > 0)
    assert.ok(appended.some(transaction => transaction.docChanged))
    assert.ok(imagePosition(editor) > originalPosition)
    assert.equal(target.getSelection().from, imagePosition(editor))
    assert.equal(applyImageSettings(editor, target, { ...target.original, title: "修复后图片说明" }), true)
    assert.equal(imageAttrs(editor).title, "修复后图片说明")
  } finally { target?.dispose(); editor.destroy() }
})

// 资源 ID 和位置完全相同仍是新节点，必须依赖删除历史使目标失效，不能仅靠最终外形判定。
test("追加事务删除并在原位置重插同资源图片后，旧草稿永久失效", () => {
  const editor = createEditor()
  let target
  try {
    editor.registerPlugin(new Plugin({
      appendTransaction(transactions, _oldState, state) {
        if (!transactions.some(transaction => transaction.getMeta("replace-image-after-transaction"))) return null
        let position
        state.doc.descendants((node, pos) => { if (node.type.name === "image") position = pos })
        const node = state.doc.nodeAt(position)
        return state.tr.replaceWith(position, position + node.nodeSize, state.schema.nodes.image.create(node.attrs))
      }
    }))
    target = captureTarget(editor)
    editor.view.dispatch(editor.state.tr.setMeta("replace-image-after-transaction", true))
    assert.equal(imageAttrs(editor).assetId, target.assetId)
    assert.equal(target.getSelection(), null)
    assert.equal(applyImageSettings(editor, target, { ...target.original, alt: "误写追加替换节点" }), false)
    assert.equal(imageAttrs(editor).alt, "")
  } finally { target?.dispose(); editor.destroy() }
})

test("图片设置核对assetId和当前文档，只读、切换、组合输入、销毁均拒绝写入", () => {
  const editor = createEditor()
  let target
  try {
    target = captureTarget(editor)
    const values = { ...target.original, width: 400, height: 200 }
    editor.setEditable(false, false)
    assert.equal(captureImageSettingsTarget(editor), null)
    assert.equal(applyImageSettings(editor, target, values), false)
    assert.equal(removeSelectedImage(editor), false)
    editor.setEditable(true, false)
    assert.equal(applyImageSettings(editor, target, values, () => false), false)
    const staleSelection = target.getSelection()
    editor.commands.insertContentAt(1, "映射")
    assert.equal(applyImageSettings(editor, { ...target, getSelection: () => staleSelection }, values), false)
    Object.defineProperty(editor.view, "composing", { configurable: true, value: true })
    assert.equal(applyImageSettings(editor, target, values), false)
    assert.equal(removeSelectedImage(editor), false)
    delete editor.view.composing
    editor.view.dispatch(editor.state.tr.setNodeAttribute(imagePosition(editor), "assetId", "image-b"))
    assert.equal(applyImageSettings(editor, target, values), false)
    assert.equal(imageAttrs(editor).width, 240)
    editor.destroy()
    assert.equal(applyImageSettings(editor, target, values), false)
    assert.equal(removeSelectedImage(editor), false)
  } finally { target?.dispose(); if (!editor.isDestroyed) editor.destroy() }
})

test("图片删除限定真实节点选区且一次撤销恢复完整设置", () => {
  const editor = createEditor({ align: "center", lockAspectRatio: false, title: "说明" })
  try {
    assert.equal(removeSelectedImage(editor), false)
    editor.commands.setNodeSelection(imagePosition(editor))
    assert.equal(removeSelectedImage(editor), true)
    assert.equal(imagePosition(editor), undefined)
    editor.commands.undo()
    assert.equal(imageAttrs(editor).align, "center")
    assert.equal(imageAttrs(editor).lockAspectRatio, false)
    assert.equal(imageAttrs(editor).title, "说明")
  } finally { editor.destroy() }
})

test("NodeView与静态HTML使用保存宽高、对齐及锁定，内部粘贴保留属性并拒绝外部资源", () => {
  const editor = createEditor({ width: 310.5, height: 190.5, align: "center", lockAspectRatio: false, alt: "替代", title: "说明" })
  const pasted = createEditor()
  try {
    const figure = editor.view.dom.querySelector("figure")
    const image = figure.querySelector("img")
    assert.equal(figure.dataset.imageAlign, "center")
    assert.equal(image.style.width, "310.5px")
    assert.equal(image.style.height, "auto")
    assert.equal(image.style.aspectRatio, "310.5 / 190.5")
    assert.equal(image.style.objectFit, "fill")
    const html = editor.getHTML()
    assert.match(html, /data-mewoc-image-align="center"/)
    assert.match(html, /data-mewoc-lock-aspect-ratio="false"/)
    assert.match(html, /aspect-ratio: 310.5 \/ 190.5/)
    assert.match(html, /margin-left: auto; margin-right: auto/)
    assert.doesNotMatch(html, /resize-handle/)
    pasted.commands.setContent(cleanPastedHtml(html, id => assetUrls.has(id)))
    assert.deepEqual(imageAttrs(pasted), imageAttrs(editor))
    pasted.commands.setContent('<img data-mewoc-asset-id="unknown" src="https://example.com/p.png">')
    assert.equal(imagePosition(pasted), undefined)
    pasted.commands.setContent('<img src="https://example.com/p.png">')
    assert.equal(imagePosition(pasted), undefined)
  } finally { editor.destroy(); pasted.destroy() }
})

test("图片HTML尺寸越界和非法对齐安全回退，旧HTML省略字段仍默认锁定", () => {
  const editor = createEditor()
  try {
    for (const width of ["Infinity", "-1", "20001", "240px"]) {
      editor.commands.setContent(`<img data-mewoc-asset-id="image-a" width="${width}" height="0" data-mewoc-image-align="justify" data-mewoc-lock-aspect-ratio="no">`)
      assert.equal(imageAttrs(editor).width, 360)
      assert.equal(imageAttrs(editor).height, 240)
      assert.equal(imageAttrs(editor).align, "left")
      assert.equal(imageAttrs(editor).lockAspectRatio, true)
    }
    editor.commands.setContent('<img data-mewoc-asset-id="image-a" width="240.5" height="120.25">')
    assert.equal(imageAttrs(editor).width, 240.5)
    assert.equal(imageAttrs(editor).height, 120.25)
  } finally { editor.destroy() }
})

test("锁定拖动在页面缩放下按原比例一次提交，解锁拖动和方向键保留高度", () => {
  for (const scale of [0.5, 1, 1.5]) {
    for (const lockAspectRatio of [true, false]) {
      const editor = createEditor({ lockAspectRatio })
      try {
        const { image, handle } = prepareResize(editor, scale)
        dispatchPointer(handle, "pointerdown")
        dispatchPointer(handle, "pointermove", { clientX: 130 })
        const width = Math.round(240 + 30 / scale)
        assert.equal(image.style.width, `${width}px`)
        if (!lockAspectRatio) assert.equal(image.style.aspectRatio, `${width} / 120`)
        assert.equal(imageAttrs(editor).width, 240)
        dispatchPointer(handle, "pointerup", { buttons: 0 })
        assert.equal(imageAttrs(editor).width, width)
        assert.equal(imageAttrs(editor).height, lockAspectRatio ? Math.round(width / 2) : 120)
        editor.commands.undo()
        assert.equal(imageAttrs(editor).width, 240)
        handle.dispatchEvent(new DOM.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
        assert.equal(imageAttrs(editor).width, 250)
        assert.equal(imageAttrs(editor).height, lockAspectRatio ? 125 : 120)
      } finally { editor.destroy() }
    }
  }
})

// 拖动预览修改 DOM 而未修改正文，取消需同时恢复所有临时样式，避免残留视觉与持久设置不一致。
test("图片拖动取消恢复width/height/aspectRatio/objectFit，失焦、按钮释放、只读、正文改变和组合输入不提交", () => {
  for (const reason of ["blur", "buttons", "readonly", "document", "composition", "pointercancel", "lostpointercapture"]) {
    const editor = createEditor({ lockAspectRatio: false })
    try {
      const { image, handle } = prepareResize(editor)
      const beforeStyle = image.style.cssText
      dispatchPointer(handle, "pointerdown")
      dispatchPointer(handle, "pointermove", { clientX: 140 })
      assert.equal(image.style.aspectRatio, "280 / 120")
      if (reason === "blur") window.dispatchEvent(new DOM.window.Event("blur"))
      if (reason === "buttons") dispatchPointer(handle, "pointermove", { buttons: 0 })
      if (reason === "readonly") editor.setEditable(false, false)
      if (reason === "document") editor.commands.insertContentAt(1, "变化")
      if (reason === "composition") editor.view.dom.dispatchEvent(new DOM.window.CompositionEvent("compositionstart", { bubbles: true }))
      if (["pointercancel", "lostpointercapture"].includes(reason)) dispatchPointer(handle, reason)
      dispatchPointer(handle, "pointerup", { buttons: 0 })
      assert.equal(imageAttrs(editor).width, 240, reason)
      assert.equal(imageAttrs(editor).height, 120, reason)
      assert.equal(image.style.cssText, beforeStyle, reason)
    } finally { editor.destroy() }
  }
})

test("右键、其他指针和零缩放无法提交，节点销毁撤销预览并清理外部监听", () => {
  const editor = createEditor()
  const { image, handle } = prepareResize(editor)
  dispatchPointer(handle, "pointerdown", { button: 2 })
  dispatchPointer(handle, "pointermove", { clientX: 160 })
  dispatchPointer(handle, "pointerup")
  assert.equal(imageAttrs(editor).width, 240)
  dispatchPointer(handle, "pointerdown")
  dispatchPointer(handle, "pointermove", { pointerId: 2, clientX: 160 })
  dispatchPointer(handle, "pointerup", { pointerId: 2 })
  assert.equal(image.style.width, "240px")
  dispatchPointer(handle, "pointercancel")
  image.getBoundingClientRect = () => ({ width: 0 })
  dispatchPointer(handle, "pointerdown")
  dispatchPointer(handle, "pointermove", { clientX: 160 })
  dispatchPointer(handle, "pointerup")
  assert.equal(imageAttrs(editor).width, 240)
  image.getBoundingClientRect = () => ({ width: image.offsetWidth })
  dispatchPointer(handle, "pointerdown")
  dispatchPointer(handle, "pointermove", { clientX: 160 })
  assert.equal(image.style.width, "300px")
  editor.destroy()
  assert.equal(image.style.width, "240px")
  window.dispatchEvent(new DOM.window.Event("blur"))
  dispatchPointer(handle, "pointermove", { clientX: 180 })
  assert.equal(image.style.width, "240px")
})
