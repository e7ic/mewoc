import { useEffect } from "react"
import ReactDOM from "react-dom"
import { EditorContent } from "@tiptap/react"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { getDocuments, getDocumentAssets } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentAssetUrl } from "../src/pages/editor/tools/attachment-assets.js"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function checkAttachmentRestoration(left, check) {
  await check("从 IndexedDB 重建完整编辑会话，切换只读保留附件正文与下载卡片", async () => {
    const saved = (await getDocuments()).find(record => record.id === left.getSnapshot().id)
    const assets = await getDocumentAssets(saved.document)
    assets.forEach(asset => { asset.url = createDocumentAssetUrl(asset) })
    const container = document.body.appendChild(document.createElement("div"))
    let ready
    const mounted = new Promise(resolve => { ready = resolve })
    ReactDOM.render(<EditorProvider record={{ ...saved, assets }}><AttachmentProbe onReady={ready} /></EditorProvider>, container)
    try {
      const context = await mounted
      await nextFrame()
      const before = JSON.stringify(context.getSnapshot().content)
      assert(context.getSnapshot().assets.length === 1, "重挂载丢失附件引用")
      assert(container.querySelector("[data-attachment-download]"), "重挂载丢失下载卡片")
      context.store.getState().updateView({ readOnly: true })
      await nextFrame()
      assert(!context.editor.isEditable, "只读没有应用")
      assert(JSON.stringify(context.getSnapshot().content) === before, "切换只读改变正文")
      assert(container.querySelector("[data-attachment-download]"), "切换只读丢失下载卡片")
      context.store.getState().updateView({ readOnly: false })
      await nextFrame()
      assert(JSON.stringify(context.getSnapshot().content) === before, "返回编辑改变正文")
      assert(container.querySelector("[data-attachment-download]"), "返回编辑丢失下载卡片")
    } finally {
      ReactDOM.unmountComponentAtNode(container)
      container.remove()
    }
  })
}

const AttachmentProbe = ({ onReady }) => {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onReady(context) }, [context, onReady])
  return <EditorContent editor={context.editor} />
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}
