/**
 * 外部地址和文档位置共用链接表单，草稿始终绑定打开时的文字选区。
 * 文档目标逐一捕获并映射，标题建立稳定 ID 与链接标记属于同一次撤销。
 */
import { useEffect, useRef, useState } from "react"
import { useEditorState } from "@tiptap/react"
import { TextSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { Button, Form, Input, Modal } from "antd"
import { IconLink } from "@tabler/icons-react"
import { ToolbarButton } from "./ToolbarButton.jsx"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import { isInternalNavigationHref, isSafeDocumentLink } from "../tools/document-navigation.js"
import {
  listNavigationTargets, captureNavigationBlockTarget, mapNavigationBlockTarget, readNavigationBlockTarget,
  captureNavigationLinkTarget, mapNavigationLinkTarget, getNavigationLinkSelection, applyInternalNavigationLink
} from "../tools/navigation-commands.js"
import styles from "../sass/navigation.module.scss"

export function LinkAction({ variant = "text" }) {
  const { editor, store } = useDocumentEditor()
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const supported = useEditorState({ editor, selector: ({ editor: current }) => current.state.selection instanceof TextSelection })
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState("external")
  const [destination, setDestination] = useState("")
  const [options, setOptions] = useState([])
  const [error, setError] = useState("")
  const [, setVersion] = useState(0)
  const [form] = Form.useForm()
  const sourceRef = useRef(null)
  const destinationsRef = useRef([])
  const getBlocked = () => {
    const state = store.getState()
    return !canEditRibbon(editor, state.readOnly || state.switching)
  }

  // 监听在组件挂载时建立，原选区与每个目标从打开到关闭始终映射完整事务链。
  useEffect(() => {
    const track = ({ transaction, appendedTransactions = [] }) => {
      if (!sourceRef.current) return
      for (const current of [transaction, ...appendedTransactions]) {
        mapNavigationLinkTarget(sourceRef.current, current)
        for (const item of destinationsRef.current) mapNavigationBlockTarget(item.target, current)
      }
      setVersion(current => current + 1)
    }
    editor.on("transaction", track)
    return () => { editor.off("transaction", track); sourceRef.current = null; destinationsRef.current = [] }
  }, [editor])
  const handleOpen = () => {
    if (getBlocked()) return
    const source = captureNavigationLinkTarget(editor)
    if (!source) return
    sourceRef.current = source
    const captured = listNavigationTargets(editor).map((item, index) => ({ ...item, key: `${item.type}:${index}`,
      target: captureNavigationBlockTarget(editor, item.pos) })).filter(item => item.target)
    destinationsRef.current = captured
    setOptions(captured.map(item => ({ key: item.key, type: item.type })))
    const href = editor.getAttributes("link").href || ""
    const internal = isInternalNavigationHref(href)
    setKind(internal ? "document" : "external")
    setDestination(internal ? captured.find(item => item.id === href.slice(1))?.key || "missing" : "")
    form.setFieldsValue({ href: internal ? "" : href })
    setError("")
    setOpen(true)
  }
  const handleCancel = () => {
    sourceRef.current = null
    destinationsRef.current = []
    setOpen(false)
    setOptions([])
    setError("")
    form.resetFields()
  }
  const currentOptions = options.map(item => {
    const target = destinationsRef.current.find(record => record.key === item.key)?.target
    const current = target && readNavigationBlockTarget(editor, target)
    const available = current && (item.type === "heading" ? current.type === "heading" : Boolean(current.attrs.bookmarkName))
    const name = !available ? "目标已不存在" : item.type === "heading" ? `标题 ${current.attrs.level}：${current.text || "未命名标题"}` : `书签：${current.attrs.bookmarkName}`
    return { ...item, target, available, name }
  })
  const applyExternal = href => {
    const selection = getNavigationLinkSelection(editor, sourceRef.current)
    if (!selection) { setError("原选区已被删除或替换，请关闭弹窗后重新选择。"); return false }
    if (href && (!isSafeDocumentLink(href) || isInternalNavigationHref(href))) { setError("请输入完整的 https://、http://、mailto: 或 tel: 地址"); return false }
    // 原选区已包含光标所在的整个链接；只恢复该书签，不扩展后来改选的链接或正文。
    const chain = editor.chain().focus().setTextSelection({ from: selection.from, to: selection.to }).command(({ tr }) => { closeHistory(tr); return true })
    const applied = href ? chain.setLink({ href, target: "_blank", rel: "noopener noreferrer" }).run() : chain.unsetLink().run()
    if (!applied) { setError("当前选区无法应用链接，请重新选择文字。"); return false }
    editor.view.dispatch(closeHistory(editor.state.tr))
    return true
  }
  const saveLink = values => {
    if (getBlocked()) { setError("当前文档不可编辑，链接草稿已保留。"); return }
    let applied
    if (kind === "document") {
      const selected = currentOptions.find(item => item.key === destination && item.available)
      if (!selected) { setError("链接目标已不存在，请选择其他标题或书签。"); return }
      const result = applyInternalNavigationLink(editor, sourceRef.current, selected.target, getBlocked())
      if (!result.ok) { setError(result.error || "原文字或链接目标已变化，请重新选择。"); return }
      applied = true
    } else applied = applyExternal(values.href || "")
    if (applied) { handleCancel(); editor.commands.focus() }
  }
  const removeLink = () => {
    if (getBlocked()) { setError("当前文档不可编辑，链接草稿已保留。"); return }
    if (applyExternal("")) { handleCancel(); editor.commands.focus() }
  }
  const changeKind = value => {
    if (getBlocked()) return
    setKind(value)
    if (value === "document" && !destination) setDestination(currentOptions.find(item => item.available)?.key || "")
    setError("")
  }

  return <>
    {variant === "insert" ? <button type="button" aria-label="编辑链接" disabled={readOnly || !supported}
      onMouseDown={event => event.preventDefault()} onClick={handleOpen}><IconLink aria-hidden="true" /><span>链接</span></button>
      : <ToolbarButton label="编辑链接" disabled={readOnly || !supported} onClick={handleOpen}><IconLink aria-hidden="true" /></ToolbarButton>}
    <Modal className={styles.modal} style={{ top: 24 }} title="编辑链接" open={open} onCancel={handleCancel} footer={null} destroyOnHidden>
      <fieldset className={styles.linkKinds} disabled={readOnly} style={{ border: 0, padding: 0 }} aria-label="链接类型">
        <label><input type="radio" name={`link-kind-${variant}`} aria-label="外部地址" checked={kind === "external"} onChange={() => changeKind("external")} />外部地址</label>
        <label><input type="radio" name={`link-kind-${variant}`} aria-label="文档位置" checked={kind === "document"} onChange={() => changeKind("document")} />文档位置</label>
      </fieldset>
      <Form form={form} layout="vertical" onFinish={saveLink}>
        {kind === "external" ? <Form.Item label="链接地址" name="href" rules={[{ validator: validateExternalLink }]}>
          <Input aria-label="链接地址" placeholder="https://example.com" autoFocus disabled={readOnly} />
        </Form.Item> : <div className={styles.form}>
          <label className={styles.field}><span>目标位置</span><select aria-label="链接目标位置" value={destination} disabled={readOnly}
            onChange={event => { if (!getBlocked()) { setDestination(event.target.value); setError("") } }}>
            <option value="" disabled>选择标题或命名书签</option>
            {destination === "missing" && <option value="missing" disabled>原链接目标已不存在</option>}
            {currentOptions.map(item => <option key={item.key} value={item.key} disabled={!item.available}>{item.name}</option>)}
          </select></label>
          <p className={styles.hint}>编辑时按 ⌘ / Ctrl 并点击跳转；只读时直接点击。新标题目标在应用链接时建立稳定位置。</p>
          {!currentOptions.some(item => item.available) && <p className={styles.hint}>文档中还没有可用标题或命名书签。</p>}
        </div>}
        {readOnly && <p className={styles.hint} role="status">当前文档不可编辑，链接草稿已保留。</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.footer}>
          <Button type="link" onClick={removeLink} disabled={readOnly}>移除链接</Button>
          <Button onClick={handleCancel}>取消</Button>
          <Button type="primary" htmlType="submit" disabled={readOnly}>应用链接</Button>
        </div>
      </Form>
    </Modal>
  </>
}

// 外部地址保留原协议白名单与错误文案；文档片段只通过已捕获并校验的目标选择写入。
function validateExternalLink(_, value) {
  if (!value || isSafeDocumentLink(value) && !isInternalNavigationHref(value)) return Promise.resolve()
  return Promise.reject(new Error("请输入完整的 https://、http://、mailto: 或 tel: 地址"))
}
