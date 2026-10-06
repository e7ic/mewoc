/** 选中媒体块的原文件下载与删除入口；删除正文节点保留会话资源，撤销可恢复播放器。 */
import { Button } from "antd"
import { IconDownload, IconTrash } from "@tabler/icons-react"
import { NodeSelection } from "@tiptap/pm/state"
import { useEditorState } from "@tiptap/react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { removeMedia } from "../tools/media-commands.js"
import { getMediaFileName } from "../tools/media-assets.js"
import toolbarStyles from "../sass/toolbar.module.scss"
import styles from "../sass/media.module.scss"

export function MediaSettings() {
  const { editor, store, assets } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const assetId = useEditorState({ editor, selector: ({ editor: current }) => {
    const selection = current.state.selection
    return selection instanceof NodeSelection && selection.node.type.name === "media" ? selection.node.attrs.assetId : null
  } })
  const asset = assets.get(assetId)
  const label = asset?.kind === "audio" ? "音频" : asset?.kind === "video" ? "视频" : "媒体"
  const remove = () => {
    const state = store.getState()
    if (!state.readOnly && !state.switching && removeMedia(editor)) editor.commands.focus()
  }

  return <div className={`${toolbarStyles.view} ${styles.settings}`}>
    {asset?.url && <a className={styles.download} href={asset.url} download={getMediaFileName(asset.fileName)}
      aria-label={`下载选中${label}：${asset.fileName}`} onMouseDown={event => event.preventDefault()}>
      <IconDownload aria-hidden="true" /><span>下载原文件</span>
    </a>}
    <Button icon={<IconTrash aria-hidden="true" />} disabled={readOnly}
      onMouseDown={event => event.preventDefault()} onClick={remove}>删除{label}</Button>
    <span>使用正文中的播放控件；删除可撤销</span>
  </div>
}
