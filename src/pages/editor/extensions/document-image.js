import Image from "@tiptap/extension-image"

// 文档只持久化 assetId 和未缩放的尺寸，显示地址由当前会话或导出器注入。
export const DocumentImage = Image.extend({
  addOptions() {
    return { ...this.parent?.(), getAssetUrl: () => "" }
  },
  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: element => element.getAttribute("data-mewoc-asset-id"),
        renderHTML: attrs => ({ "data-mewoc-asset-id": attrs.assetId })
      },
      alt: { default: "" },
      title: { default: "" },
      width: { default: 360, parseHTML: element => Number(element.getAttribute("width")) || 360 },
      height: { default: 240, parseHTML: element => Number(element.getAttribute("height")) || 240 }
    }
  },
  parseHTML() {
    // 仅恢复当前会话已持有的资源，允许文档内部复制图片，不请求第三方地址。
    return [{
      tag: "img[data-mewoc-asset-id]",
      getAttrs: element => this.options.getAssetUrl(element.getAttribute("data-mewoc-asset-id")) ? {} : false
    }]
  },
  addInputRules() {
    return []
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["img", { ...HTMLAttributes, src: this.options.getAssetUrl(node.attrs.assetId) }]
  },
  addNodeView() {
    return props => createImageView(props, this.options.getAssetUrl)
  }
})

// NodeView 中的按钮只属于编辑界面；静态导出走 renderHTML，不序列化这些操作控件。
function createImageView({ node, editor, getPos }, getAssetUrl) {
  let currentNode = node
  const dom = document.createElement("figure")
  const image = document.createElement("img")
  const handle = document.createElement("button")
  dom.dataset.documentImage = "true"
  dom.contentEditable = "false"
  image.draggable = false
  handle.type = "button"
  handle.dataset.resizeHandle = "true"
  handle.setAttribute("aria-label", "调整图片大小（方向键可调整）")
  const updateImage = nextNode => {
    currentNode = nextNode
    image.src = getAssetUrl(nextNode.attrs.assetId)
    image.alt = nextNode.attrs.alt
    image.title = nextNode.attrs.title
    image.style.width = `${nextNode.attrs.width}px`
    image.style.height = "auto"
    handle.hidden = !editor.isEditable
  }
  const commitSize = width => {
    const pos = getPos()
    if (pos === undefined || !editor.isEditable) return
    const height = Math.round(width * currentNode.attrs.height / currentNode.attrs.width)
    editor.chain().setNodeSelection(pos).updateAttributes("image", { width, height }).run()
  }
  const stopResize = bindImageResize(handle, image, dom, () => currentNode, commitSize, editor)
  updateImage(node)
  dom.append(image, handle)
  return {
    dom,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) return false
      updateImage(nextNode)
      return true
    },
    selectNode: () => dom.setAttribute("data-selected", "true"),
    deselectNode: () => dom.removeAttribute("data-selected"),
    stopEvent: event => handle.contains(event.target),
    ignoreMutation: () => true,
    destroy: stopResize
  }
}

/**
 * 拖动期间只修改 DOM 预览，松开后一次性提交文档属性，使整次调整可一步撤销。
 * 丢失捕获、窗口失焦、正文改变或销毁时恢复原尺寸，并解绑本轮拖动的外部监听。
 */
function bindImageResize(handle, image, dom, getNode, commitSize, editor) {
  let drag = null
  const win = dom.ownerDocument.defaultView
  const cancelResize = () => {
    const pointerId = drag?.pointerId
    drag = null
    image.style.width = `${getNode().attrs.width}px`
    win.removeEventListener("blur", cancelResize)
    editor.off("transaction", handleTransaction)
    if (pointerId !== undefined && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
  }
  const handleTransaction = () => {
    if (drag && editor.state.doc !== drag.doc) cancelResize()
  }
  const handlePointerDown = event => {
    if (!editor.isEditable || event.button !== 0 || drag) return
    event.preventDefault()
    const rect = image.getBoundingClientRect()
    // clientX 是屏幕坐标，offsetWidth 是未缩放尺寸；先换算再写文档。
    drag = { pointerId: event.pointerId, doc: editor.state.doc, x: event.clientX, width: image.offsetWidth, scale: rect.width / image.offsetWidth }
    handle.setPointerCapture(event.pointerId)
    win.addEventListener("blur", cancelResize)
    editor.on("transaction", handleTransaction)
  }
  const handlePointerMove = event => {
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!editor.isEditable || !(event.buttons & 1)) return cancelResize()
    const maxWidth = dom.parentElement.clientWidth
    const width = Math.min(maxWidth, Math.max(40, drag.width + (event.clientX - drag.x) / drag.scale))
    image.style.width = `${Math.round(width)}px`
  }
  const handlePointerUp = event => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const width = image.offsetWidth
    cancelResize()
    if (editor.isEditable) commitSize(width)
  }
  const handlePointerCancel = event => {
    if (drag && event.pointerId === drag.pointerId) cancelResize()
  }
  const handleKeyDown = event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return
    event.preventDefault()
    cancelResize()
    const delta = event.key === "ArrowRight" ? 10 : -10
    commitSize(Math.min(dom.parentElement.clientWidth, Math.max(40, image.offsetWidth + delta)))
  }
  const events = [
    ["pointerdown", handlePointerDown], ["pointermove", handlePointerMove], ["pointerup", handlePointerUp],
    ["pointercancel", handlePointerCancel], ["lostpointercapture", handlePointerCancel], ["keydown", handleKeyDown]
  ]
  events.forEach(([type, listener]) => handle.addEventListener(type, listener))
  return () => {
    cancelResize()
    events.forEach(([type, listener]) => handle.removeEventListener(type, listener))
  }
}
