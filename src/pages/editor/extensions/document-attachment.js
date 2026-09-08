import { Node } from "@tiptap/core"
import { DOMSerializer } from "@tiptap/pm/model"
import { formatAttachmentSize, getAttachmentFileName, getAttachmentText } from "../tools/attachment-assets.js"

// 卡片是不可拆分的块节点，正文仅保存 assetId，文件名、大小和下载地址从资源表派生。
export const DocumentAttachment = Node.create({
  name: "attachment",
  group: "block",
  atom: true,
  selectable: true,
  marks: "",
  addOptions: () => ({ getAsset: () => null, getAssetUrl: () => "" }),
  addAttributes: () => ({ assetId: { default: null, rendered: false } }),
  parseHTML() {
    return [{
      tag: 'div[data-type="attachment"][data-mewoc-asset-id]',
      getAttrs: element => {
        const assetId = element.getAttribute("data-mewoc-asset-id")
        return this.options.getAsset(assetId)?.kind === "attachment" ? { assetId } : false
      }
    }]
  },
  renderHTML({ node }) {
    return getAttachmentContent(node.attrs.assetId, this.options)
  },
  renderText({ node }) {
    return getAttachmentText(this.options.getAsset(node.attrs.assetId))
  },
  addNodeView() {
    return ({ node }) => createAttachmentView(node, this.options)
  }
})

// 编辑视图和静态输出共用 DOM 描述，文件名作为文本交给序列化器，不拼接进 HTML 字符串。
function getAttachmentContent(assetId, options) {
  const asset = options.getAsset(assetId)
  const attrs = { "data-type": "attachment", "data-mewoc-asset-id": assetId }
  if (asset?.kind !== "attachment") return ["div", attrs, "附件资源缺失"]
  const url = options.getAssetUrl(assetId)
  return ["div", attrs,
    ["span", { "data-attachment-icon": "true", "aria-hidden": "true" }, "附件"],
    ["span", { "data-attachment-info": "true" },
      ["span", { "data-attachment-name": "true" }, asset.fileName],
      ["span", { "data-attachment-size": "true" }, formatAttachmentSize(asset.byteLength)]
    ],
    ...(url ? [["a", {
      "data-attachment-download": "true", href: url, download: getAttachmentFileName(asset.fileName),
      "aria-label": `下载附件：${asset.fileName}`
    }, "下载"]] : [])
  ]
}

function createAttachmentView(node, options) {
  const dom = document.createElement("div")
  dom.contentEditable = "false"
  const updateAttachment = current => {
    const rendered = DOMSerializer.renderSpec(document, getAttachmentContent(current.attrs.assetId, options)).dom
    dom.setAttribute("data-type", "attachment")
    dom.setAttribute("data-mewoc-asset-id", current.attrs.assetId)
    dom.replaceChildren(...rendered.childNodes)
  }
  updateAttachment(node)
  return {
    dom,
    update(current) {
      if (current.type !== node.type) return false
      if (current.attrs.assetId !== dom.getAttribute("data-mewoc-asset-id")) updateAttachment(current)
      return true
    },
    // 下载保持浏览器原生行为，也允许只读文档下载；其余卡片事件仍交给编辑器选中节点。
    stopEvent: event => Boolean(event.target.closest("[data-attachment-download]")),
    ignoreMutation: mutation => mutation.type !== "selection"
  }
}
