/**
 * 定制不透明文字颜色面板，支持 HEX、RGB、HSB 草稿和可键盘操作的色相滑块。
 * 有效颜色与未完成输入分开维护，通道局部修改不会抹掉未触碰值，混合选区支持显式应用。
 */
import { useEffect, useRef, useState } from "react"
import { ColorPicker, Input, InputNumber, Select, Slider } from "antd"
import RcColorPicker from "@rc-component/color-picker"
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react"
import { createOpaqueTextColor, getTextColorDraft, isTextColorNumber, parseTextColorDraft, TEXT_COLOR_FIELDS } from "../tools/text-color.js"
import styles from "../sass/text-color-picker.module.scss"

// 固定输入图标与颜色格式选项；替换底层色相滑块以补齐方向键、Home/End 操作。
const NUMBER_CONTROLS = { upIcon: <IconChevronUp aria-hidden="true" />, downIcon: <IconChevronDown aria-hidden="true" /> }
const FORMAT_OPTIONS = ["hex", "rgb", "hsb"].map(value => ({ value, label: value.toUpperCase() }))
const PICKER_COMPONENTS = { slider: TextHueSlider }

export function TextColorPicker({ value, label, mixed = false, disabled = false, open = false, onOpenChange, onChange, isBlocked, children }) {
  // color 是可渲染的有效颜色，draft 可以包含未完成/无效输入；错误仅标注草稿，不先污染正文。
  const [color, setColor] = useState(() => createOpaqueTextColor(value))
  const [format, setFormat] = useState("hex")
  const [draft, setDraft] = useState(() => getTextColorDraft(color, "hex"))
  const [hexError, setHexError] = useState(false)
  const [formatOpen, setFormatOpen] = useState(false)
  // ref 保持本次事件链中的最新颜色、格式与草稿，避免 React 更新前多个通道事件使用旧值。
  // dirtyRef 记录用户实际改过的通道，解析时保留其他通道原值与黑灰颜色中记住的色相。
  const colorRef = useRef(color)
  const formatRef = useRef(format)
  const draftRef = useRef(draft)
  const dirtyRef = useRef(new Set())
  const externalHex = createOpaqueTextColor(value).toHexString()
  const getBlocked = () => disabled || isBlocked?.()
  // 同步 ref 与 state，让紧随输入的 blur/Enter 能读取尚未渲染完成的新草稿。
  const handleSetDraft = next => {
    draftRef.current = next
    setDraft(next)
  }
  // 把所有颜色来源转成不透明有效值；refresh 区分滑块更新与数字草稿，避免连续输入被格式化打断。
  const handleColorChange = (nextColor, refresh = true, explicit = false) => {
    if (getBlocked()) return
    const next = createOpaqueTextColor(nextColor)
    const changed = next.toHexString() !== colorRef.current.toHexString()
    colorRef.current = next
    setColor(next)
    if (refresh) {
      dirtyRef.current = new Set()
      handleSetDraft(getTextColorDraft(next, formatRef.current))
      setHexError(false)
    }
    // 色相在黑色/灰色时可以改变而 HEX 不变；保留本地状态，无须写一个相同的文字颜色。
    // 默认高亮色和混合选区的显示色可能只是占位；明确提交时仍要写到实际文字。
    if (changed || mixed || explicit) onChange(next)
  }
  // 转换展示格式时从有效颜色重新生成草稿，清除上一格式脏字段和错误，不改变正文颜色。
  const handleFormatChange = next => {
    if (getBlocked()) return
    formatRef.current = next
    setFormat(next)
    dirtyRef.current = new Set()
    handleSetDraft(getTextColorDraft(colorRef.current, next))
    setHexError(false)
    setFormatOpen(false)
  }
  // 数值通道边输入边解析；全部可见字段有效后只覆盖已修改通道，暂时空白或越界则保留草稿。
  const handleNumericChange = (field, value) => {
    if (getBlocked() || !open) return
    const nextDraft = { ...draftRef.current, [field]: value ?? "" }
    dirtyRef.current.add(field)
    handleSetDraft(nextDraft)
    const next = parseTextColorDraft(colorRef.current, formatRef.current, nextDraft, dirtyRef.current)
    if (next) handleColorChange(next, false, true)
  }
  // HEX 输入阶段仅保存原始字符，提交交给 Enter/失焦处理，避免半个色码被错误写入正文。
  const handleHexChange = event => {
    if (getBlocked()) return
    dirtyRef.current.add("hex")
    handleSetDraft({ hex: event.target.value })
    setHexError(false)
  }
  // 显式提交时完整解析 HEX；失败只标红并保留输入，成功更新颜色与所有通道回显。
  const handleHexCommit = event => {
    if (getBlocked()) return
    // 仅打开面板再离开不产生格式写入；Enter 则表示明确应用当前显示色。
    if (event.type === "blur" && !dirtyRef.current.has("hex")) return
    const next = parseTextColorDraft(colorRef.current, "hex", draftRef.current)
    if (!next) { setHexError(true); return }
    handleColorChange(next, true, true)
  }
  // 收起颜色面板也关闭内部格式下拉；只读或失活时不允许开启新交互。
  const handleOpenChange = next => {
    if (!next) setFormatOpen(false)
    if (!next || !getBlocked()) onOpenChange(next)
  }
  const handleFormatOpen = next => setFormatOpen(next && !getBlocked())

  // 外部只按真正变化的 HEX 同步；正文回显相同 HEX 时不能抹掉灰色/黑色中记住的色相。
  useEffect(() => {
    if (externalHex === colorRef.current.toHexString()) return
    const next = createOpaqueTextColor(externalHex)
    colorRef.current = next
    setColor(next)
    dirtyRef.current = new Set()
    const nextDraft = getTextColorDraft(next, formatRef.current)
    draftRef.current = nextDraft
    setDraft(nextDraft)
    setHexError(false)
  }, [externalHex])
  // 每次打开从当前有效颜色生成全新草稿，清除上一轮未提交输入；内部格式下拉不跨轮保留。
  useEffect(() => {
    setFormatOpen(false)
    if (!open) return
    dirtyRef.current = new Set()
    const nextDraft = getTextColorDraft(colorRef.current, formatRef.current)
    draftRef.current = nextDraft
    setDraft(nextDraft)
    setHexError(false)
  }, [open])

  // 禁用透明度以符合正文颜色约束；自定义面板复用底层颜色拖动，通道输入提供独立校验反馈。
  return <ColorPicker value={value} disabled={disabled} disabledAlpha open={open} onOpenChange={handleOpenChange}
    panelRender={() => <div className={styles.panel} data-text-color-picker={label}>
      <RcColorPicker prefixCls="ant-color-picker" value={color.toHsb()} disabled={disabled} disabledAlpha
        components={PICKER_COMPONENTS} onChange={next => handleColorChange(next)} />
      <div className={styles.inputs}>
        <Select className={styles.format} aria-label="颜色格式" size="small" value={format} options={FORMAT_OPTIONS}
          suffixIcon={<IconChevronDown aria-hidden="true" />} disabled={disabled} open={formatOpen}
          onOpenChange={handleFormatOpen} onChange={handleFormatChange} />
        {format === "hex" ? <Input aria-label="HEX 颜色" prefix="#" size="small" value={draft.hex} maxLength={7}
          status={hexError ? "error" : undefined} disabled={disabled} onChange={handleHexChange}
          onPressEnter={handleHexCommit} onBlur={handleHexCommit} />
          : <div className={styles.channels}>{TEXT_COLOR_FIELDS[format].map(([field, channelLabel, max]) => <label className={styles.channel} key={field}>
            <InputNumber aria-label={channelLabel} size="small" value={draft[field]} min={0} max={max} precision={0} step={1}
              disabled={disabled} controls={NUMBER_CONTROLS} changeOnBlur={false}
              status={String(draft[field] ?? "") && !isTextColorNumber(draft[field], max) ? "error" : undefined}
              onInput={raw => handleNumericChange(field, raw)} onChange={next => handleNumericChange(field, next)} />
            <span>{field.toUpperCase()}{format === "hsb" && field !== "h" ? " %" : ""}</span>
          </label>)}</div>}
      </div>
      {hexError && <p className={styles.error} role="alert">请输入 3 或 6 位十六进制颜色。</p>}
    </div>}>{children}</ColorPicker>
}

// Rc 的默认色相条只支持拖动；公开 slider 插槽改用 AntD Slider，保留方向键与 Home/End。
function TextHueSlider({ prefixCls, colors, min, max, value, disabled, onChange, onChangeComplete }) {
  const gradient = `linear-gradient(90deg, ${colors.map(({ color, percent }) => `${color} ${percent}%`).join(", ")})`
  return <Slider className={`${prefixCls}-slider ${styles.hue}`} min={min} max={max} value={value} disabled={disabled}
    step={1} included={false} keyboard tooltip={{ open: false }} ariaLabelForHandle="色相"
    classNames={{ rail: `${prefixCls}-slider-rail`, handle: `${prefixCls}-slider-handle` }}
    styles={{ rail: { background: gradient }, handle: { background: `hsl(${value}, 100%, 50%)` } }}
    onChange={onChange} onChangeComplete={onChangeComplete} />
}
