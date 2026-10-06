/**
 * 文档会话的依赖容器：集中创建 Tiptap、Zustand 状态、资源集合及保存/输入/插入服务。
 * 切换文档由父级改变 key 重建本容器，避免旧正文历史、选区与异步任务进入新文档。
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useEditor } from "@tiptap/react"
import { useStore } from "zustand"
import { message } from "antd"
import { IconAlertTriangle } from "@tabler/icons-react"
import { createExtensions } from "../tools/create-extensions.js"
import { createEditorStore } from "../tools/create-editor-store.js"
import { useDocumentSave } from "../hooks/use-document-save.js"
import { useDocumentImages } from "../hooks/use-document-images.js"
import { useDocumentAttachments } from "../hooks/use-document-attachments.js"
import { useDocumentMedia } from "../hooks/use-document-media.js"
import { useEditorInput, cleanPastedHtml } from "../hooks/use-editor-input.js"
import { createCommentClipboardHandlers } from "../tools/comment-clipboard.js"
import { hasNavigationSliceFeatures, remapNavigationSlice } from "../tools/navigation-clipboard.js"
import { startFormattingMarksSync } from "../tools/formatting-marks-preferences.js"

export const EditorContext = createContext(null)

/**
 * 一个 Provider 对应一次文档会话，record 只作为初始化输入。
 * 页面切换 key 时重建 editor/store，正文撤销历史和运行时资源随会话隔离。
 * assets 保留原始 Blob 与临时 URL，子组件通过 Context 共享同一份资源集合。
 */
export function EditorProvider({ record, children }) {
  // 懒初始化保证当前会话只创建一次状态与资源集合；后续更新通过 store 和 editor 进行。
  const [store] = useState(() => createEditorStore(record))
  const [assets] = useState(() => record.assets)
  // 图片与附件共用同步互斥标记，避免 React 更新前重复进入异步资源插入流程。
  const assetTaskRef = useRef(false)
  // 剪贴板回调晚于创建执行，从 ref 读取当前实例，避免捕获初始或上一次正文的导航 ID。
  const editorRef = useRef(null)
  const readOnly = useStore(store, state => state.readOnly || state.switching)
  const formattingMarks = useStore(store, state => state.formattingMarks)
  // 批注剪贴板命令执行时读取实时可编辑状态，阻止只读、切换或输入法组合期间修改正文。
  const commentClipboard = useMemo(() => createCommentClipboardHandlers(view => {
    const state = store.getState()
    return view.editable && !view.composing && !state.readOnly && !state.switching
  }, { hasLocalCopyFeatures: hasNavigationSliceFeatures, prepareLocalCopy: (slice, view) => remapNavigationSlice(slice, view.state.doc.toJSON()) }), [store])
  // 扩展从会话资源集合按 ID 查询 URL/Blob；文档中保存资源引用，运行时地址由当前会话提供。
  const editor = useEditor({
    extensions: createExtensions(id => assets.get(id)?.url || "", id => assets.get(id)),
    content: record.document.content,
    // 正文事务不驱动整棵 React 树刷新，各工具栏自行订阅需要的选区和格式状态。
    shouldRerenderOnTransaction: false,
    editorProps: {
      ...commentClipboard,
      attributes: { class: "mewoc-content", role: "textbox", "aria-label": "文档正文", "aria-multiline": "true", spellcheck: "false" },
      transformPastedHTML: html => cleanPastedHtml(html, (id, kind) => assets.has(id) && (assets.get(id).kind || "image") === kind, editorRef.current?.getJSON()),
      // 点击正文批注标记时展开对应侧栏，同时关闭占用同一区域的查找面板；事件继续交给编辑器。
      handleClick: (_view, _position, event) => {
        if (event.target instanceof Element && event.target.closest("[data-mewoc-comment-id]")) {
          store.getState().updateView({ commentsOpen: true, searchOpen: false })
        }
        return false
      }
    },
    onUpdate: () => store.getState().updateContent()
  })
  editorRef.current = editor
  // 把保存、图片、附件及快捷输入连到同一个编辑器，所有后代共享一致的快照和资源锁。
  const { getSnapshot, saveDocument, getStorageVersion } = useDocumentSave(editor, record, assets, store)
  const { insertImages, replaceImage, uploading: imageUploading } = useDocumentImages(editor, assets, store, assetTaskRef)
  const { insertAttachment, attachmentUploading } = useDocumentAttachments(editor, assets, store, assetTaskRef)
  const { insertMedia, mediaUploading } = useDocumentMedia(editor, assets, store, assetTaskRef)
  const uploading = imageUploading || attachmentUploading || mediaUploading
  useEditorInput(editor, store, insertImages, saveDocument)

  useEffect(() => {
    // 删除节点时仍需支持撤销，因此会话 URL 统一在会话卸载时释放。
    return () => assets.forEach(asset => { if (asset.url) URL.revokeObjectURL(asset.url) })
  }, [assets])

  // 只读和文档切换都会锁定正文；同时退出格式刷，避免恢复编辑后残留旧格式刷模式。
  useEffect(() => {
    editor?.setEditable(!readOnly, false)
    if (readOnly) editor?.commands.clearFormat()
  }, [editor, readOnly])

  // 仅改变编辑装饰；只读暂时隐藏标记而保留开关，恢复编辑后立即沿用偏好。
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setFormattingMarksVisible(formattingMarks && !readOnly)
  }, [editor, formattingMarks, readOnly])
  useEffect(() => startFormattingMarksSync(store), [store])

  // 链接点击属于视图交互，提示在会话层呈现；schema/扩展本身保持不依赖界面组件。
  useEffect(() => {
    if (!editor) return
    const handleNavigationError = event => message.warning({ content: event.message, icon: <IconAlertTriangle aria-hidden="true" /> })
    editor.on("navigationError", handleNavigationError)
    return () => editor.off("navigationError", handleNavigationError)
  }, [editor])

  const documentId = record.document.id
  // 缓存 Context 服务对象，依赖未变化时避免仅因 Provider 渲染让所有后代重新接收新引用。
  const value = useMemo(() => ({ editor, store, assets, documentId, getSnapshot, saveDocument, getStorageVersion, insertImages, replaceImage, insertAttachment, insertMedia, uploading, imageUploading, attachmentUploading, mediaUploading }),
    [editor, store, assets, documentId, getSnapshot, saveDocument, getStorageVersion, insertImages, replaceImage, insertAttachment, insertMedia, uploading, imageUploading, attachmentUploading, mediaUploading])

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>
}

// 统一获取当前文档服务，并在使用位置缺少 Provider 时立即报错，暴露错误的组件结构。
export function useDocumentEditor() {
  const context = useContext(EditorContext)
  if (!context) throw new Error("编辑器组件必须位于 EditorProvider 内")
  return context
}

// 组件按需订阅会话状态片段，标题、保存状态或视图设置变化只影响依赖它们的界面。
export function useEditorStore(selector) {
  const { store } = useDocumentEditor()
  return useStore(store, selector)
}
