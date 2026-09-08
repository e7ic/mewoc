import { Node } from "@tiptap/core"
import { DOMSerializer } from "@tiptap/pm/model"
import { formatAttachmentSize, getAttachmentFileName, getAttachmentText } from "../tools/attachment-assets.js"

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
    stopEvent: event => Boolean(event.target.closest("[data-attachment-download]")),
    ignoreMutation: mutation => mutation.type !== "selection"
  }
}
