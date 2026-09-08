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
