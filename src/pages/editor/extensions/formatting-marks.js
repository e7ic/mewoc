/** 格式标记只存在于 ProseMirror Decoration；偏好事务不会触发保存或进入正文历史。 */
import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { collectFormattingMarkRanges } from "../tools/formatting-marks.js"

export const FORMATTING_MARKS_KEY = new PluginKey("mewocFormattingMarks")

// 独立读取插件偏好，允许 UI 在只读期间保持勾选；是否实际绘制另由 decorations 核对权限。
export function getFormattingMarksVisible(editor) {
  return !!editor && !editor.isDestroyed && !!FORMATTING_MARKS_KEY.getState(editor.state)?.visible
}

function createMarkWidget(view, kind) {
  const mark = view.dom.ownerDocument.createElement("span")
  mark.dataset.mewocFormatMark = kind
  mark.setAttribute("aria-hidden", "true")
  mark.contentEditable = "false"
  // 符号由屏幕专用 CSS 生成；DOM textContent 也保持原文，不混入字符统计或复制文本。
  return mark
}

function createDecorations(doc) {
  let widgetIndex = 0
  const decorations = collectFormattingMarkRanges(doc).map(range => {
    if (range.from === range.to) {
      return Decoration.widget(range.from, view => createMarkWidget(view, range.kind), {
        key: `${range.kind}-${widgetIndex++}`,
        side: range.kind === "paragraph" ? 1 : -1,
        relaxedSide: true,
        ignoreSelection: true,
        stopEvent: () => true
      })
    }
    // 这里包裹的是正文原始空白，不能设 contentEditable=false 或 aria-hidden，
    // 否则会阻碍空格编辑，或让读屏把相邻单词连接起来。背景图案本身没有可读字符。
    return Decoration.inline(range.from, range.to, {
      "data-mewoc-format-mark": range.kind,
      style: `--mewoc-format-count: ${range.count}`
    })
  })
  return DecorationSet.create(doc, decorations)
}

export const FormattingMarks = Extension.create({
  name: "formattingMarks",
  addCommands() {
    return {
      setFormattingMarksVisible: visible => ({ editor, tr, dispatch }) => {
        if (typeof visible !== "boolean" || editor.isDestroyed) return false
        const previous = tr.getMeta(FORMATTING_MARKS_KEY)?.visible ?? getFormattingMarksVisible(editor)
        // can() 与重复同步偏好都不重新构建装饰；命令本身允许只读调用，但视图始终隐藏。
        if (dispatch && previous !== visible) {
          tr.setMeta(FORMATTING_MARKS_KEY, { visible }).setMeta("addToHistory", false)
        }
        return true
      }
    }
  },
  addProseMirrorPlugins() {
    const { editor } = this
    return [new Plugin({
      key: FORMATTING_MARKS_KEY,
      state: {
        init: () => ({ visible: false, pending: false, decorations: DecorationSet.empty }),
        apply(transaction, previous) {
          const meta = transaction.getMeta(FORMATTING_MARKS_KEY)
          const visible = typeof meta?.visible === "boolean" ? meta.visible : previous.visible
          if (!transaction.docChanged && visible === previous.visible && !meta?.refresh) return previous
          // 输入法候选尚未确认时只映射已有装饰，避免在候选文字中插入新 span 或 widget。
          // compositionend 后再绘制最终文本；开启和关闭偏好也沿用这条安全更新路径。
          if (editor.view.composing) {
            return { visible, pending: true, decorations: previous.decorations.map(transaction.mapping, transaction.doc) }
          }
          return { visible, pending: false, decorations: visible ? createDecorations(transaction.doc) : DecorationSet.empty }
        }
      },
      props: {
        decorations: state => editor.isDestroyed || !editor.isEditable
          ? DecorationSet.empty : FORMATTING_MARKS_KEY.getState(state).decorations
      },
      view: view => {
        let timer
        const refresh = () => {
          clearTimeout(timer)
          // ProseMirror 会在 compositionend 后提交尚未读取的 DOM 变化；等该过程完成再装饰。
          timer = setTimeout(() => {
            if (view.isDestroyed || view.composing || !FORMATTING_MARKS_KEY.getState(view.state)?.pending) return
            view.dispatch(view.state.tr.setMeta(FORMATTING_MARKS_KEY, { refresh: true }).setMeta("addToHistory", false))
          }, 30)
        }
        view.dom.addEventListener("compositionend", refresh)
        return { destroy: () => {
          clearTimeout(timer)
          view.dom.removeEventListener("compositionend", refresh)
        } }
      }
    })]
  }
})
