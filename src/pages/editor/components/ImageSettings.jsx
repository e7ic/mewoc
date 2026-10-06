/**
 * 图片尺寸、比例、对齐和说明的草稿弹窗，目标由可映射且可校验原内容的会话对象持有。
 * 弹窗在正文改选区、切只读或图片失效时仍保留草稿，保存失败要求重新确认目标。
 */
import { IconChevronDown, IconChevronUp, IconPhotoEdit } from "@tabler/icons-react"
import { useEffect, useRef, useState } from "react"
import { Button, Checkbox, Form, Input, InputNumber, Modal, Select } from "antd"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import {
  IMAGE_SIZE_MIN, IMAGE_SIZE_MAX, IMAGE_TEXT_MAX, applyImageSettings, captureImageSettingsTarget,
  changeImageDimension, getImageNaturalSize, getImageSettingsError, isImageDimension,
  removeSelectedImage, restoreImageAspectRatio, setImageAspectRatioLock
} from "../tools/image-settings.js"
import toolbarStyles from "../sass/toolbar.module.scss"
import styles from "../sass/image-settings.module.scss"

export function ImageSettings({ active = true }) {
  const { editor, store, replaceImage, uploading, imageUploading } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  // draft 决定弹窗显隐；naturalSize 来自当前图片 DOM 加载结果；targetRef 持有目标映射与订阅。
  const [draft, setDraft] = useState(null)
  const [naturalSize, setNaturalSize] = useState(null)
  const [error, setError] = useState("")
  const targetRef = useRef(null)
  // 选择文件前捕获原图；隐藏文件框一直挂载，正文改选区不会把选择结果改投给另一张图片。
  const replacementTargetRef = useRef(null)
  const replacementInputRef = useRef(null)
  const open = !!draft
  // 事件执行时读取实时只读/切换状态，同时检查编辑器和输入法，避免仅凭按钮状态执行写操作。
  const canEdit = () => {
    const state = store.getState()
    return !state.readOnly && !state.switching && !editor.isDestroyed && editor.isEditable && !editor.view.composing
  }

  // 捕获图片目标后复制原始属性作为草稿；先 dispose 旧目标，防止重复打开留下事务订阅。
  const handleOpen = () => {
    if (!canEdit() || uploading) return
    const target = captureImageSettingsTarget(editor)
    if (!target) return
    targetRef.current?.dispose()
    targetRef.current = target
    setDraft({ ...target.original })
    setNaturalSize(getImageNaturalSize(editor, target.getSelection()))
    setError("")
  }
  // 所有关闭路径释放目标订阅并清空派生尺寸与错误，避免继续观察不再编辑的图片。
  const handleCancel = () => {
    targetRef.current?.dispose()
    targetRef.current = null
    setDraft(null)
    setNaturalSize(null)
    setError("")
  }
  // 先验证草稿尺寸与文字字段，再核对原图片身份和当前可编辑性；成功才关闭并恢复正文焦点。
  const handleSave = () => {
    if (!canEdit() || uploading) return
    const validationError = getImageSettingsError(draft)
    if (validationError) return setError(validationError)
    if (!applyImageSettings(editor, targetRef.current, draft, canEdit)) {
      setError("原图片已被删除或替换，或当前不可编辑；请关闭弹窗后重新选择")
      return
    }
    handleCancel()
    editor.commands.focus()
  }
  // 恢复比例根据映射后的原图自然尺寸计算，保留当前宽度意图，不把页面缩放尺寸当作原图尺寸。
  const handleRestore = () => {
    if (!canEdit() || uploading) return
    const size = getImageNaturalSize(editor, targetRef.current?.getSelection())
    if (size) setDraft(current => restoreImageAspectRatio(current, size))
  }

  const handleReplace = () => {
    if (!canEdit() || uploading) return
    replacementTargetRef.current?.dispose()
    replacementTargetRef.current = captureImageSettingsTarget(editor)
    if (replacementTargetRef.current) replacementInputRef.current.click()
  }
  const handleReplacementFile = event => {
    // 清空 input 允许连续选择同一个文件；无文件/取消只释放目标，正文和资源集合均不改变。
    const file = event.target.files[0]
    event.target.value = ""
    const target = replacementTargetRef.current
    replacementTargetRef.current = null
    if (file && target) replaceImage(file, target)
    else target?.dispose()
  }

  useEffect(() => {
    if (!open || editor.isDestroyed) return
    // 监听当前 NodeView 的加载事件；只读切换不清空草稿，也不申请新的资源地址。
    const refreshNaturalSize = () => {
      const size = getImageNaturalSize(editor, targetRef.current?.getSelection())
      setNaturalSize(current => current?.width === size?.width && current?.height === size?.height ? current : size)
    }
    const dom = editor.view.dom
    dom.addEventListener("load", refreshNaturalSize, true)
    dom.addEventListener("error", refreshNaturalSize, true)
    editor.on("transaction", refreshNaturalSize)
    return () => {
      dom.removeEventListener("load", refreshNaturalSize, true)
      dom.removeEventListener("error", refreshNaturalSize, true)
      editor.off("transaction", refreshNaturalSize)
    }
  }, [editor, open])
  // 会话卸载也释放图片目标订阅，防止文档切换后旧目标继续接收事务。
  useEffect(() => {
    // 原生取消选择不会触发 change；显式监听 cancel 使书签不会一直订阅后续正文事务。
    const input = replacementInputRef.current
    const cancelReplacement = () => {
      replacementTargetRef.current?.dispose()
      replacementTargetRef.current = null
    }
    const inspectReplacementPermission = () => {
      const state = store.getState()
      if (state.readOnly || state.switching || editor.isDestroyed || !editor.isEditable || editor.view.composing) cancelReplacement()
    }
    // 选择器打开期间也订阅实时状态，先切只读再恢复不能让尚未触发 change 的旧目标重新生效。
    const unsubscribe = store.subscribe(inspectReplacementPermission)
    input.addEventListener("cancel", cancelReplacement)
    editor.view.dom.addEventListener("compositionstart", cancelReplacement)
    editor.on("transaction", inspectReplacementPermission)
    editor.on("destroy", cancelReplacement)
    return () => {
      unsubscribe()
      input.removeEventListener("cancel", cancelReplacement)
      editor.view.dom.removeEventListener("compositionstart", cancelReplacement)
      editor.off("transaction", inspectReplacementPermission)
      editor.off("destroy", cancelReplacement)
      cancelReplacement()
      targetRef.current?.dispose()
    }
  }, [editor, store])

  // 草稿更新同样受实时状态保护；文字字段直接写草稿，尺寸更新交给比例约束函数联动。
  const setField = (field, value) => {
    if (canEdit() && !uploading) setDraft(current => ({ ...current, [field]: value }))
  }
  // 宽高变化会按锁定比例调整另一维，集中在工具函数处理，以保持两种输入入口行为一致。
  const setDimension = (dimension, value) => {
    if (canEdit() && !uploading) setDraft(current => changeImageDimension(current, dimension, value))
  }
  const inputDimension = (dimension, raw) => {
    // InputNumber 的 min/max 会抑制越界 onChange，仍记录原始输入供保存前校验。
    const value = raw.trim() ? Number(raw) : null
    setDimension(dimension, Number.isFinite(value) ? Math.round(value) : null)
  }

  // active 仅隐藏节点工具入口，弹窗仍由 draft 保持；这让用户能在目标失效后看到保存错误和草稿。
  return <>
    {active && <div className={toolbarStyles.view}>
      <Button disabled={readOnly || uploading} onMouseDown={event => event.preventDefault()} onClick={handleOpen}>图片设置</Button>
      <Button icon={<IconPhotoEdit aria-hidden="true" />} disabled={readOnly || uploading}
        aria-label="替换图片" title="替换图片，保留尺寸、对齐和说明"
        onMouseDown={event => event.preventDefault()} onClick={handleReplace}>{imageUploading ? "读取图片…" : "替换图片"}</Button>
      <Button disabled={readOnly || uploading} onClick={() => !uploading && removeSelectedImage(editor, canEdit)}>删除图片</Button>
      <span>拖动右下角缩放，方向键也可调整大小</span>
    </div>}
    <input ref={replacementInputRef} type="file" accept="image/png,image/jpeg,image/webp"
      aria-label="选择替换图片" hidden onChange={handleReplacementFile} />
    <Modal className={styles.modal} style={{ top: 24 }} title="图片设置" open={open} onCancel={handleCancel} footer={null} destroyOnHidden>
      {draft && <Form className={styles.form} layout="vertical" onFinish={handleSave}>
        <div className={styles.dimensions}>
          <Form.Item label="宽度（px）">
            <InputNumber controls={{ upIcon: <IconChevronUp aria-hidden="true" />, downIcon: <IconChevronDown aria-hidden="true" /> }} aria-label="图片宽度" min={IMAGE_SIZE_MIN} max={IMAGE_SIZE_MAX} precision={0} changeOnBlur={false}
              value={draft.width} disabled={readOnly || uploading} onChange={value => setDimension("width", value)} onInput={raw => inputDimension("width", raw)} />
          </Form.Item>
          <Form.Item label="高度（px）">
            <InputNumber controls={{ upIcon: <IconChevronUp aria-hidden="true" />, downIcon: <IconChevronDown aria-hidden="true" /> }} aria-label="图片高度" min={IMAGE_SIZE_MIN} max={IMAGE_SIZE_MAX} precision={0} changeOnBlur={false}
              value={draft.height} disabled={readOnly || uploading} onChange={value => setDimension("height", value)} onInput={raw => inputDimension("height", raw)} />
          </Form.Item>
        </div>
        <div className={styles.ratio}>
          <Checkbox aria-label="锁定宽高比例" checked={draft.lockAspectRatio} disabled={readOnly || uploading}
            onChange={event => canEdit() && !uploading && setDraft(current => setImageAspectRatioLock(current, event.target.checked))}>锁定宽高比例</Checkbox>
          <Button disabled={readOnly || uploading || !naturalSize || !isImageDimension(draft.width)} onClick={handleRestore}>恢复原始比例</Button>
        </div>
        <p className={styles.hint}>尺寸按文档原始像素保存，页面缩放不会改变数值。</p>
        <Form.Item label="图片对齐">
          <Select suffixIcon={<IconChevronDown aria-hidden="true" />} aria-label="图片对齐" value={draft.align} disabled={readOnly || uploading} onChange={value => setField("align", value)}
            options={[{ value: "left", label: "左对齐" }, { value: "center", label: "居中" }, { value: "right", label: "右对齐" }]} />
        </Form.Item>
        <Form.Item label="替代文本">
          <Input.TextArea aria-label="替代文本" value={draft.alt} rows={2} maxLength={IMAGE_TEXT_MAX} showCount
            disabled={readOnly || uploading} onChange={event => setField("alt", event.target.value)} />
        </Form.Item>
        <Form.Item label="说明">
          <Input.TextArea aria-label="图片说明" value={draft.title} rows={2} maxLength={IMAGE_TEXT_MAX} showCount
            disabled={readOnly || uploading} onChange={event => setField("title", event.target.value)} />
        </Form.Item>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <Button type="primary" htmlType="submit" disabled={readOnly || uploading}>保存设置</Button>
          <Button onClick={handleCancel}>取消</Button>
        </div>
      </Form>}
    </Modal>
  </>
}
