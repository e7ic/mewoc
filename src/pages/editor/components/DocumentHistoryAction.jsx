/**
 * 历史版本列表支持检查点、只读预览、恢复和另存副本；恢复当前文档时重建正文会话。
 * 预览独立创建编辑器与资源 URL，不挂自动保存；列表/预览请求编号与弹窗会话共同阻止迟到回写。
 */
import { Component, useEffect, useRef, useState } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { Alert, Button, Empty, Input, List, Modal, Pagination, Spin, Tag } from "antd"
import { IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight, IconCircleX, IconHistory, IconLoader2, IconRefresh } from "@tabler/icons-react"
import { getDocumentVersions, getDocumentVersion } from "../tools/document-history-repository.js"
import { validateDocument } from "../tools/document-schema.js"
import { createExtensions } from "../tools/create-extensions.js"
import { createDocumentAssetUrl } from "../tools/attachment-assets.js"
import { getCommentAppendix } from "../tools/comment-export.js"
import { getPreviewPage } from "../tools/page-preview.js"
import { PageWatermark } from "./PageWatermark.jsx"
import { PageFurniture } from "./PageFurniture.jsx"
import styles from "../sass/history.module.scss"
import "../sass/content.scss"

const PAGE_SIZE = 6

// 版本时间只在展示时本地化，异常日期不影响列表和操作目标。
function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN")
}

// 按用户说明和版本来源区分手动检查点与恢复前自动备份，未命名也保留明确的列表标题。
function getVersionLabel(version) {
  return version.label || (version.reason === "before-restore" ? "恢复前自动备份" : "未命名检查点")
}

// 只有预览所有者回收自己的 URL，主会话资源不在这里释放；重复关闭时空预览可安全忽略。
function releasePreview(preview) {
  preview?.assets.forEach(asset => { if (asset.url) URL.revokeObjectURL(asset.url) })
}

/**
 * 预览拥有独立的资源副本，不把 URL 写回仓库返回对象或主编辑会话。
 * 所有资源校验通过后才交付正文；创建中途失败也释放已经分配的 URL。
 */
function createPreview(result, documentId, key) {
  if (!result?.version || result.version.documentId !== documentId) throw new Error("这份历史版本已不可用，请刷新版本列表")
  validateDocument(result.version.document)
  if (result.version.document.id !== documentId || !(result.assets instanceof Map)) throw new Error("历史版本内容或资源无效")
  const preview = { version: result.version, assets: new Map(), key }
  try {
    result.version.document.assets.forEach(metadata => {
      const asset = result.assets.get(metadata.id)
      if (!asset?.blob || asset.blob.size !== metadata.byteLength || asset.blob.type !== metadata.mimeType) {
        throw new Error("历史版本资源「" + metadata.fileName + "」缺失或类型不匹配")
      }
      preview.assets.set(metadata.id, { ...metadata, blob: asset.blob, url: createDocumentAssetUrl({ ...metadata, blob: asset.blob }) })
    })
    return preview
  } catch (error) {
    releasePreview(preview)
    throw error
  }
}

// 独立只读 Tiptap 不创建文档 Store，也不注册自动保存、资源上传或正文更新回调。
function HistoryPreview({ preview }) {
  const editor = useEditor({
    extensions: createExtensions(id => preview.assets.get(id)?.url || "", id => preview.assets.get(id)),
    content: preview.version.document.content,
    editable: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "mewoc-content", role: "textbox", "aria-label": "历史版本正文",
        "aria-readonly": "true", "aria-multiline": "true", spellcheck: "false"
      }
    }
  })
  return <EditorContent editor={editor} />
}

// 扩展视图初始化失败不能打断主编辑器；父级错误处理同时收回这次预览的资源。
class PreviewBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) { this.props.onError(error) }
  render() { return this.state.failed ? null : this.props.children }
}

