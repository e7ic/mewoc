import { useState } from "react"
import { Button, Form, Input, Modal, message } from "antd"
import { LinkOutlined } from "@ant-design/icons"
import { ToolbarButton } from "./ToolbarButton.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { isSafeLink } from "../tools/document-schema.js"
import { useSelectionBookmark } from "../hooks/use-selection-bookmark.js"

export function LinkAction() {
  const [open, setOpen] = useState(false)
  const { editor } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const [form] = Form.useForm()
  const { captureSelection, getSelection, clearSelection } = useSelectionBookmark(editor, open)

  const handleOpen = () => {
    captureSelection()
    form.setFieldsValue({ href: editor.getAttributes("link").href || "" })
    setOpen(true)
  }
  const handleCancel = () => {
    setOpen(false)
    clearSelection()
    form.resetFields()
  }
  const saveLink = values => {
    if (!editor.isEditable) return
    const selection = getSelection()
    if (!selection) {
      message.warning("原选区已被删除，请关闭弹窗后重新选择")
      return
    }
    const chain = editor.chain().focus().setTextSelection({ from: selection.from, to: selection.to }).extendMarkRange("link")
    if (values.href) chain.setLink({ href: values.href }).run()
    else chain.unsetLink().run()
    handleCancel()
  }

  return (
    <>
      <ToolbarButton
        label="编辑链接"
        disabled={readOnly}
        onClick={handleOpen}
      ><LinkOutlined /></ToolbarButton>
      <Modal
        title="编辑链接"
        open={open}
        onCancel={handleCancel}
        footer={null}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={saveLink}>
          <Form.Item
            label="链接地址"
            name="href"
            rules={[{ validator: validateLink }]}
          >
            <Input placeholder="https://example.com" autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" disabled={readOnly}>应用链接</Button>
          <Button type="link" onClick={() => saveLink({ href: "" })} disabled={readOnly}>移除链接</Button>
        </Form>
      </Modal>
    </>
  )
}

function validateLink(_, value) {
  if (!value || isSafeLink(value)) return Promise.resolve()
  return Promise.reject(new Error("请输入完整的 https://、http://、mailto: 或 tel: 地址"))
}
