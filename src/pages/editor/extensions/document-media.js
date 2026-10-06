/**
 * 本地音频、视频是不可拆分的正文块，正文只保存资源 ID，播放器从当前会话解析原始文件。
 * 原生控件在编辑和只读状态下均可使用；节点销毁时停止播放，但不回收仍由会话持有的 URL。
 */
import { Node } from "@tiptap/core"
import { DOMSerializer } from "@tiptap/pm/model"
import { formatAttachmentSize } from "../tools/attachment-assets.js"
import { getMediaFileName, getMediaText } from "../tools/media-assets.js"

export const DocumentMedia = Node.create({
  name: "media",
  group: "block",
  atom: true,
  selectable: true,
  marks: "",
  addOptions: () => ({ getAsset: () => null, getAssetUrl: () => "" }),
  addAttributes: () => ({ assetId: { default: null, rendered: false } }),
  parseHTML() {
    // 只接纳当前已验证资源的引用；外部 audio/video 标签及远程 URL 不能创建本地媒体节点。
    return [{
      tag: 'div[data-type="media"][data-mewoc-asset-id]',
      getAttrs: element => {
        const assetId = element.getAttribute("data-mewoc-asset-id")
        return isMediaAsset(this.options.getAsset(assetId)) ? { assetId } : false
      }
    }]
  },
  renderHTML({ node }) {
    return getMediaContent(node.attrs.assetId, this.options)
  },
  renderText({ node }) {
    return getMediaText(this.options.getAsset(node.attrs.assetId))
  },
  addNodeView() {
    return ({ node }) => createMediaView(node, this.options)
  }
})

function isMediaAsset(asset) {
  return asset?.kind === "audio" || asset?.kind === "video"
}

// 文件名交给 DOMSerializer 当作文本输出，不把用户名称拼接成 HTML；静态 HTML 保留原生播放和下载。
function getMediaContent(assetId, options) {
  const asset = options.getAsset(assetId)
  const attrs = { "data-type": "media", "data-mewoc-asset-id": assetId }
  if (!isMediaAsset(asset)) return ["div", attrs, "媒体资源缺失"]
  const label = asset.kind === "audio" ? "音频" : "视频"
  const url = options.getAssetUrl(assetId)
  return ["div", { ...attrs, "data-media-kind": asset.kind },
    ["div", { "data-media-info": "true" },
      ["span", { "data-media-kind-label": "true" }, label],
      ["span", { "data-media-name": "true" }, asset.fileName],
      ["span", { "data-media-size": "true" }, formatAttachmentSize(asset.byteLength)]
    ],
    ...(url ? [[asset.kind, {
      "data-media-player": "true", controls: "", preload: "metadata", src: url,
      ...(asset.kind === "video" ? { playsinline: "" } : {}),
      "aria-label": `播放${label}：${asset.fileName}`
    }, `当前浏览器不支持${label}播放，请下载原文件。`]] : []),
    ["p", { "data-media-error": "true", hidden: "", role: "status" }, `当前浏览器无法播放此${label}，请下载原文件后打开。`],
    ["div", { "data-media-actions": "true" },
      ["span", { "data-media-hint": "true" }, url ? "无法播放时，可下载原文件打开。" : "媒体地址不可用，请重新打开文档。"],
      ...(url ? [["a", {
        "data-media-download": "true", href: url, download: getMediaFileName(asset.fileName),
        "aria-label": `下载${label}：${asset.fileName}`
      }, "下载原文件"]] : [])
    ],
    ["p", { "data-media-print": "true" }, "纸面不支持播放，请在编辑器或导出的 HTML 中播放、下载原文件。"]
  ]
}

function createMediaView(node, options) {
  const dom = document.createElement("div")
  dom.contentEditable = "false"
  let assetId = node.attrs.assetId
  let player = null
  let cleanupListeners = () => {}
  const stopPlayback = () => {
    cleanupListeners()
    cleanupListeners = () => {}
    if (!player) return
    // pause 停止声音，移除 src 并 load 释放解码/网络任务；URL 本身仍须支持其它节点和撤销。
    try { player.pause() } catch { /* 浏览器销毁过程可能已经释放底层播放器。 */ }
    player.removeAttribute("src")
    try { player.load() } catch { /* 离开文档时无需重新报告播放器销毁异常。 */ }
    player = null
  }
  const render = current => {
    stopPlayback()
    const rendered = DOMSerializer.renderSpec(document, getMediaContent(current.attrs.assetId, options)).dom
    for (const attribute of [...dom.attributes]) {
      if (attribute.name.startsWith("data-")) dom.removeAttribute(attribute.name)
    }
    for (const attribute of [...rendered.attributes]) dom.setAttribute(attribute.name, attribute.value)
    dom.replaceChildren(...rendered.childNodes)
    player = dom.querySelector("[data-media-player]")
    const error = dom.querySelector("[data-media-error]")
    if (!player || !error) return
    const showError = () => { error.hidden = false }
    const clearError = () => { error.hidden = true }
    player.addEventListener("error", showError)
    player.addEventListener("canplay", clearError)
    cleanupListeners = () => {
      player?.removeEventListener("error", showError)
      player?.removeEventListener("canplay", clearError)
    }
  }
  render(node)
  return {
    dom,
    update(current) {
      if (current.type !== node.type) return false
      // 正文打字、选区变化不会重建或暂停播放器；只有资源引用变更才重新加载。
      if (current.attrs.assetId !== assetId) {
        assetId = current.attrs.assetId
        render(current)
      }
      return true
    },
    stopEvent: event => Boolean(event.target?.closest?.("[data-media-player], [data-media-download]")),
    ignoreMutation: mutation => mutation.type !== "selection",
    destroy: stopPlayback
  }
}
