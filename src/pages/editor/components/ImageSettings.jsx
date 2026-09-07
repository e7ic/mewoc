import { useState } from "react"
import { Button, Form, Input, Modal, message } from "antd"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { useSelectionBookmark } from "../hooks/use-selection-bookmark.js"
import styles from "../sass/toolbar.module.scss"

export function ImageSettings() {
  const [record, setRecord] = useState(null)
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const [form] = Form.useForm()
  const { captureSelection, getSelection, clearSelection } = useSelectionBookmark(editor, !!record)

  const handleOpen = () => {
    const image = editor.getAttributes("image")
    captureSelection()
    setRecord(image)
    form.setFieldsValue({ alt: image.alt })
  }
  const handleCancel = () => {
    setRecord(null)
    clearSelection()
    form.resetFields()
  }
  const saveImage = ({ alt }) => {
    if (!editor.isEditable) return
    const selection = getSelection()
    const image = selection && editor.state.doc.nodeAt(selection.from)
    if (!image || image.type.name !== "image" || image.attrs.assetId !== record.assetId) {
      message.warning("原图片已被删除，请关闭弹窗后重新选择")
      return
    }
    editor.chain().setNodeSelection(selection.from).updateAttributes("image", { alt: alt || "" }).run()
    handleCancel()
  }

  return (
    <div className={styles.view}>
      <Button disabled={readOnly} onClick={handleOpen}>图片说明</Button>
      <Button disabled={readOnly} onClick={() => editor.chain().focus().deleteSelection().run()}>删除图片</Button>
      <span>拖动右下角缩放，方向键也可调整大小</span>
      <Modal
        title="图片说明"
        open={!!record}
        onCancel={handleCancel}
        footer={null}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={saveImage}>
          <Form.Item
            label="替代文本"
            name="alt"
            rules={[{ max: 1000, message: "图片说明最多 1000 个字符" }]}
          >
            <Input.TextArea rows={3} />
          </Form.Item>
          <Button type="primary" htmlType="submit" disabled={readOnly}>保存说明</Button>
        </Form>
      </Modal>
    </div>
  )
}
