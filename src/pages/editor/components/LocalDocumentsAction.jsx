import { useEffect, useRef, useState } from "react"
import { Button, Empty, List, Modal, message } from "antd"
import { HistoryOutlined } from "@ant-design/icons"
import { getDocuments, getDocumentAssets } from "../tools/local-repository.js"
import { validateDocument } from "../tools/document-schema.js"

export function LocalDocumentsAction({ disabled, onSelect }) {
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(true)

  const handleCancel = () => {
    if (loading) return
    setOpen(false)
    setRecords([])
  }

  const handleSelect = async record => {
    setLoading(true)
    try {
      validateDocument(record.document)
      const assets = await getDocumentAssets(record.document)
      if (!mountedRef.current) return
      await onSelect({ ...record, assets })
      if (mountedRef.current) setOpen(false)
    } catch (error) {
      if (mountedRef.current) message.error(error.message)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  // 每次打开重新读取本浏览器文档；关闭使本轮结果失效，不把迟到列表写入下一次弹窗。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    getDocuments().then(nextRecords => {
      if (!cancelled) setRecords(nextRecords)
    }).catch(error => {
      if (!cancelled) message.error(error.message)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => () => { mountedRef.current = false }, [])

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}><HistoryOutlined />最近</button>
      <Modal
        title="此浏览器中的文档"
        open={open}
        onCancel={handleCancel}
        footer={null}
        destroyOnHidden
      >
        <List
          loading={loading}
          dataSource={records}
          rowKey="id"
          locale={{ emptyText: <Empty description="还没有已保存的本地文档" /> }}
          renderItem={record => (
            <List.Item actions={[<Button key="open" disabled={loading} onClick={() => handleSelect(record)}>打开</Button>]}>
              <List.Item.Meta
                title={record.document.title || "未命名文档"}
                description={new Date(record.document.updatedAt).toLocaleString("zh-CN")}
              />
            </List.Item>
          )}
        />
      </Modal>
    </>
  )
}
