/** 本机媒体的选择入口；打开文件框前保存目标书签，取消或卸载时释放其订阅。 */
import { useEffect, useRef, useState } from "react"
import { message } from "antd"
import { IconInfoCircle, IconMovie, IconMusic } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { captureMediaInsertionTarget } from "../tools/media-commands.js"

export function MediaAction({ kind }) {
  const { editor, store, insertMedia, uploading } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const inputRef = useRef(null)
  const targetRef = useRef(null)
  const [reading, setReading] = useState(false)
  const mountedRef = useRef(true)
  const label = kind === "audio" ? "音频" : "视频"
  const Icon = kind === "audio" ? IconMusic : IconMovie

  const canEdit = () => {
    const state = store.getState()
    return !state.readOnly && !state.switching && !editor.isDestroyed && editor.isEditable && !editor.view.composing
  }
  const openFile = () => {
    if (!canEdit() || uploading) return
    targetRef.current?.dispose()
    targetRef.current = captureMediaInsertionTarget(editor, {
      canEdit: () => {
        const state = store.getState()
        return !state.readOnly && !state.switching
      },
      subscribeSession: callback => store.subscribe(callback)
    })
    if (!targetRef.current) {
      message.info({ content: `请将光标放在普通文字段落中插入${label}`, icon: <IconInfoCircle aria-hidden="true" /> })
      return
    }
    inputRef.current.click()
  }
  const handleFile = async event => {
    const file = event.target.files[0]
    event.target.value = ""
    const target = targetRef.current
    targetRef.current = null
    // 文件框返回后不能捕获新目标；原书签已失效时只释放订阅，不改写当前光标位置。
    if (!file || !target || !canEdit() || target.isCancelled()) {
      target?.dispose()
      return
    }
    setReading(true)
    try { await insertMedia(file, kind, target) }
    finally { if (mountedRef.current) setReading(false) }
  }

  useEffect(() => {
    mountedRef.current = true
    const input = inputRef.current
    const cancel = () => {
      targetRef.current?.dispose()
      targetRef.current = null
    }
    input.addEventListener("cancel", cancel)
    return () => {
      mountedRef.current = false
      input.removeEventListener("cancel", cancel)
      cancel()
    }
  }, [])

  return <>
    <button type="button" disabled={readOnly || uploading || reading}
      title={`插入本地${label}，单个不超过 5 MiB`} onMouseDown={event => event.preventDefault()} onClick={openFile}>
      <Icon aria-hidden="true" /><span>{reading ? `读取${label}…` : label}</span>
    </button>
    <input ref={inputRef} type="file" hidden aria-label={`选择${label}`}
      accept={kind === "audio" ? ".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav" : ".mp4,.webm,video/mp4,video/webm"}
      onChange={handleFile} />
  </>
}