export function DocumentHistoryAction({ record, currentDocumentId, disabled, onPrepare, onManage, onChanged, initialOpen = false, onClose }) {
  // open/ready/preparing 控制准备边界，versions/page/revision 管列表；正文预览与恢复确认有各自错误和目标。
  const [open, setOpen] = useState(initialOpen)
  const [ready, setReady] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [versions, setVersions] = useState([])
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [label, setLabel] = useState("")
  const [pending, setPending] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState("")
  const [previewError, setPreviewError] = useState("")
  const [previewTarget, setPreviewTarget] = useState(null)
  const [restoreTarget, setRestoreTarget] = useState(null)
  const [restoreError, setRestoreError] = useState("")
  // 会话编号保护开关轮次，readRef 保护列表，previewReadRef 保护单版本读取；previewRef 同步持有待回收资源。
  // busyRef 立即互斥写操作，initialOpenRef/prepareRef 让列表外托管模式仅在挂载时准备一次。
  const mountedRef = useRef(true)
  const openRef = useRef(initialOpen)
  const sessionRef = useRef(initialOpen ? 1 : 0)
  const readRef = useRef(0)
  const previewReadRef = useRef(0)
  const previewRef = useRef(null)
  const busyRef = useRef(false)
  const initialOpenRef = useRef(initialOpen)
  const prepareRef = useRef(null)
  const busy = disabled || preparing || Boolean(pending)
  const title = record.document.title || "未命名文档"
  const current = record.id === currentDocumentId
  // 版本数变化后钳制可见页；预览纸张和批注说明来自历史文档快照，不读取当前编辑正文。
  const visiblePage = Math.max(1, Math.min(page, Math.ceil(versions.length / PAGE_SIZE)))
  const visibleVersions = versions.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE)
  const previewPage = preview ? getPreviewPage(preview.version.document.page) : null
  const previewComments = preview ? getCommentAppendix(preview.version.document) : []
  const isCurrentSession = session => mountedRef.current && openRef.current && sessionRef.current === session

  // 先让正在读的预览请求失效，再同步释放已创建 URL 并清空 UI，迟到结果不能重新出现。
  const clearPreview = () => {
    previewReadRef.current += 1
    releasePreview(previewRef.current)
    previewRef.current = null
    setPreview(null)
    setPreviewTarget(null)
    setPreviewLoading("")
    setPreviewError("")
  }

  // 当前文档仅在打开历史面板前 flush；面板刷新仅读版本，不另行保存正文。
  const prepare = async () => {
    if (busyRef.current) return
    const session = sessionRef.current
    busyRef.current = true
    setPreparing(true)
    setError("")
    try {
      if (onPrepare && await onPrepare(record) === false) throw new Error("当前文档尚未保存，请处理保存提示后重试")
      if (isCurrentSession(session)) setReady(true)
    } catch (failure) {
      if (isCurrentSession(session)) setError(failure.message || "无法准备历史版本，请重试")
    } finally {
      busyRef.current = false
      if (isCurrentSession(session)) setPreparing(false)
    }
  }
  // 列表外托管模式在挂载时打开；ref 保持最新准备回调，不因父级行记录更新而再次 flush。
  prepareRef.current = prepare

  // 建立新的弹窗会话并清列表/说明，父级准备当前文档保存完成后才允许读取历史。
  const handleOpen = () => {
    if (disabled || busyRef.current || openRef.current) return
    sessionRef.current += 1
    openRef.current = true
    setReady(false)
    setVersions([])
    setPage(1)
    setLabel("")
    setNotice("")
    setError("")
    setOpen(true)
    prepare()
  }

  // 实际写操作期间不关闭；普通取消废弃所有列表/预览请求、释放 URL 并通知托管父层结束面板。
  const handleCancel = () => {
    if (busyRef.current || disabled) return
    openRef.current = false
    sessionRef.current += 1
    readRef.current += 1
    clearPreview()
    setRestoreTarget(null)
    setRestoreError("")
    setOpen(false)
    setVersions([])
    onClose?.()
  }

  // 刷新只重读历史列表，不自动保存或重建检查点；失效旧请求并回到第一页。
  const refresh = () => {
    if (busyRef.current) return
    readRef.current += 1
    setNotice("")
    setPage(1)
    setRevision(count => count + 1)
  }

  // 更换预览先释放旧资源，再读取指定版本；结果身份确认后才校验 Blob 和分配 URL，避免迟到资源泄漏。
  const loadPreview = async version => {
    if (busyRef.current) return
    const session = sessionRef.current
    clearPreview()
    const request = ++previewReadRef.current
    setPreviewTarget(version)
    setPreviewLoading(version.id)
    try {
      const result = await getDocumentVersion(record.id, version.id)
      // 先检查请求身份再创建 URL：迟到快照不产生临时资源，也不会覆盖后选版本。
      if (!isCurrentSession(session) || previewReadRef.current !== request) return
      const nextPreview = createPreview(result, record.id, version.id + ":" + request)
      previewRef.current = nextPreview
      setPreview(nextPreview)
    } catch (failure) {
      if (isCurrentSession(session) && previewReadRef.current === request) setPreviewError(failure.message || "读取历史版本失败，请重试")
    } finally {
      if (isCurrentSession(session) && previewReadRef.current === request) setPreviewLoading("")
    }
  }

  // 检查点、复制和恢复共享写锁，操作前校验说明长度；成功与列表刷新错误分开反馈，避免重复写入。
  const manage = async (action, version) => {
    if (busyRef.current || loading) return
    const checkpointLabel = label.trim()
    if (action === "checkpoint" && checkpointLabel.length > 100) {
      setError("版本说明最多 100 个字符")
      return
    }
    const session = sessionRef.current
    busyRef.current = true
    setPending(action + ":" + (version?.id || record.id))
    setError("")
    setRestoreError("")
    setNotice("")
    try {
      if (!onManage || !await onManage(action, record, version?.id, action === "checkpoint" ? checkpointLabel : undefined)) {
        throw new Error("操作未完成，请处理保存提示后重试")
      }
      if (isCurrentSession(session)) {
        setRestoreTarget(null)
        if (action === "checkpoint") setLabel("")
        if (action === "restoreVersion") clearPreview()
        setNotice(action === "checkpoint" ? "检查点已保存" : action === "duplicateVersion" ? "历史版本副本已保存，可在文档库中打开" : "历史版本已恢复")
        setPage(1)
        setRevision(count => count + 1)
        // 写入已经成功，列表刷新失败只能报告显示问题，不能诱导重复执行恢复或复制。
        Promise.resolve().then(() => onChanged?.()).catch(failure => {
          if (isCurrentSession(session)) setError("操作已完成，但文档库刷新失败：" + (failure.message || "请刷新文档库"))
        })
      }
    } catch (failure) {
      if (isCurrentSession(session)) {
        if (action === "restoreVersion") setRestoreError(failure.message || "恢复历史版本失败，请重试")
        else setError(failure.message || "历史版本操作失败，请重试")
      }
    } finally {
      busyRef.current = false
      if (isCurrentSession(session)) setPending("")
    }
  }

  // 列表读取只在打开且准备完成时执行；会话/请求编号及取消标记阻止关闭或刷新后的旧结果回写。
  useEffect(() => {
    if (!open || !ready) return
    const session = sessionRef.current
    const request = ++readRef.current
    let cancelled = false
    setLoading(true)
    setError("")
    getDocumentVersions(record.id).then(nextVersions => {
      if (!cancelled && isCurrentSession(session) && readRef.current === request) setVersions(nextVersions)
    }).catch(failure => {
      if (!cancelled && isCurrentSession(session) && readRef.current === request) setError(failure.message || "读取历史版本失败，请重试")
    }).finally(() => {
      if (!cancelled && isCurrentSession(session) && readRef.current === request) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, ready, record.id, revision])

  // 托管历史面板首次挂载自动准备；卸载使请求失效并释放所有预览 URL，不销毁主会话资源。
  useEffect(() => {
    if (initialOpenRef.current) prepareRef.current()
    return () => {
      mountedRef.current = false
      openRef.current = false
      sessionRef.current += 1
      readRef.current += 1
      previewReadRef.current += 1
      releasePreview(previewRef.current)
      previewRef.current = null
    }
  }, [])

  // 列表、只读正文预览、批注附录和恢复确认分别呈现；预览错误边界仅清理此次资源并显示重试。
  return (
    <>
      {!initialOpen && <Button icon={<IconHistory aria-hidden="true" />} disabled={disabled || busy} onClick={handleOpen}>历史版本</Button>}
      <Modal title="历史版本" open={open} onCancel={handleCancel} footer={null} width={900} destroyOnHidden closable={!busy} maskClosable={!busy} keyboard={!busy}>
        <div className={styles.container}>
          <div className={styles.documentTitle}><span>{title}</span>{current && <Tag color="purple">当前文档</Tag>}</div>
          <p className={styles.hint}>手动保存检查点可保留正文、批注、图片和附件。恢复前会自动备份当前版本。</p>
          {preparing && <div className={styles.loading}><Spin /><span>正在准备历史版本…</span></div>}
          {error && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={error} action={<Button size="small" disabled={busy} onClick={ready ? refresh : prepare}>重试</Button>} />}
          {ready && <>
            <div className={styles.checkpoint}>
              <Input aria-label="版本说明" placeholder="版本说明（可选，最多 100 个字符）" value={label} maxLength={100} showCount disabled={busy || loading} onChange={event => setLabel(event.target.value)} onPressEnter={() => manage("checkpoint")} />
              <Button type="primary" disabled={busy || loading} loading={(pending.startsWith("checkpoint:")) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }} onClick={() => manage("checkpoint")}>保存检查点</Button>
              <Button icon={<IconRefresh aria-hidden="true" />} disabled={busy || loading} onClick={refresh}>刷新</Button>
            </div>
            {notice && <p className={styles.notice} role="status">{notice}</p>}
            <List
              loading={loading}
              dataSource={visibleVersions}
              rowKey="id"
              locale={{ emptyText: loading ? <span className={styles.hint}>正在读取历史版本…</span> : <Empty description="还没有历史版本，保存第一个检查点吧" /> }}
              renderItem={version => (
                <List.Item data-version-id={version.id} className={styles.row}>
                  <div className={styles.details}>
                    <div className={styles.versionTitle} title={getVersionLabel(version)}><span>{getVersionLabel(version)}</span><Tag color={version.reason === "before-restore" ? "orange" : "default"}>{version.reason === "before-restore" ? "自动备份" : "手动检查点"}</Tag></div>
                    <div className={styles.metadata}><span>{formatTime(version.createdAt)}</span></div>
                  </div>
                  <div className={styles.actions}>
                    <Button disabled={busy || loading} loading={(previewLoading === version.id) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }} onClick={() => loadPreview(version)}>预览</Button>
                    <Button disabled={busy || loading} onClick={() => { setRestoreTarget(version); setRestoreError("") }}>恢复此版本</Button>
                    <Button disabled={busy || loading} loading={(pending === "duplicateVersion:" + version.id) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }} onClick={() => manage("duplicateVersion", version)}>另存副本</Button>
                  </div>
                </List.Item>
              )}
            />
            {versions.length > 0 && <div className={styles.pagination} aria-label="历史版本分页"><Pagination prevIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="上一页"><IconChevronLeft aria-hidden="true" /></button>} nextIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="下一页"><IconChevronRight aria-hidden="true" /></button>} jumpPrevIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="向前跳页"><IconChevronsLeft aria-hidden="true" /></button>} jumpNextIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="向后跳页"><IconChevronsRight aria-hidden="true" /></button>} current={visiblePage} pageSize={PAGE_SIZE} total={versions.length} disabled={busy || loading} showSizeChanger={false} showTotal={total => "共 " + total + " 个版本"} onChange={setPage} /></div>}
            {previewTarget && <section className={styles.preview} aria-label="版本预览">
              <div className={styles.previewHeading}><div><strong>版本预览</strong><Tag>只读</Tag><p>{getVersionLabel(previewTarget)} · {formatTime(previewTarget.createdAt)}</p></div><Button disabled={busy} onClick={clearPreview}>关闭预览</Button></div>
              {previewLoading && <div className={styles.loading}><Spin /><span>正在读取版本正文和资源…</span></div>}
              {previewError && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={previewError} action={<Button size="small" disabled={busy} onClick={() => loadPreview(previewTarget)}>重试</Button>} />}
              {preview && <>
                <p className={styles.pageDescription}>{previewPage.description}</p>
                <div className={styles.paperViewport}><div className={styles.paper} style={previewPage.style}>
                <PageWatermark page={preview.version.document.page} />
                <PageFurniture page={preview.version.document.page} />
                <div className={styles.paperContent}>
                <p className={styles.previewDocumentTitle}>{preview.version.document.title || "未命名文档"}</p>
                <PreviewBoundary key={preview.key} onError={failure => {
                  if (previewRef.current !== preview) return
                  releasePreview(previewRef.current)
                  previewRef.current = null
                  setPreview(null)
                  setPreviewError(failure.message || "版本预览失败，请重试")
                }}><HistoryPreview preview={preview} /></PreviewBoundary>
                {previewComments.length > 0 && <section className="mewoc-content mewoc-comment-appendix" aria-label="历史版本批注">
                  <h2>批注说明</h2><ol>{previewComments.map((entry, index) => <li key={index}>
                    <h3>{entry.heading}</h3>{entry.paragraphs.map((text, line) => <p key={line} style={{ whiteSpace: "pre-wrap" }}>{text}</p>)}
                  </li>)}</ol>
                </section>}
                </div></div></div>
              </>}
            </section>}
          </>}
        </div>
      </Modal>
      <Modal title="恢复此版本" open={Boolean(restoreTarget)} onCancel={() => { if (!busyRef.current) { setRestoreTarget(null); setRestoreError("") } }} onOk={() => { if (restoreTarget) manage("restoreVersion", restoreTarget) }} okText="确认恢复" cancelText="取消" confirmLoading={pending.startsWith("restoreVersion:")} okButtonProps={{ loading: (pending.startsWith("restoreVersion:")) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> } }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy} destroyOnHidden>
        <div className={styles.confirmation}>
          <p>将「{title}」恢复到「{restoreTarget ? getVersionLabel(restoreTarget) : ""}」？</p>
          <p>恢复前将自动保留当前版本，正文撤销历史会重新开始。</p>
          <p>你也可以选择「另存副本」，将历史内容保存为独立文档。</p>
          {restoreError && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={restoreError} />}
        </div>
      </Modal>
    </>
  )
}
