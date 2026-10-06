/**
 * 本地附件的选择入口：保留正文选区后打开隐藏文件框，并把读取与插入交给会话附件服务。
 * 界面共用图片/附件上传状态以限制并发操作，资源大小、类型与失败回滚由服务层处理。
 */
import { useRef } from "react"
import { IconPaperclip } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"

export function AttachmentAction() {
  // 文件框 ref 只用于触发原生选择器；用户取消选择时不会启动异步资源任务。
  const fileInputRef = useRef(null)
  const { insertAttachment, uploading, attachmentUploading } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)

  // 这里只转交单个 File，不先创建临时 URL，避免按钮组件变成第二个资源所有者。
  const handleAttachment = event => {
    const file = event.target.files[0]
    // 插入失败或删除后允许重新选择同一个文件，清空控件才能再次收到 change。
    event.target.value = ""
    if (file) insertAttachment(file)
  }

  // 按钮在只读、切换或任何资源任务进行时禁用；按下保留正文焦点以维护插入位置。
  return (
    <>
      <button type="button" disabled={readOnly || uploading} title="插入本地附件，单个不超过 5 MiB"
        onMouseDown={event => event.preventDefault()} onClick={() => fileInputRef.current.click()}>
        <IconPaperclip aria-hidden="true" /><span>{attachmentUploading ? "读取附件…" : "附件"}</span>
      </button>
      <input ref={fileInputRef} type="file" aria-label="选择附件" hidden onChange={handleAttachment} />
    </>
  )
}
