import { useRef } from "react"
import { PaperClipOutlined } from "@ant-design/icons"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"

export function AttachmentAction() {
  const fileInputRef = useRef(null)
  const { insertAttachment, uploading, attachmentUploading } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)

  const handleAttachment = event => {
    const file = event.target.files[0]
    event.target.value = ""
    if (file) insertAttachment(file)
  }

  return (
    <>
      <button type="button" disabled={readOnly || uploading} title="插入本地附件，单个不超过 5 MiB"
        onMouseDown={event => event.preventDefault()} onClick={() => fileInputRef.current.click()}>
        <PaperClipOutlined /><span>{attachmentUploading ? "读取附件…" : "附件"}</span>
      </button>
      <input ref={fileInputRef} type="file" aria-label="选择附件" hidden onChange={handleAttachment} />
    </>
  )
}
