/**
 * 可键盘操作的工具栏短菜单，使用受控 Popover 展示单选项并在关闭后恢复入口焦点。
 * 菜单只管理焦点和呈现，选项状态与选择后的业务行为由调用方负责。
 */
import { useRef } from "react"
import { Popover } from "antd"
import { IconCheck } from "@tabler/icons-react"
import styles from "../sass/toolbar-menu.module.scss"

// 这里始终是纵向短菜单，无需横向菜单的溢出测量；原生按钮保留 Enter/Space 激活语义。
export function ToolbarMenu({ items, selectedKey, open, onOpenChange, onSelect, triggerRef, label, children }) {
  // panelRef 用于查询本次弹层中的按钮；triggerRef 由调用方提供，确保收起后焦点回到正确入口。
  const panelRef = useRef(null)
  // 所有菜单关闭路径统一恢复入口焦点，preventScroll 避免工具栏焦点切换带动页面跳动。
  const close = () => {
    onOpenChange(false)
    triggerRef.current?.focus({ preventScroll: true })
  }
  // 组合输入期间忽略菜单导航；Escape 关闭并阻止上层误响应，方向键和 Home/End 移动菜单焦点。
  const handleKey = event => {
    if (event.isComposing) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    const buttons = [...panelRef.current.querySelectorAll("button")]
    const index = buttons.indexOf(event.target.closest("button"))
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
      (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }
  // 打开后优先聚焦当前选中项，无选中项时聚焦首项；单选语义向辅助技术暴露当前菜单选择。
  return <Popover trigger="click" placement="bottomLeft" open={open} onOpenChange={onOpenChange} destroyOnHidden
    afterOpenChange={visible => {
      if (visible) (panelRef.current?.querySelector('[aria-checked="true"]') || panelRef.current?.querySelector("button"))?.focus()
    }} content={<div ref={panelRef} className={styles.menu} role="menu" aria-label={label} onKeyDown={handleKey}>
      {items.map(item => <button type="button" key={item.key} role="menuitemradio" aria-checked={item.key === selectedKey}
        onClick={() => { onSelect({ key: item.key }); close() }}>
        {item.icon}<span>{item.label}</span>{item.key === selectedKey && <IconCheck className={styles.check} aria-hidden="true" />}
      </button>)}
    </div>}>
    {children}
  </Popover>
}
