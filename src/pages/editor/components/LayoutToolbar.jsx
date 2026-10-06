/**
 * 页面设置只在弹窗中编辑草稿；预览不写 store，应用时才校验并更新文档页面元信息。
 * 未修改的顶层、边距和水印字段从实时页面读取，避免旧草稿覆盖其他操作的更新。
 */
import { useRef, useState } from "react"
import { Button, Modal } from "antd"
import { IconFileText, IconLayoutBottombar } from "@tabler/icons-react"
import { useDocumentEditor, useEditorStore } from "./EditorProvider.jsx"
import { PageWatermark } from "./PageWatermark.jsx"
import { PageFurniture } from "./PageFurniture.jsx"
import { canEditRibbon } from "../tools/ribbon-commands.js"
import { validatePage } from "../tools/document-schema.js"
import { PAGE_SIZES, MARGIN_PRESETS, DEFAULT_WATERMARK, getPageDimensions, getMarginPresetId } from "../tools/page-settings.js"
import { DEFAULT_PAGE_FURNITURE, isPageFurnitureActive } from "../tools/page-furniture.js"
import toolbarStyles from "../sass/toolbar.module.scss"
import styles from "../sass/page-settings.module.scss"

const sides = [["top", "上"], ["right", "右"], ["bottom", "下"], ["left", "左"]]
const watermarkFields = ["text", "color", "opacity", "angle"]
const numeric = value => value === "" ? "" : Number(value)
const furniturePositions = [["header", "页眉"], ["footer", "页脚"]]
const furnitureFields = ["text", "alignment", "pageNumber"]

// 只合并显式编辑过的字段。开关未修改时遵循实时启用状态，不因编辑文字恢复已被其他操作关闭的水印。
function mergeDraft(page, draft, dirty) {
  const next = { ...page, marginsMm: { ...page.marginsMm } }
  for (const field of ["size", "orientation"]) if (dirty[field]) next[field] = draft[field]
  for (const [side] of sides) if (dirty[`marginsMm.${side}`]) next.marginsMm[side] = draft.marginsMm[side]
  const enabled = dirty.watermarkEnabled ? draft.watermarkEnabled : Boolean(page.watermark)
  if (dirty.watermarkEnabled && !enabled) next.watermark = null
  else if (enabled && (dirty.watermarkEnabled || watermarkFields.some(field => dirty[`watermark.${field}`]))) {
    next.watermark = { ...DEFAULT_WATERMARK, ...page.watermark }
    for (const field of watermarkFields) if (dirty[`watermark.${field}`]) next.watermark[field] = draft.watermark[field]
    if (dirty["watermark.text"]) next.watermark.text = next.watermark.text.trim()
  }
  return next
}

// 保存时只覆盖用户编辑的页眉页脚字段，纸型、边距、水印和未触碰的另一端保持实时值。
function mergeFurnitureDraft(page, draft, dirty) {
  const next = { ...page }
  for (const [position] of furniturePositions) {
    const enabledKey = `${position}Enabled`
    const enabled = dirty[enabledKey] ? draft[enabledKey] : Boolean(page[position])
    if (dirty[enabledKey] && !enabled) next[position] = null
    else if (enabled && (dirty[enabledKey] || furnitureFields.some(field => dirty[`${position}.${field}`]))) {
      next[position] = { ...DEFAULT_PAGE_FURNITURE, ...page[position] }
      for (const field of furnitureFields) if (dirty[`${position}.${field}`]) next[position][field] = draft[position][field]
      if (dirty[`${position}.text`]) next[position].text = next[position].text.trim()
    }
  }
  return next
}

