/**
 * 统一正文工具按钮的选中、禁用、提示和可访问语义，减少各格式按钮的交互差异。
 * 通过保留正文焦点，让格式命令仍作用于用户原本选择的文字。
 */
import clsx from "clsx"
import styles from "../sass/toolbar.module.scss"

// 阻止 mousedown 默认抢焦点，让 click 命令仍作用于正文原选区；保留原生按钮键盘行为。
export function ToolbarButton({ label, children, active = false, disabled = false, onClick }) {
  return (
    <button
      type="button"
      className={clsx(styles.button, active && styles.active)}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={event => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
