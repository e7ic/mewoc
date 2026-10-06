/**
 * 模板库管理内置和自定义模板，先只读预览实际版本，再从该版本新建独立文档。
 * 保存、重命名、删除与列表读取分别反馈；预览拥有独立编辑器和资源，任何失败都不改变当前正文。
 */
import { Component, useEffect, useMemo, useRef, useState } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { Alert, Button, Empty, Input, List, Modal, Pagination, Spin, Tabs, Tag } from "antd"
import { IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight, IconCircleX, IconFileText, IconLoader2, IconRefresh, IconSearch } from "@tabler/icons-react"
import { deleteDocumentTemplate, getDocumentTemplate, getDocumentTemplates, renameDocumentTemplate } from "../tools/document-template-repository.js"
import { getBuiltinDocumentTemplates } from "../tools/document-templates.js"
import { validateDocument } from "../tools/document-schema.js"
import { createExtensions } from "../tools/create-extensions.js"
import { createDocumentAssetUrl } from "../tools/attachment-assets.js"
import { getPreviewPage } from "../tools/page-preview.js"
import { PageWatermark } from "./PageWatermark.jsx"
import styles from "../sass/templates.module.scss"
import "../sass/content.scss"

const PAGE_SIZE = 6

// 自定义模板更新时间按本机中文展示，异常时间使用未知说明，展示不会阻止模板管理。
function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN")
}

// 集中释放本弹窗创建的预览 URL，切模板、关闭与异常边界都走同一个资源回收入口。
function releasePreview(preview) {
  preview?.assets.forEach(asset => { if (asset.url) URL.revokeObjectURL(asset.url) })
}

/**
 * 预览只接受列表对应的那一版快照，外部重命名或修改后需要刷新再选择。
 * 资源 URL 由此弹窗独立拥有；任何校验失败都收回已分配 URL，主会话不受影响。
 */
function createPreview(result, target, key) {
  if (!result?.template || result.template.id !== target.id || result.template.storageVersion !== target.storageVersion || result.template.builtin !== target.builtin) {
    throw new Error("这份模板已变更或不可用，请刷新模板列表")
  }
  validateDocument(result.template.document)
  if (result.template.document.id !== target.id || !(result.assets instanceof Map)) throw new Error("模板内容或资源无效，请刷新后重试")
  const preview = { template: result.template, assets: new Map(), key }
  try {
    result.template.document.assets.forEach(metadata => {
      const asset = result.assets.get(metadata.id)
      if (!asset?.blob || asset.blob.size !== metadata.byteLength || asset.blob.type !== metadata.mimeType) {
        throw new Error("模板资源「" + metadata.fileName + "」缺失或类型不匹配")
      }
      preview.assets.set(metadata.id, { ...metadata, blob: asset.blob, url: createDocumentAssetUrl({ ...metadata, blob: asset.blob }) })
    })
    return preview
  } catch (error) {
    releasePreview(preview)
    throw error
  }
}

// 独立只读编辑器不挂载 Provider，因此没有自动保存、上传或正文更新副作用。
function TemplatePreview({ preview }) {
  const editor = useEditor({
    extensions: createExtensions(id => preview.assets.get(id)?.url || "", id => preview.assets.get(id)),
    content: preview.template.document.content,
    editable: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "mewoc-content", role: "textbox", "aria-label": "模板预览正文",
        "aria-readonly": "true", "aria-multiline": "true", spellcheck: "false"
      }
    }
  })
  return <EditorContent editor={editor} />
}

// 模板扩展/节点视图初始化失败由局部边界拦截，通知父层释放预览，避免影响可继续编辑的主会话。
class PreviewBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) { this.props.onError(error) }
  render() { return this.state.failed ? null : this.props.children }
}

