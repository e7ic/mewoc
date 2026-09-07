import { useState } from "react"
import { Button, Form, InputNumber, Modal, Radio } from "antd"
import { FileTextOutlined } from "@ant-design/icons"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { validatePage } from "../tools/document-schema.js"
import styles from "../sass/toolbar.module.scss"

export function LayoutToolbar() {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState("")
  const { store } = useDocumentEditor()
  const page = useEditorStore(state => state.page)
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const [form] = Form.useForm()

  const handleOpen = () => {
    form.setFieldsValue(page)
    setError("")
    setOpen(true)
  }
  const handleCancel = () => {
    setOpen(false)
    setError("")
    form.resetFields()
  }
  const savePage = values => {
    if (readOnly) return
    const nextPage = { ...values, size: "A4" }
    try {
      validatePage(nextPage)
      store.getState().updatePage(nextPage)
      handleCancel()
    } catch (failure) {
      setError(failure.message)
    }
  }

  return (
    <div className={styles.view}>
      <FileTextOutlined />
      <strong>A4 · {page.orientation === "portrait" ? "纵向" : "横向"}</strong>
      <span>边距 {page.marginsMm.top} / {page.marginsMm.right} / {page.marginsMm.bottom} / {page.marginsMm.left} mm</span>
      <Button disabled={readOnly} onClick={handleOpen}>纸张设置</Button>
      <span>应用后影响当前文档与打印，编辑区域连续显示。</span>
      <Modal
        title="纸张设置"
        open={open}
        onCancel={handleCancel}
        footer={null}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={savePage}>
          <Form.Item label="方向" name="orientation">
            <Radio.Group options={[{ label: "纵向", value: "portrait" }, { label: "横向", value: "landscape" }]} />
          </Form.Item>
          {[["top", "上"], ["right", "右"], ["bottom", "下"], ["left", "左"]].map(([key, label]) => (
            <Form.Item
              key={key}
              label={`${label}边距（mm）`}
              name={["marginsMm", key]}
              rules={[{ required: true, message: "请输入边距" }]}
            >
              <InputNumber min={0} max={250} />
            </Form.Item>
          ))}
          {error && <p role="alert">{error}</p>}
          <Button type="primary" htmlType="submit" disabled={readOnly}>应用</Button>
        </Form>
      </Modal>
    </div>
  )
}
