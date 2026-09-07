import clsx from "clsx"
import styles from "../sass/toolbar.module.scss"

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