/** 独立草稿与会话身份防止取消、切文档、只读或输入法候选确认时误写页面元信息。 */
function PageFurnitureSettings() {
  const { editor, store, documentId } = useDocumentEditor()
  const page = useEditorStore(state => state.page)
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState({})
  const [error, setError] = useState("")
  const sessionRef = useRef(null)
  const composingRef = useRef(false)
  const getBlocked = () => {
    const state = store.getState()
    return !canEditRibbon(editor, state.readOnly || state.switching)
  }
  const handleOpen = () => {
    if (getBlocked()) return
    const current = store.getState().page
    sessionRef.current = { documentId, store, editor }
    const next = {}
    for (const [position] of furniturePositions) {
      next[`${position}Enabled`] = Boolean(current[position])
      next[position] = { ...DEFAULT_PAGE_FURNITURE, ...structuredClone(current[position]) }
    }
    composingRef.current = false
    setDraft(next); setDirty({}); setError("")
  }
  const handleCancel = () => {
    sessionRef.current = null; composingRef.current = false
    setDraft(null); setDirty({}); setError("")
  }
  const change = (path, value) => {
    if (getBlocked()) return
    setDraft(current => {
      const [parent, child] = path.split(".")
      return child ? { ...current, [parent]: { ...current[parent], [child]: value } } : { ...current, [parent]: value }
    })
    setDirty(current => ({ ...current, [path]: true })); setError("")
  }
  const saveFurniture = event => {
    event.preventDefault()
    if (composingRef.current || event.nativeEvent?.isComposing) { setError("请先确认输入法候选，再应用页眉页脚。"); return }
    if (getBlocked()) { setError("当前文档不可编辑，页眉页脚草稿已保留。"); return }
    const session = sessionRef.current
    if (!session || session.documentId !== documentId || session.store !== store || session.editor !== editor) {
      setError("文档已切换，请关闭后重新设置当前文档的页眉页脚。"); return
    }
    try {
      const current = store.getState().page
      const next = mergeFurnitureDraft(current, draft, dirty)
      validatePage(next)
      if (JSON.stringify(current) !== JSON.stringify(next)) store.getState().updatePage(next)
      handleCancel()
    } catch (failure) { setError(failure.message) }
  }
  const preview = draft && mergeFurnitureDraft(page, draft, dirty)
  const dimensions = getPageDimensions(page)
  return <>
    <Button disabled={readOnly} onClick={handleOpen}><IconLayoutBottombar aria-hidden="true" />页眉页脚</Button>
    <Modal className={`${styles.modal} ${styles.furnitureModal}`} title="页眉页脚" style={{ top: 24 }} width={620} open={Boolean(draft)} onCancel={handleCancel} destroyOnHidden
      footer={<div className={styles.footer}><Button onClick={handleCancel}>取消</Button><Button type="primary" disabled={readOnly} onClick={saveFurniture}>应用</Button></div>}>
      {draft && <form className={styles.form} noValidate onSubmit={saveFurniture}
        onCompositionStart={() => { composingRef.current = true }} onCompositionEnd={() => { composingRef.current = false }}>
        {furniturePositions.map(([position, label]) => <section className={styles.furnitureSection} key={position} aria-label={`${label}设置`}>
          <label className={styles.toggle}><input aria-label={`启用${label}`} type="checkbox" checked={draft[`${position}Enabled`]} disabled={readOnly}
            onChange={event => change(`${position}Enabled`, event.target.checked)} />{label}</label>
          {draft[`${position}Enabled`] && <div className={styles.grid}>
            <label className={`${styles.field} ${styles.wide}`}><span>{label}文字</span><input type="text" maxLength={160} aria-label={`${label}文字`}
              value={draft[position].text} disabled={readOnly} onChange={event => change(`${position}.text`, event.target.value)} /></label>
            <label className={styles.field}><span>{label}对齐</span><select aria-label={`${label}对齐`} value={draft[position].alignment} disabled={readOnly}
              onChange={event => change(`${position}.alignment`, event.target.value)}>
              <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
            </select></label>
            <label className={styles.field}><span>{label}页码</span><select aria-label={`${label}页码`} value={draft[position].pageNumber} disabled={readOnly}
              onChange={event => change(`${position}.pageNumber`, event.target.value)}>
              <option value="none">无页码</option><option value="page">第 N 页</option><option value="page-total">第 N / 总页数 页</option>
            </select></label>
          </div>}
        </section>)}
        <div className={styles.preview}>
          <div className={styles.previewPaper} data-page-furniture-preview="" style={{ aspectRatio: `${dimensions.widthMm} / ${dimensions.heightMm}` }} aria-hidden="true">
            <PageWatermark page={preview} /><PageFurniture page={preview} />
            <div className={styles.previewBody} style={{ padding: `${page.marginsMm.top / dimensions.widthMm * 100}% ${page.marginsMm.right / dimensions.widthMm * 100}% ${page.marginsMm.bottom / dimensions.widthMm * 100}% ${page.marginsMm.left / dimensions.widthMm * 100}%` }}>
              {Array.from({ length: 7 }, (_, index) => <span key={index} />)}
            </div>
          </div>
          <p className={styles.hint}>预览为单页示意，编辑正文显示各页实际页码。打印和 Word 会独立计算页码与总页数。</p>
        </div>
        <p className={styles.hint}>单行普通文字最多 80 个字符。启用页眉或页脚时，相应上、下边距至少 12 mm；字号按纸面宽度自动调整为 6–9pt。空文字且无页码时不显示。</p>
        {readOnly && <p className={styles.hint} role="status">当前文档不可编辑，页眉页脚草稿已保留。</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </form>}
    </Modal>
  </>
}

export function LayoutToolbar() {
  const { editor, store, documentId } = useDocumentEditor()
  const page = useEditorStore(state => state.page)
  const readOnly = useEditorStore(state => state.readOnly || state.switching)
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState({})
  const [error, setError] = useState("")
  const sessionRef = useRef(null)
  const getBlocked = () => {
    const state = store.getState()
    return !canEditRibbon(editor, state.readOnly || state.switching)
  }
  const handleOpen = () => {
    if (getBlocked()) return
    const current = store.getState().page
    sessionRef.current = { documentId, store, editor }
    setDraft({ ...structuredClone(current), watermarkEnabled: Boolean(current.watermark), watermark: { ...DEFAULT_WATERMARK, ...current.watermark } })
    setDirty({})
    setError("")
  }
  const handleCancel = () => { sessionRef.current = null; setDraft(null); setDirty({}); setError("") }
  const change = (path, value) => {
    if (getBlocked()) return
    setDraft(current => {
      const [parent, child] = path.split(".")
      return child ? { ...current, [parent]: { ...current[parent], [child]: value } } : { ...current, [parent]: value }
    })
    setDirty(current => ({ ...current, [path]: true }))
    setError("")
  }
  const chooseMargins = id => {
    if (getBlocked() || id === "custom") return
    const preset = MARGIN_PRESETS.find(item => item.id === id)
    if (!preset) return
    setDraft(current => ({ ...current, marginsMm: { ...preset.marginsMm } }))
    setDirty(current => ({ ...current, ...Object.fromEntries(sides.map(([side]) => [`marginsMm.${side}`, true])) }))
    setError("")
  }
  const savePage = event => {
    event.preventDefault()
    // React 可编辑快照可能晚于事件一帧；提交必须重新读取实时权限、会话身份和输入法状态。
    if (getBlocked()) { setError("当前文档不可编辑，纸张草稿已保留。"); return }
    const session = sessionRef.current
    if (!session || session.documentId !== documentId || session.store !== store || session.editor !== editor) {
      setError("文档已切换，请关闭后重新设置当前文档的页面。"); return
    }
    try {
      const current = store.getState().page
      const nextPage = mergeDraft(current, draft, dirty)
      validatePage(nextPage)
      // 无修改或重复应用不制造额外修订；页面元信息本来就不进入正文的撤销栈。
      if (JSON.stringify(current) !== JSON.stringify(nextPage)) store.getState().updatePage(nextPage)
      handleCancel()
    } catch (failure) { setError(failure.message) }
  }
  const dimensions = getPageDimensions(page)
  const preview = draft && mergeDraft(page, draft, dirty)
  const previewDimensions = preview && getPageDimensions(preview)

  return <div className={`${toolbarStyles.view} ${styles.summary}`} data-page-settings-summary="">
    <IconFileText aria-hidden="true" />
    <strong>{page.size} · {page.orientation === "portrait" ? "纵向" : "横向"}</strong>
    <span>{dimensions.widthMm} × {dimensions.heightMm} mm · 边距 {page.marginsMm.top} / {page.marginsMm.right} / {page.marginsMm.bottom} / {page.marginsMm.left} mm</span>
    <Button disabled={readOnly} onClick={handleOpen}>纸张设置</Button>
    <PageFurnitureSettings />
    <span>{page.watermark ? "已启用文字水印。" : ""}编辑区自动分页，超高内容完整展开。</span>
    {(isPageFurnitureActive(page.header) || isPageFurnitureActive(page.footer)) && <span>页眉页脚已启用，页码为示意。</span>}
    <Modal className={styles.modal} title="纸张设置" style={{ top: 24 }} width={620} open={Boolean(draft)} onCancel={handleCancel} footer={null} destroyOnHidden>
      {draft && <form className={styles.form} noValidate onSubmit={savePage}>
        <div className={styles.grid}>
          <label className={styles.field}><span>纸张规格</span><select aria-label="纸张规格" value={draft.size} disabled={readOnly} onChange={event => change("size", event.target.value)}>
            {Object.keys(PAGE_SIZES).map(size => <option key={size} value={size}>{size}</option>)}
          </select></label>
          <div className={styles.field}><span>方向</span><div className={styles.radios} role="radiogroup" aria-label="方向">
            {[["portrait", "纵向"], ["landscape", "横向"]].map(([value, label]) => <label key={value}><input type="radio" name="page-orientation" value={value} checked={draft.orientation === value} disabled={readOnly} onChange={() => change("orientation", value)} />{label}</label>)}
          </div></div>
          <label className={`${styles.field} ${styles.wide}`}><span>边距预设</span><select aria-label="边距预设" value={getMarginPresetId(draft.marginsMm)} disabled={readOnly} onChange={event => chooseMargins(event.target.value)}>
            {MARGIN_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}（{preset.marginsMm.top} mm）</option>)}<option value="custom">自定义</option>
          </select></label>
          {sides.map(([key, label]) => <label className={styles.field} key={key}><span>{label}边距（mm）</span><input aria-label={`${label}边距（mm）`} type="number" min={0} step="any" value={draft.marginsMm[key]} disabled={readOnly} onChange={event => change(`marginsMm.${key}`, numeric(event.target.value))} /></label>)}
        </div>
        <label className={`${styles.toggle} ${styles.watermarkFields}`}><input aria-label="文字水印" type="checkbox" checked={draft.watermarkEnabled} disabled={readOnly} onChange={event => change("watermarkEnabled", event.target.checked)} />文字水印</label>
        {draft.watermarkEnabled && <div className={styles.grid}>
          {/* 原生 maxlength 统计 UTF-16 单位，160 才能容纳 80 个代理对字符；最终限制由码点契约验证。 */}
          <label className={`${styles.field} ${styles.wide}`}><span>水印文字</span><input aria-label="水印文字" type="text" maxLength={160} value={draft.watermark.text} disabled={readOnly} onChange={event => change("watermark.text", event.target.value)} /></label>
          <label className={`${styles.field} ${styles.wide}`}><span>水印颜色</span><div className={styles.color}>
            <input aria-label="选择水印颜色" type="color" value={/^#[0-9a-f]{6}$/i.test(draft.watermark.color) ? draft.watermark.color : DEFAULT_WATERMARK.color} disabled={readOnly} onChange={event => change("watermark.color", event.target.value)} />
            <input aria-label="水印颜色" type="text" value={draft.watermark.color} disabled={readOnly} onChange={event => change("watermark.color", event.target.value)} />
          </div></label>
          <label className={styles.field}><span>不透明度（%）</span><input aria-label="不透明度（%）" type="number" min={5} max={50} step="any" value={draft.watermark.opacity === "" ? "" : Number((draft.watermark.opacity * 100).toFixed(4))} disabled={readOnly} onChange={event => change("watermark.opacity", event.target.value === "" ? "" : Number(event.target.value) / 100)} /></label>
          <label className={styles.field}><span>水印角度（°）</span><input aria-label="水印角度（°）" type="number" min={-90} max={90} step="any" value={draft.watermark.angle} disabled={readOnly} onChange={event => change("watermark.angle", numeric(event.target.value))} /></label>
        </div>}
        <div className={styles.preview}>
          <div className={styles.previewPaper} data-page-settings-preview="" style={{ aspectRatio: `${previewDimensions.widthMm} / ${previewDimensions.heightMm}` }} aria-hidden="true">
            <PageWatermark page={preview} />
            <PageFurniture page={preview} />
            <div className={styles.previewBody} style={{ padding: `${Math.max(0, Number(preview.marginsMm.top) || 0) / previewDimensions.widthMm * 100}% ${Math.max(0, Number(preview.marginsMm.right) || 0) / previewDimensions.widthMm * 100}% ${Math.max(0, Number(preview.marginsMm.bottom) || 0) / previewDimensions.widthMm * 100}% ${Math.max(0, Number(preview.marginsMm.left) || 0) / previewDimensions.widthMm * 100}%` }}>
              {Array.from({ length: 7 }, (_, index) => <span key={index} />)}
            </div>
          </div>
          <p className={styles.hint}>{preview.size} · {previewDimensions.widthMm} × {previewDimensions.heightMm} mm；仅预览，应用后保存到当前文档。</p>
        </div>
        <p className={styles.hint}>边距至少保留 40 mm 正文区域。水印为 1–80 个单行字符，在各编辑页分别显示；页面设置不占用正文撤销步骤。</p>
        {readOnly && <p className={styles.hint} role="status">当前文档不可编辑，页面草稿已保留。</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.footer}><Button onClick={handleCancel}>取消</Button><Button type="primary" htmlType="submit" disabled={readOnly}>应用</Button></div>
      </form>}
    </Modal>
  </div>
}
