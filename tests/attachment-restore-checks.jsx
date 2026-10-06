/**
 * 附件恢复的浏览器验收：从真实 IndexedDB 记录重新创建完整 Provider，并检查下载节点与只读往返。
 * 验证持久化引用能恢复成实际界面，同时确认视图状态变化不会改写正文资源结构。
 */
import { useEffect } from "react"
import ReactDOM from "react-dom"
import { EditorContent } from "@tiptap/react"
import { EditorProvider, useDocumentEditor } from "../src/pages/editor/components/EditorProvider.jsx"
import { getDocuments, getDocumentAssets } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentAssetUrl } from "../src/pages/editor/tools/attachment-assets.js"

// 将业务断言失败转成主验收器可记录的异常，保留具体失败说明。
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// 复用上游已保存的文档，额外挂载独立会话验证恢复链；不依赖原编辑器残留的内存节点。
export async function checkAttachmentRestoration(left, check) {
  await check("从 IndexedDB 重建完整编辑会话，切换只读保留附件正文与下载卡片", async () => {
    const saved = (await getDocuments()).find(record => record.id === left.getSnapshot().id)
    // 从仓库取得 Blob 后创建会话 URL，资源所有权随新 Provider 卸载回收。
    const assets = await getDocumentAssets(saved.document)
    assets.forEach(asset => { asset.url = createDocumentAssetUrl(asset) })
    const container = document.body.appendChild(document.createElement("div"))
    let ready
    // Probe 返回就绪 Context 后才访问命令接口，避免异步 useEditor 初始化造成的假失败。
    const mounted = new Promise(resolve => { ready = resolve })
    ReactDOM.render(<EditorProvider record={{ ...saved, assets }}><AttachmentProbe onReady={ready} /></EditorProvider>, container)
    // 等待真实 DOM 更新后逐步切换只读/编辑，并同时比较正文序列化和附件下载卡片。
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
    // 无论断言结果都卸载 Provider 触发 URL 清理，再移除测试 DOM，避免残留保存与视图订阅。
    } finally {
      ReactDOM.unmountComponentAtNode(container)
      container.remove()
    }
  })
}

// 轻量探针把就绪 editor/context 交给用例，同时挂正文 NodeView，让下载卡片接受真实渲染验证。
const AttachmentProbe = ({ onReady }) => {
  const context = useDocumentEditor()
  useEffect(() => { if (context.editor) onReady(context) }, [context, onReady])
  return <EditorContent editor={context.editor} />
}

// 等待两帧使 store 状态、React effect 与编辑器 DOM 完成同步，再读取可见节点和 isEditable。
function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}
