/**
 * 图片文档节点与编辑视图：持久化资源引用、未缩放尺寸、对齐和比例锁定状态。
 * 显示地址由会话注入；拖动仅预览 DOM，确认尺寸时才产生可撤销的正文事务。
 */
import Image from "@tiptap/extension-image"
import { closeHistory } from "@tiptap/pm/history"
import { IMAGE_ALIGNMENTS, isImageDimension } from "../tools/image-settings.js"

// 外部属性必须通过尺寸范围检查，否则使用节点默认值，不把异常尺寸写入文档。
const parseDimension = (element, field, fallback) => {
  const value = Number(element.getAttribute(field))
  return isImageDimension(value) ? value : fallback
}
// 宽度可被容器 max-width 压缩，aspect-ratio 仍表达文档中的目标比例，显示高度由浏览器计算。
const imageStyle = attrs => `width: ${attrs.width}px; height: auto; aspect-ratio: ${attrs.width} / ${attrs.height}; object-fit: fill`

// 文档只持久化 assetId 和未缩放的尺寸，显示地址由当前会话或导出器注入。
export const DocumentImage = Image.extend({
  addOptions() {
    return { ...this.parent?.(), getAssetUrl: () => "" }
  },
  addAttributes() {
    // 不继承外部 src：文件往返与内部复制以 assetId 为准，替代文字和排版属性随节点保存。
    return {
      assetId: {
        default: null,
        parseHTML: element => element.getAttribute("data-mewoc-asset-id"),
        renderHTML: attrs => ({ "data-mewoc-asset-id": attrs.assetId })
      },
      alt: { default: "" },
      title: { default: "" },
      width: { default: 360, parseHTML: element => parseDimension(element, "width", 360) },
      height: { default: 240, parseHTML: element => parseDimension(element, "height", 240) },
      align: {
        default: "left",
        parseHTML: element => {
          const align = element.getAttribute("data-mewoc-image-align")
          return IMAGE_ALIGNMENTS.includes(align) ? align : "left"
        },
        renderHTML: attrs => ({ "data-mewoc-image-align": attrs.align })
      },
      lockAspectRatio: {
        default: true,
        parseHTML: element => element.getAttribute("data-mewoc-lock-aspect-ratio") !== "false",
        renderHTML: attrs => ({ "data-mewoc-lock-aspect-ratio": String(attrs.lockAspectRatio) })
      }
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
    // 关闭父扩展的 Markdown 图片快捷输入，资源必须先经过本地读取与容量校验。
    return []
  },
  renderHTML({ node, HTMLAttributes }) {
    // 静态输出直接生成 img，使用逻辑尺寸和水平 margin，与编辑视图 figure 的对齐保持一致。
    const margins = node.attrs.align === "center" ? "auto; margin-right: auto" : node.attrs.align === "right" ? "auto; margin-right: 0" : "0; margin-right: auto"
    return ["img", {
      ...HTMLAttributes, src: this.options.getAssetUrl(node.attrs.assetId),
      style: `${imageStyle(node.attrs)}; display: block; max-width: 100%; margin-left: ${margins}`
    }]
  },
  addNodeView() {
    return props => createImageView(props, this.options.getAssetUrl)
  }
})

// NodeView 中的按钮只属于编辑界面；静态导出走 renderHTML，不序列化这些操作控件。
function createImageView({ node, editor, getPos, view }, getAssetUrl) {
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
    // 保持同一组 DOM 节点，只更新文档属性；无关事务不重新请求相同图片地址。
    currentNode = nextNode
    const url = getAssetUrl(nextNode.attrs.assetId)
    if (image.getAttribute("src") !== url) image.src = url
    image.alt = nextNode.attrs.alt
    image.title = nextNode.attrs.title
    image.style.cssText = imageStyle(nextNode.attrs)
    dom.dataset.imageAlign = nextNode.attrs.align
    handle.hidden = !editor.isEditable
  }
  const commitSize = width => {
    // getPos 可能随正文变化而失效，提交前核对类型和资源 ID，避免调整相邻的新节点。
    if (editor.isDestroyed || !editor.isEditable || editor.view.composing || !isImageDimension(width)) return
    const pos = getPos()
    const live = typeof pos === "number" ? editor.state.doc.nodeAt(pos) : null
    if (!live || live.type !== currentNode.type || live.attrs.assetId !== currentNode.attrs.assetId) return
    // 解锁时仅改宽度，锁定时按文档原比例计算高度；未变化的尺寸不产生事务。
    const height = currentNode.attrs.lockAspectRatio === false ? currentNode.attrs.height
      : Math.round(width * currentNode.attrs.height / currentNode.attrs.width)
    if (!isImageDimension(height) || (width === live.attrs.width && height === live.attrs.height)) return
    // 前后关闭历史分组，让一次拖动或键盘调整与邻近文字输入各自撤销。
    editor.view.dispatch(closeHistory(editor.state.tr).setNodeMarkup(pos, undefined, { ...live.attrs, width, height }))
    editor.view.dispatch(closeHistory(editor.state.tr))
  }
  const stopResize = bindImageResize(handle, image, dom, () => currentNode, commitSize, editor, view)
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
function bindImageResize(handle, image, dom, getNode, commitSize, editor, view) {
  let drag = null
  const win = dom.ownerDocument.defaultView
  const canResize = () => !editor.isDestroyed && editor.isEditable && !view.composing
  const restorePreview = () => { image.style.cssText = imageStyle(getNode().attrs) }
  const cancelResize = () => {
    // 先清空 drag 再释放 pointer capture，避免释放时触发的取消事件重复处理旧拖动。
    const pointerId = drag?.pointerId
    drag = null
    restorePreview()
    win.removeEventListener("blur", cancelResize)
    editor.off("transaction", handleTransaction)
    if (pointerId !== undefined && handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
  }
  const handleTransaction = () => {
    // 拖动基于开始时的文档引用，正文改变后不能继续沿用旧位置或旧比例。
    if (drag && (!canResize() || editor.state.doc !== drag.doc)) cancelResize()
  }
  const handlePointerDown = event => {
    if (!canResize() || event.button !== 0 || drag) return
    const rect = image.getBoundingClientRect()
    const scale = rect.width / image.offsetWidth
    if (!(image.offsetWidth > 0) || !Number.isFinite(scale) || scale <= 0) return
    event.preventDefault()
    // clientX 是屏幕坐标，offsetWidth 是未缩放尺寸；先换算再写文档。
    drag = { pointerId: event.pointerId, doc: editor.state.doc, x: event.clientX, width: image.offsetWidth,
      ratio: getNode().attrs.width / getNode().attrs.height, scale }
    handle.setPointerCapture(event.pointerId)
    win.addEventListener("blur", cancelResize)
    editor.on("transaction", handleTransaction)
  }
  const handlePointerMove = event => {
    // 仅响应本轮指针；范围按父容器限制，缩放差值转换成文档尺寸后用于预览。
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!canResize() || !(event.buttons & 1)) return cancelResize()
    const maxWidth = dom.parentElement.clientWidth
    if (!(maxWidth > 0)) return cancelResize()
    const width = Math.min(maxWidth, Math.max(40, drag.width + (event.clientX - drag.x) / drag.scale))
    const previewWidth = Math.round(width)
    const previewHeight = getNode().attrs.lockAspectRatio === false ? getNode().attrs.height : previewWidth / drag.ratio
    image.style.width = `${previewWidth}px`
    image.style.aspectRatio = `${previewWidth} / ${previewHeight}`
  }
  const handlePointerUp = event => {
    // 先读取预览宽度，再还原 DOM 与监听；确认后的节点更新重新驱动视图。
    if (!drag || event.pointerId !== drag.pointerId) return
    const width = image.offsetWidth
    cancelResize()
    if (canResize()) commitSize(width)
  }
  const handlePointerCancel = event => {
    if (drag && event.pointerId === drag.pointerId) cancelResize()
  }
  const handleKeyDown = event => {
    // 键盘左右键提供同一提交路径，每次按键调整 10px，并受可编辑状态与容器宽度限制。
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return
    if (!canResize()) return cancelResize()
    event.preventDefault()
    cancelResize()
    const delta = event.key === "ArrowRight" ? 10 : -10
    const maxWidth = dom.parentElement.clientWidth
    if (maxWidth > 0) commitSize(Math.min(maxWidth, Math.max(40, image.offsetWidth + delta)))
  }
  const events = [
    // 手柄拥有本地监听；窗口失焦与正文事务监听只在正在拖动时注册。
    ["pointerdown", handlePointerDown], ["pointermove", handlePointerMove], ["pointerup", handlePointerUp],
    ["pointercancel", handlePointerCancel], ["lostpointercapture", handlePointerCancel], ["keydown", handleKeyDown]
  ]
  events.forEach(([type, listener]) => handle.addEventListener(type, listener))
  view.dom.addEventListener("compositionstart", cancelResize)
  return () => {
    // NodeView 销毁必须取消拖动并移除全部监听，防止旧图片继续响应后续输入。
    cancelResize()
    view.dom.removeEventListener("compositionstart", cancelResize)
    events.forEach(([type, listener]) => handle.removeEventListener(type, listener))
  }
}
