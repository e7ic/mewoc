/**
 * 组合图片、附件、表格、公式、链接及结构节点的插入入口，并按正文选区展示节点设置。
 * 资源读取由会话服务负责，界面只选择文件和展示忙碌状态。
 */
import { useRef } from "react"
import { useEditorState } from "@tiptap/react"
import { IconPhoto, IconSeparatorHorizontal, IconPageBreak, IconCode, IconInfoCircle } from "@tabler/icons-react"
import { message } from "antd"
import { LinkAction } from "./LinkAction.jsx"
import { FormulaAction } from "./FormulaAction.jsx"
import { ImageSettings } from "./ImageSettings.jsx"
import { CodeBlockControls } from "./CodeBlockControls.jsx"
import { AttachmentAction } from "./AttachmentAction.jsx"
import { AttachmentSettings } from "./AttachmentSettings.jsx"
import { MediaAction } from "./MediaAction.jsx"
import { MediaSettings } from "./MediaSettings.jsx"
import { QuickInsertControls } from "./QuickInsertControls.jsx"
import { TableInsertAction } from "./TableInsertAction.jsx"
import { BlockContainerInsertActions, BlockContainerSettings } from "./BlockContainerControls.jsx"
import { NavigationInsertActions, TableOfContentsControls } from "./NavigationControls.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { getCodeBlockTarget, insertCodeBlock } from "../tools/code-block-commands.js"
import styles from "../sass/toolbar.module.scss"

export function InsertToolbar({ active = true, layoutKey = "", compact = false }) {
  // 隐藏文件框由图片按钮触发；会话上传状态同时限制图片和附件入口，避免并发资源写入。
  const fileInputRef = useRef(null)
  const { editor, insertImages, uploading, imageUploading } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  // 按当前正文选区展示对应节点工具，不另存“当前图片/表格”以免编辑后目标过期。
  const selection = useEditorState({ editor, selector: ({ editor: current }) => ({
    table: current.isActive("table"), image: current.isActive("image"), code: Boolean(getCodeBlockTarget(current.state.selection)),
    attachment: current.isActive("attachment"), media: current.isActive("media"), container: current.isActive("textBox") || current.isActive("details"), toc: current.isActive("tableOfContents")
  }) })

  // 复制 FileList 后立即清空文件框，使同一图片再次选择仍触发 change；无文件时不启动插入。
  const handleImages = event => {
    const files = [...event.target.files]
    event.target.value = ""
    if (files.length) insertImages(files)
  }
  // 代码块转换只接受适合的单段文字；不支持的选区给出说明，并保留现有正文结构。
  const handleCode = () => {
    if (insertCodeBlock(editor)) editor.commands.focus()
    else message.info({ content: "请在不含公式或图片的单个文字段落中插入代码块", icon: <IconInfoCircle aria-hidden="true" /> })
  }

  // 插入按钮保护正文选区；图片设置组件保持挂载，使改选区或节点失效时仍能展示原草稿与错误。
  return (
    <>
      <div className={styles.insert}>
        <button type="button" disabled={readOnly || uploading} onClick={() => fileInputRef.current.click()}>
          <IconPhoto aria-hidden="true" /><span>{imageUploading ? "读取图片…" : "图片"}</span>
        </button>
        <AttachmentAction />
        <MediaAction kind="audio" />
        <MediaAction kind="video" />
        <TableInsertAction active={active} layoutKey={layoutKey} />
        <button type="button" disabled={readOnly} onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          <IconSeparatorHorizontal aria-hidden="true" /><span>水平线</span>
        </button>
        <button type="button" disabled={readOnly} onClick={() => editor.chain().focus().insertContent({ type: "pageBreak" }).run()}>
          <IconPageBreak aria-hidden="true" /><span>分页符</span>
        </button>
        <LinkAction variant="insert" />
        <FormulaAction />
        <BlockContainerInsertActions active={active} layoutKey={layoutKey} />
        <NavigationInsertActions active={active} />
        <button type="button" disabled={readOnly || selection.code} title="将当前文字段落转换为代码块"
          onMouseDown={event => event.preventDefault()} onClick={handleCode}>
          <IconCode aria-hidden="true" /><span>代码块</span>
        </button>
        <QuickInsertControls active={active} layoutKey={layoutKey} compact={compact} />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="选择图片"
          multiple
          hidden
          onChange={handleImages}
        />
      </div>
      {/* 设置弹窗拥有映射后的目标与草稿，正文改选区或删除节点时不能将其一并卸载。 */}
      <ImageSettings active={selection.image} />
      {selection.code && <CodeBlockControls active={active} layoutKey={layoutKey} />}
      {selection.attachment && <AttachmentSettings />}
      {selection.media && <MediaSettings />}
      {/* 容器设置保持挂载，弹窗保存打开时的原容器和草稿，而不是跟随正文改选区重新初始化。 */}
      <BlockContainerSettings active={active} />
      <TableOfContentsControls active={active} />
      {!selection.table && !selection.image && !selection.code && !selection.attachment && !selection.media && !selection.container && !selection.toc && <p className={styles.description}>资源单个不超过 5 MiB，合计不超过 20 MiB。<br />音频支持 MP3、WAV；视频支持 MP4、WebM。</p>}
    </>
  )
}
