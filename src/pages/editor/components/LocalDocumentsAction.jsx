/**
 * 本地文档库弹窗展示活跃记录与回收站，支持标题搜索、排序、分页及管理操作。
 * 当前文档保存与并发版本校验由父级协调；本组件使用会话/请求编号保护异步列表与嵌套弹窗。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Alert, Button, Empty, Input, List, Modal, Pagination, Select, Spin, Tabs, Tag } from "antd"
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight, IconCircleX, IconFolderOpen, IconHistory, IconLoader2, IconRefresh, IconSearch } from "@tabler/icons-react"
import { getDocuments } from "../tools/local-repository.js"
import { DocumentHistoryAction } from "./DocumentHistoryAction.jsx"
import styles from "../sass/library.module.scss"

// 每页固定展示六条；动作标签只用于成功/失败反馈，实际操作仍通过父级受保护的仓库入口。
const PAGE_SIZE = 6
const ACTION_LABELS = { rename: "重命名", duplicate: "复制", trash: "移入回收站", restore: "恢复" }

// 标题展示与搜索统一回退为未命名文档，避免空标题在不同库区域显示不一致。
function getRecordTitle(record) {
  return record.document.title || "未命名文档"
}

// 仓库时间转成本机中文展示，无效日期给出未知提示而不让列表渲染失败。
function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN")
}

export function LocalDocumentsAction({ disabled, onSelect, onPrepare, onManage, currentDocumentId, onPrepareHistory, onManageHistory }) {
  // open/ready/preparing 区分弹窗、保存准备与列表可用；loading 只负责仓库读取，revision 触发显式刷新。
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [records, setRecords] = useState([])
  const [tab, setTab] = useState("active")
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState("updatedAt")
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [pendingAction, setPendingAction] = useState("")
  // 重命名、回收确认与历史目标独立保存，分页或列表重读不会直接卸载嵌套历史面板。
  const [renameRecord, setRenameRecord] = useState(null)
  const [title, setTitle] = useState("")
  const [trashRecord, setTrashRecord] = useState(null)
  const [actionError, setActionError] = useState("")
  const [historyRecord, setHistoryRecord] = useState(null)
  // mounted/open/session 检查弹窗是否仍是同一轮；readRef 区分列表请求；busyRef 在按钮禁用渲染前防重入。
  const mountedRef = useRef(true)
  const openRef = useRef(false)
  const sessionRef = useRef(0)
  const readRef = useRef(0)
  const busyRef = useRef(false)

  const recycled = tab === "deleted"
  const busy = disabled || preparing || Boolean(pendingAction)
  // 搜索和排序仅处理已读取记录，不反复访问 IndexedDB；时间相同用标题/ID 保证稳定顺序。
  const filteredRecords = useMemo(() => {
    const needle = query.toLocaleLowerCase()
    return records.filter(record => getRecordTitle(record).toLocaleLowerCase().includes(needle)).sort((left, right) => {
      const byTitle = getRecordTitle(left).localeCompare(getRecordTitle(right), "zh-CN")
      if (sort === "title") return byTitle || left.id.localeCompare(right.id)
      const leftTime = sort === "deletedAt" ? left.deletedAt : left.document[sort]
      const rightTime = sort === "deletedAt" ? right.deletedAt : right.document[sort]
      return String(rightTime || "").localeCompare(String(leftTime || "")) || byTitle || left.id.localeCompare(right.id)
    })
  }, [records, query, sort])
  // 筛选或管理后记录数量可能减少，渲染页号钳到有效范围，避免出现有记录却显示空页的情况。
  const visiblePage = Math.max(1, Math.min(page, Math.ceil(filteredRecords.length / PAGE_SIZE)))
  const visibleRecords = filteredRecords.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE)
  const isCurrent = record => record.id === currentDocumentId
  const isCurrentSession = session => mountedRef.current && openRef.current && sessionRef.current === session

  // 首次打开先保存当前会话；搜索、排序和切页只处理列表，刷新才重新读取仓库。
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
      if (isCurrentSession(session)) setError(failure.message || "无法准备文档库，请重试")
    } finally {
      busyRef.current = false
      if (isCurrentSession(session)) setPreparing(false)
    }
  }

  // 每轮打开增加会话编号，清旧列表与筛选/嵌套状态，再异步保存当前文档准备读取。
  const handleOpen = () => {
    if (disabled || busyRef.current || openRef.current) return
    sessionRef.current += 1
    openRef.current = true
    setReady(false)
    setRecords([])
    setQuery("")
    setSort("updatedAt")
    setTab("active")
    setPage(1)
    setNotice("")
    setActionError("")
    setHistoryRecord(null)
    setOpen(true)
    prepare()
  }

  // 写操作忙碌时禁止关闭；普通关闭使会话和读请求失效，并清理嵌套动作目标。
  const handleCancel = () => {
    if (busyRef.current || disabled) return
    openRef.current = false
    sessionRef.current += 1
    readRef.current += 1
    setOpen(false)
    setRecords([])
    setError("")
    setRenameRecord(null)
    setTrashRecord(null)
    setHistoryRecord(null)
  }

  // 显式刷新废弃旧读请求并回到第一页，搜索/排序等本地交互则无需仓库重读。
  const refresh = () => {
    if (busyRef.current) return
    readRef.current += 1
    setPage(1)
    setNotice("")
    setRevision(value => value + 1)
  }

  // 同步占锁后请求父级保存并切换；仅父级返回 true 才关闭列表，失败保留所选记录和错误。
  const handleSelect = async record => {
    if (busyRef.current) return
    const session = sessionRef.current
    busyRef.current = true
    setPendingAction("open:" + record.id)
    setError("")
    setNotice("")
    try {
      if (await onSelect(record) !== true) throw new Error("文档未打开，请处理保存提示后重试")
      if (isCurrentSession(session)) {
        openRef.current = false
        sessionRef.current += 1
        readRef.current += 1
        setOpen(false)
        setRecords([])
        setPendingAction("")
      }
    } catch (failure) {
      if (isCurrentSession(session)) setError(failure.message || "打开文档失败，请重试")
    } finally {
      busyRef.current = false
      if (isCurrentSession(session)) setPendingAction("")
    }
  }

  // 所有管理动作统一加锁和提示；成功关闭确认层并重读列表，失败把错误放到对应确认层或库主面板。
  const manage = async (action, record, value) => {
    if (busyRef.current) return
    const session = sessionRef.current
    busyRef.current = true
    setPendingAction(action + ":" + record.id)
    setError("")
    setActionError("")
    setNotice("")
    try {
      if (!onManage || !await onManage(action, record, value)) throw new Error("操作未完成，请处理保存提示后重试")
      if (isCurrentSession(session)) {
        setRenameRecord(null)
        setTrashRecord(null)
        setNotice(action === "duplicate" ? "副本已保存，可在文档库中打开" : "文档已" + ACTION_LABELS[action])
        setPage(1)
        setRevision(count => count + 1)
      }
    } catch (failure) {
      if (isCurrentSession(session)) {
        const text = failure.message || ACTION_LABELS[action] + "失败，请重试"
        if (action === "rename" || action === "trash") setActionError(text)
        else setError(text)
      }
    } finally {
      busyRef.current = false
      if (isCurrentSession(session)) setPendingAction("")
    }
  }

  // 标题先 trim 并校验长度，避免把只有空白的名称提交到版本校验和仓库写入阶段。
  const submitRename = () => {
    if (busyRef.current || !renameRecord) return
    const nextTitle = title.trim()
    if (!nextTitle || nextTitle.length > 100) {
      setActionError("请输入 1 到 100 个字符的文档标题")
      return
    }
    manage("rename", renameRecord, nextTitle)
  }

  // 准备成功后按活跃/回收类别读仓库，取消标记、会话编号、请求编号三重判断防止旧列表覆盖新轮次。
  useEffect(() => {
    if (!open || !ready) return
    const session = sessionRef.current
    const request = ++readRef.current
    let cancelled = false
    setLoading(true)
    // 刷新期间保留已读列表，操作由 loading 禁用，避免短暂空列表闪烁。
    setError("")
    getDocuments({ deleted: tab === "deleted" }).then(nextRecords => {
      if (!cancelled && isCurrentSession(session) && readRef.current === request) {
        setRecords(nextRecords)
        // 历史面板独立于分页行；刷新后同步来源版本，后台恢复后可继续创建检查点。
        setHistoryRecord(selected => selected ? nextRecords.find(record => record.id === selected.id) || selected : null)
      }
    }).catch(failure => {
      if (!cancelled && isCurrentSession(session) && readRef.current === request) setError(failure.message || "读取文档库失败，请重试")
    }).finally(() => {
      if (!cancelled && isCurrentSession(session) && readRef.current === request) setLoading(false)
    })
    // 切换分类、刷新、关闭或卸载会屏蔽本轮迟到回写，不中止底层读取；搜索与排序处理已读列表。
    return () => { cancelled = true }
  }, [open, ready, tab, revision])

  // 组件卸载同时失效弹窗与仓库读请求，父级切换造成的卸载不会再接收管理结果回写。
  useEffect(() => () => {
    mountedRef.current = false
    openRef.current = false
    sessionRef.current += 1
    readRef.current += 1
  }, [])

  // 主列表、历史与管理确认层各持自己的目标；忙碌时锁定关闭和写操作，回收站只提供恢复入口。
  return (
    <>
      <button type="button" disabled={disabled || busy} onClick={handleOpen}><IconFolderOpen aria-hidden="true" />文档库</button>
      <Modal
        title="文档库"
        open={open}
        onCancel={handleCancel}
        footer={null}
        width={760}
        destroyOnHidden
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
      >
        <div className={styles.container}>
          <p className={styles.hint}>文档保存在此浏览器中。移入回收站后可以恢复，图片和附件会一同保留。</p>
          {preparing && <div className={styles.loading}><Spin /><span>正在保存当前文档并准备文档库…</span></div>}
          {error && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={error} action={
            <Button size="small" disabled={busy} onClick={ready ? refresh : prepare}>重试</Button>
          } />}
          {ready && <>
            <Tabs
              activeKey={tab}
              items={[{ key: "active", label: "文档", disabled: busy }, { key: "deleted", label: "回收站", disabled: busy }]}
              onChange={key => {
                if (busyRef.current) return
                readRef.current += 1
                setRecords([])
                setTab(key)
                setSort(key === "deleted" ? "deletedAt" : "updatedAt")
                setPage(1)
                setNotice("")
              }}
            />
            <div className={styles.controls}>
              <Input
                aria-label="文档搜索"
                placeholder="搜索文档标题"
                prefix={<IconSearch aria-hidden="true" />}
                allowClear={{ clearIcon: <IconCircleX aria-hidden="true" /> }}
                value={query}
                disabled={busy}
                onChange={event => { setQuery(event.target.value); setPage(1); setNotice("") }}
              />
              <Select suffixIcon={<IconChevronDown aria-hidden="true" />}
                aria-label="文档排序"
                value={sort}
                disabled={busy}
                className={styles.sort}
                onChange={value => { setSort(value); setPage(1) }}
                options={[
                  ...(recycled ? [{ value: "deletedAt", label: "按回收时间排序" }] : []),
                  { value: "updatedAt", label: "按更新时间排序" },
                  { value: "createdAt", label: "按创建时间排序" },
                  { value: "title", label: "按标题排序" }
                ]}
              />
              <Button icon={<IconRefresh aria-hidden="true" />} disabled={busy || loading} onClick={refresh}>刷新</Button>
            </div>
            {notice && <p className={styles.notice} role="status">{notice}</p>}
            <List
              loading={loading}
              dataSource={visibleRecords}
              rowKey="id"
              locale={{ emptyText: loading ? <span className={styles.hint}>正在读取文档…</span> : <Empty description={query ? "没有匹配的文档" : recycled ? "回收站为空" : "文档库还是空的，保存文档后可在这里查看"} /> }}
              renderItem={record => (
                <List.Item data-document-id={record.id} className={styles.row}>
                  <div className={styles.details}>
                    <div className={styles.title} title={getRecordTitle(record)}>
                      <span>{getRecordTitle(record)}</span>{isCurrent(record) && <Tag color="purple">当前文档</Tag>}
                    </div>
                    <div className={styles.metadata}>
                      <span>创建：{formatTime(record.document.createdAt)}</span>
                      <span>{recycled ? "回收" : "更新"}：{formatTime(recycled ? record.deletedAt : record.document.updatedAt)}</span>
                    </div>
                  </div>
                  <div className={styles.actions}>
                    {recycled ? <Button disabled={busy || loading} loading={(pendingAction === "restore:" + record.id) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }} onClick={() => manage("restore", record)}>恢复</Button> : <>
                      <Button type="primary" disabled={busy || loading} loading={(pendingAction === "open:" + record.id) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }} onClick={() => handleSelect(record)}>打开</Button>
                      <Button disabled={busy || loading} onClick={() => { setRenameRecord(record); setTitle(getRecordTitle(record)); setActionError("") }}>重命名</Button>
                      <Button disabled={busy || loading} loading={(pendingAction === "duplicate:" + record.id) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }} onClick={() => manage("duplicate", record)}>复制</Button>
                      <Button icon={<IconHistory aria-hidden="true" />} disabled={busy || loading} onClick={() => setHistoryRecord(record)}>历史版本</Button>
                      <Button danger disabled={busy || loading} onClick={() => { setTrashRecord(record); setActionError("") }}>移入回收站</Button>
                    </>}
                  </div>
                </List.Item>
              )}
            />
            {filteredRecords.length > 0 && <div className={styles.pagination} aria-label="文档分页">
              <Pagination prevIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="上一页"><IconChevronLeft aria-hidden="true" /></button>} nextIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="下一页"><IconChevronRight aria-hidden="true" /></button>} jumpPrevIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="向前跳页"><IconChevronsLeft aria-hidden="true" /></button>} jumpNextIcon={<button type="button" className="ant-pagination-item-link" tabIndex={-1} aria-label="向后跳页"><IconChevronsRight aria-hidden="true" /></button>}
                current={visiblePage}
                pageSize={PAGE_SIZE}
                total={filteredRecords.length}
                disabled={busy || loading}
                showSizeChanger={false}
                showTotal={total => "共 " + total + " 份文档"}
                onChange={setPage}
              />
            </div>}
          </>}
        </div>
      </Modal>
      {historyRecord && <DocumentHistoryAction key={historyRecord.id} record={historyRecord} currentDocumentId={currentDocumentId}
        disabled={busy || loading} initialOpen onClose={() => setHistoryRecord(null)}
        onPrepare={onPrepareHistory} onManage={onManageHistory} onChanged={refresh} />}
      <Modal
        title="重命名文档"
        open={Boolean(renameRecord)}
        onCancel={() => { if (!busyRef.current) { setRenameRecord(null); setActionError("") } }}
        onOk={submitRename}
        okText="保存名称"
        cancelText="取消"
        confirmLoading={pendingAction.startsWith("rename:")} okButtonProps={{ loading: (pendingAction.startsWith("rename:")) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> } }}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        destroyOnHidden
      >
        <div className={styles.dialogBody}>
          <label htmlFor="mewoc-library-title">新文档标题</label>
          <Input id="mewoc-library-title" aria-label="新文档标题" value={title} maxLength={100} showCount disabled={busy} onChange={event => { setTitle(event.target.value); setActionError("") }} onPressEnter={submitRename} />
          {actionError && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={actionError} />}
        </div>
      </Modal>
      <Modal
        title="移入回收站"
        open={Boolean(trashRecord)}
        onCancel={() => { if (!busyRef.current) { setTrashRecord(null); setActionError("") } }}
        onOk={() => { if (trashRecord) manage("trash", trashRecord) }}
        okText="移入回收站"
        cancelText="取消"
        okButtonProps={{ loading: (pendingAction.startsWith("trash:")) && { icon: <IconLoader2 aria-hidden="true" className="mewoc-icon-spin" /> }, danger: true }}
        confirmLoading={pendingAction.startsWith("trash:")}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        destroyOnHidden
      >
        <div className={styles.dialogBody}>
          <p className={styles.confirmTitle}>将「{trashRecord ? getRecordTitle(trashRecord) : ""}」移入回收站？</p>
          <p>文档、图片和附件都会保留，可以在回收站中恢复。</p>
          {trashRecord && isCurrent(trashRecord) && <p>这是当前文档，操作完成后将新建空白文档。</p>}
          {actionError && <Alert role="alert" type="error" icon={<IconCircleX aria-hidden="true" />} showIcon message={actionError} />}
        </div>
      </Modal>
    </>
  )
}