export function DocumentTemplatesAction({ disabled, onPrepare, onSave, onCreate }) {
  // ready/preparing 控制当前文档保存前置步骤；templates/tab/query/page/revision 管理库列表视图。
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [templates, setTemplates] = useState([])
  const [tab, setTab] = useState("builtin")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  // 预览和保存/重命名/删除确认分别保存目标与错误；name 是确认草稿，不先改列表记录。
  const [preview, setPreview] = useState(null)
  const [previewTarget, setPreviewTarget] = useState(null)
  const [previewLoading, setPreviewLoading] = useState("")
  const [previewError, setPreviewError] = useState("")
  const [saveOpen, setSaveOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [name, setName] = useState("")
  const [actionError, setActionError] = useState("")
  // 会话号保护弹窗开关，读取号区分列表和预览；previewRef 同步拥有 URL，busyRef 立即锁定管理动作。
  const mountedRef = useRef(true)
  const openRef = useRef(false)
  const sessionRef = useRef(0)
  const readRef = useRef(0)
  const previewReadRef = useRef(0)
  const previewRef = useRef(null)
  const busyRef = useRef(false)
  const busy = disabled || preparing || Boolean(pending)
  // 内置/自定义分类及名称说明搜索只处理已读元信息；筛选变化不触发仓库写入。
  const filteredTemplates = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return templates.filter(template => template.builtin === (tab === "builtin") && (template.name + " " + (template.description || "")).toLocaleLowerCase().includes(needle))
  }, [templates, tab, query])
  // 筛选与管理可能减少总数，钳制显示页码保证剩余模板可见；预览纸张来自所选模板快照。
  const visiblePage = Math.max(1, Math.min(page, Math.ceil(filteredTemplates.length / PAGE_SIZE)))
  const visibleTemplates = filteredTemplates.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE)
  const previewPage = preview ? getPreviewPage(preview.template.document.page) : null
  const isCurrentSession = session => mountedRef.current && openRef.current && sessionRef.current === session

  // 先提高预览请求编号再释放 URL，随后清空目标与进度；异步旧预览不能覆盖后来选择。
  const clearPreview = () => {
    previewReadRef.current += 1
    releasePreview(previewRef.current)
    previewRef.current = null
    setPreview(null)
    setPreviewTarget(null)
    setPreviewLoading("")
    setPreviewError("")
  }

  // 模板列表可操作前请求父级保存当前正文，准备失败给出重试；会话仍存活时才进入就绪状态。
  const prepare = async () => {
    if (busyRef.current) return
    const session = sessionRef.current
    busyRef.current = true
    setPreparing(true)
    setError("")
    try {
      if (onPrepare && await onPrepare() === false) throw new Error("当前文档尚未保存，请处理保存提示后重试")
      if (isCurrentSession(session)) setReady(true)
    } catch (failure) {
      if (isCurrentSession(session)) setError(failure.message || "无法准备模板，请重试")
    } finally {
      busyRef.current = false
      if (isCurrentSession(session)) setPreparing(false)
    }
  }

  // 建立新会话、初始化内置列表和筛选，然后准备仓库；内置内容可独立于自定义库错误展示。
  const handleOpen = () => {
    if (disabled || busyRef.current || openRef.current) return
    sessionRef.current += 1
    openRef.current = true
    setOpen(true)
    setReady(false)
    setTemplates(getBuiltinDocumentTemplates())
    setTab("builtin")
    setQuery("")
    setPage(1)
    setNotice("")
    setActionError("")
    prepare()
  }

  // 父级在保存和新建时会短暂 disabled；成功回调仍可收口同一个弹窗会话。
  // 成功收口与普通取消复用完整清理：让读取失效、释放预览并收起所有嵌套确认弹窗。
  const closePanel = () => {
    openRef.current = false
    sessionRef.current += 1
    readRef.current += 1
    clearPreview()
    setOpen(false)
    setTemplates([])
    setSaveOpen(false)
    setRenameTarget(null)
    setDeleteTarget(null)
    setPending("")
    setActionError("")
  }

  // 用户关闭只在没有管理任务且父级未切换时允许，防止保存/新建中途取消同一会话。
  const handleCancel = () => {
    if (!busyRef.current && !disabled) closePanel()
  }

  // 刷新废弃旧列表请求和预览，回到第一页后重读仓库，避免继续使用无法校验的旧模板版本。
  const refresh = () => {
    if (busyRef.current || disabled) return
    readRef.current += 1
    clearPreview()
    setPage(1)
    setNotice("")
    setRevision(count => count + 1)
  }

  // 按所选模板 ID 读取并核对列表版本，创建 URL 前检查请求身份，防止快速连选导致旧内容回写。
  const loadPreview = async target => {
    if (busyRef.current || disabled || loading) return
    const session = sessionRef.current
    clearPreview()
    const request = ++previewReadRef.current
    setPreviewTarget(target)
    setPreviewLoading(target.id)
    try {
      const result = await getDocumentTemplate(target.id)
      // 迟到的读取在分配 URL 之前丢弃，不能覆盖后来选择或重新打开的弹窗。
      if (!isCurrentSession(session) || previewReadRef.current !== request) return
      const nextPreview = createPreview(result, target, target.id + ":" + request)
      previewRef.current = nextPreview
      setPreview(nextPreview)
    } catch (failure) {
      if (isCurrentSession(session) && previewReadRef.current === request) setPreviewError(failure.message || "读取模板失败，请重试")
    } finally {
      if (isCurrentSession(session) && previewReadRef.current === request) setPreviewLoading("")
    }
  }

  // 新建只能使用已经成功预览的版本；同步加锁后交父级完成保存和原子实例化，失败保留预览。
  const createFromPreview = async () => {
    if (busyRef.current || disabled || loading || !preview || previewLoading || previewError) return
    const session = sessionRef.current
    busyRef.current = true
    setPending("create:" + preview.template.id)
    setError("")
    try {
      // 传递实际预览的版本，父级仓库事务再次检查模板版本后才创建独立文档。
      const { document: _document, ...metadata } = preview.template
      if (!onCreate || await onCreate(metadata) !== true) throw new Error("文档尚未新建，请处理保存提示后重试")
      if (isCurrentSession(session)) closePanel()
    } catch (failure) {
      if (isCurrentSession(session)) setError(failure.message || "从模板新建失败，请重试")
    } finally {
      busyRef.current = false
      if (isCurrentSession(session)) setPending("")
    }
  }

  // 名称动作先校验草稿；保存当前文档交父级，重命名/删除携带目标版本写仓库，成功仅刷新列表。
  const manage = async (action, target) => {
    if (busyRef.current || disabled || loading) return
    const nextName = name.trim()
    if (action !== "delete" && (!nextName || nextName.length > 100)) {
      setActionError("请输入 1 到 100 个字符的模板名称")
      return
    }
    const session = sessionRef.current
    busyRef.current = true
    setPending(action + ":" + (target?.id || "current"))
    setError("")
    setActionError("")
    setNotice("")
    try {
      if (action === "save") {
        if (!onSave || !await onSave(nextName)) throw new Error("模板尚未保存，请处理保存提示后重试")
      } else if (action === "rename") await renameDocumentTemplate(target.id, nextName, target.storageVersion)
      else await deleteDocumentTemplate(target.id, target.storageVersion)
      if (isCurrentSession(session)) {
        if (action !== "save" && previewTarget?.id === target.id) clearPreview()
        setSaveOpen(false)
        setRenameTarget(null)
        setDeleteTarget(null)
        setTab("custom")
        setQuery("")
        setPage(1)
        setNotice(action === "save" ? "模板已保存，可在「我的模板」中预览和使用" : action === "rename" ? "模板已重命名" : "模板已删除，已新建的文档不受影响")
        // 写入成功只刷新列表；刷新失败不能让用户误以为需要重复保存或删除。
        setRevision(count => count + 1)
      }
    } catch (failure) {
      if (isCurrentSession(session)) setActionError(failure.message || "模板操作失败，请重试")
    } finally {
      busyRef.current = false
      if (isCurrentSession(session)) setPending("")
    }
  }

  // 准备完成才读自定义模板；取消/会话/请求编号共同过滤迟到结果，库不可用时回退到内置元信息。
  useEffect(() => {
    if (!open || !ready) return
    const session = sessionRef.current
    const request = ++readRef.current
    let cancelled = false
    setLoading(true)
    setError("")
    getDocumentTemplates().then(nextTemplates => {
      if (!cancelled && isCurrentSession(session) && readRef.current === request) setTemplates(nextTemplates)
    }).catch(failure => {
      if (!cancelled && isCurrentSession(session) && readRef.current === request) {
        // 自定义仓库损坏或不可访问时，内置正文仍可在本地独立预览。
        // 回落仅保留内置元信息，避免继续展示无法验证的自定义列表。
        setTemplates(getBuiltinDocumentTemplates())
        setError("我的模板读取失败：" + (failure.message || "请重试") + "。内置模板仍可预览。")
      }
    }).finally(() => {
      if (!cancelled && isCurrentSession(session) && readRef.current === request) setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, ready, revision])

  // 卸载使全部请求失效并回收预览 URL，旧模板任务不再更新新文档会话的界面。
  useEffect(() => () => {
    mountedRef.current = false
    openRef.current = false
    sessionRef.current += 1
    readRef.current += 1
    previewReadRef.current += 1
    releasePreview(previewRef.current)
    previewRef.current = null
  }, [])

  // 库列表、只读预览和三类确认层稳定共存；内置模板不提供重命名/删除，新建必须先有有效预览。
  return (
    <>
      <button type="button" disabled={disabled || busy} onClick={handleOpen}><IconFileText aria-hidden="true" />模板</button>
      <Modal title="文档模板" open={open} onCancel={handleCancel} footer={null} width={900} destroyOnHidden closable={!busy} maskClosable={!busy} keyboard={!busy}>
        <div className={styles.container}>
          <p className={styles.hint}>从模板新建一份独立文档，也可以把当前文档的正文、图片、附件和页面设置保存为模板。</p>
          {preparing && <div className={styles.loading}><Spin /><span>正在准备文档模板…</span></div>}
          {error && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={error} action={<Button size="small" disabled={busy || loading} onClick={ready ? refresh : prepare}>重试</Button>} />}
          {ready && <>
            <div className={styles.toolbar}>
              <Input aria-label="模板搜索" prefix={<IconSearch aria-hidden="true" />} allowClear={{ clearIcon: <IconCircleX aria-hidden="true" /> }} placeholder="搜索模板名称或说明" value={query} disabled={busy || loading} onChange={event => { setQuery(event.target.value); setPage(1) }} />
              <Button disabled={busy || loading} onClick={() => { setName(""); setActionError(""); setSaveOpen(true) }}>将当前文档保存为模板</Button>
              <Button icon={<IconRefresh aria-hidden="true" />} disabled={busy || loading} onClick={refresh}>刷新</Button>
            </div>
            <Tabs activeKey={tab} onChange={nextTab => { if (!busyRef.current) { setTab(nextTab); setPage(1); clearPreview() } }} items={[
              { key: "builtin", label: "内置模板", disabled: busy || loading },
              { key: "custom", label: "我的模板", disabled: busy || loading }
            ]} />
            {notice && <p className={styles.notice} role="status">{notice}</p>}
            <List
              loading={loading}
              dataSource={visibleTemplates}
              rowKey="id"
              locale={{ emptyText: loading ? <span className={styles.hint}>正在读取模板…</span> : <Empty description={query.trim() ? "没有匹配的模板" : tab === "custom" ? "还没有自定义模板，保存第一份模板吧" : "没有可用的内置模板"} /> }}
              renderItem={template => (
                <List.Item data-template-id={template.id} className={styles.row}>
                  <div className={styles.details}>
                    <div className={styles.templateTitle}><span>{template.name}</span><Tag color={template.builtin ? "purple" : "default"}>{template.builtin ? "内置" : "自定义"}</Tag></div>
                    {template.description && <p className={styles.description}>{template.description}</p>}
                    {!template.builtin && <p className={styles.metadata}>更新于 {formatTime(template.updatedAt)}</p>}
                  </div>
                  <div className={styles.actions}>
                    <Button disabled={busy || loading} loading={(previewLoading === template.id) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }} onClick={() => loadPreview(template)}>预览</Button>
                    {!template.builtin && <>
                      <Button disabled={busy || loading} onClick={() => { setRenameTarget(template); setName(template.name); setActionError("") }}>重命名</Button>
                      <Button danger disabled={busy || loading} onClick={() => { setDeleteTarget(template); setActionError("") }}>删除</Button>
                    </>}
                  </div>
                </List.Item>
              )}
            />
            {filteredTemplates.length > 0 && <div className={styles.pagination} aria-label="模板分页"><Pagination prevIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="上一页"><IconChevronLeft aria-hidden="true" /></button>} nextIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="下一页"><IconChevronRight aria-hidden="true" /></button>} jumpPrevIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="向前跳页"><IconChevronsLeft aria-hidden="true" /></button>} jumpNextIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="向后跳页"><IconChevronsRight aria-hidden="true" /></button>} current={visiblePage} pageSize={PAGE_SIZE} total={filteredTemplates.length} disabled={busy || loading} showSizeChanger={false} showTotal={total => "共 " + total + " 个模板"} onChange={setPage} /></div>}
            {previewTarget && <section className={styles.preview} aria-label="模板预览">
              <div className={styles.previewHeading}>
                <div className={styles.previewTitle}><strong>{previewTarget.name}</strong><Tag>只读预览</Tag></div>
                <div className={styles.actions}>
                  <Button type="primary" disabled={busy || loading || !preview || Boolean(previewLoading) || Boolean(previewError)} loading={(pending.startsWith("create:")) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }} onClick={createFromPreview}>用此模板新建</Button>
                  <Button disabled={busy} onClick={clearPreview}>关闭预览</Button>
                </div>
              </div>
              <p className={styles.hint}>新文档可独立编辑，后续修改不会影响模板。</p>
              {previewLoading && <div className={styles.loading}><Spin /><span>正在读取模板正文和资源…</span></div>}
              {previewError && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={previewError} action={<Button size="small" disabled={busy || loading} onClick={() => loadPreview(previewTarget)}>重试</Button>} />}
              {preview && <>
                <p className={styles.pageDescription}>{previewPage.description}</p>
                <div className={styles.paperViewport}><div className={styles.paper} style={previewPage.style}>
                  <PageWatermark page={preview.template.document.page} />
                  <div className={styles.paperContent}>
                  <p className={styles.previewDocumentTitle}>{preview.template.document.title || preview.template.name}</p>
                  <PreviewBoundary key={preview.key} onError={failure => {
                    if (previewRef.current !== preview) return
                    releasePreview(previewRef.current)
                    previewRef.current = null
                    setPreview(null)
                    setPreviewError(failure.message || "模板预览失败，请重试")
                  }}><TemplatePreview preview={preview} /></PreviewBoundary>
                </div></div></div>
              </>}
            </section>}
          </>}
        </div>
      </Modal>
      <Modal title="保存为模板" open={saveOpen} onCancel={() => { if (!busyRef.current && !disabled) setSaveOpen(false) }} onOk={() => manage("save")} okText="保存模板" cancelText="取消" confirmLoading={pending.startsWith("save:")} okButtonProps={{ loading: (pending.startsWith("save:")) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }, disabled: busy || loading }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy} destroyOnHidden>
        <div className={styles.confirmation}>
          <p>将当前文档保存为可复用的模板。正文格式、图片、附件和页面设置会独立保留。</p>
          <p>批注不带入模板，当前文档中的批注会继续保留。</p>
          <Input aria-label="模板名称" placeholder="模板名称（1 到 100 个字符）" value={name} maxLength={100} showCount disabled={busy} onChange={event => setName(event.target.value)} onPressEnter={() => manage("save")} />
          {actionError && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={actionError} />}
        </div>
      </Modal>
      <Modal title="重命名模板" open={Boolean(renameTarget)} onCancel={() => { if (!busyRef.current && !disabled) setRenameTarget(null) }} onOk={() => { if (renameTarget) manage("rename", renameTarget) }} okText="确认重命名" cancelText="取消" confirmLoading={pending.startsWith("rename:")} okButtonProps={{ loading: (pending.startsWith("rename:")) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }, disabled: busy || loading }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy} destroyOnHidden>
        <div className={styles.confirmation}>
          <p>修改模板名称不会修改已经从模板新建的文档。</p>
          <Input aria-label="新模板名称" placeholder="模板名称（1 到 100 个字符）" value={name} maxLength={100} showCount disabled={busy} onChange={event => setName(event.target.value)} onPressEnter={() => { if (renameTarget) manage("rename", renameTarget) }} />
          {actionError && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={actionError} />}
        </div>
      </Modal>
      <Modal title="删除模板" open={Boolean(deleteTarget)} onCancel={() => { if (!busyRef.current && !disabled) setDeleteTarget(null) }} onOk={() => { if (deleteTarget) manage("delete", deleteTarget) }} okText="确认删除" cancelText="取消" confirmLoading={pending.startsWith("delete:")} okButtonProps={{ loading: (pending.startsWith("delete:")) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }, danger: true, disabled: busy || loading }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy} destroyOnHidden>
        <div className={styles.confirmation}>
          <p>删除「{deleteTarget?.name}」及其保留的图片和附件？</p>
          <p>删除模板不会影响已经新建的文档。此操作无法撤销。</p>
          {actionError && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={actionError} />}
        </div>
      </Modal>
    </>
  )
}
