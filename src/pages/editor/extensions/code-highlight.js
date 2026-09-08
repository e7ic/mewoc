import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { getCodeLanguage } from "../constants/code-languages.js"
import { highlightCode, MAX_CODE_HIGHLIGHT_LENGTH, MAX_CODE_HIGHLIGHT_TOTAL } from "../tools/code-highlight.js"

export const CodeHighlightKey = new PluginKey("codeHighlight")

// 高亮属于视图 Decoration，不写入正文 marks，因此不会改变源码、保存内容或正文撤销栈。
export function createCodeHighlightPlugin(highlight = highlightCode) {
  return new Plugin({
    key: CodeHighlightKey,
    state: {
      init: () => ({ decorations: DecorationSet.empty, messages: {} }),
      apply: (transaction, value) => {
        const result = transaction.getMeta(CodeHighlightKey)
        if (result?.doc === transaction.doc) return result
        return transaction.docChanged
          ? { decorations: value.decorations.map(transaction.mapping, transaction.doc), messages: {} }
          : value
      }
    },
    props: { decorations: state => CodeHighlightKey.getState(state).decorations },
    view: view => createHighlightView(view, highlight)
  })
}

function createHighlightView(view, highlight) {
  let timer
  let version = 0
  const schedule = () => {
    clearTimeout(timer)
    const request = ++version
    const doc = view.state.doc
    // 动态加载和着色可能晚于下一次输入；同时核对任务序号与文档引用后才能发布结果。
    const isCurrent = () => request === version && !view.isDestroyed && view.state.doc === doc
    timer = setTimeout(async () => {
      if (!isCurrent() || view.composing) return
      const result = await getCodeDecorations(doc, highlight, isCurrent)
      if (result && isCurrent() && !view.composing) {
        view.dispatch(view.state.tr.setMeta(CodeHighlightKey, result).setMeta("addToHistory", false))
      }
    }, 150)
  }
  // 组合输入期间跳过装饰更新，结束时重新调度，避免中文候选确认被 DOM 更新打断。
  const handleCompositionEnd = () => schedule()
  view.dom.addEventListener("compositionend", handleCompositionEnd)
  schedule()
  return {
    update: (current, previous) => {
      if (current.state.doc !== previous.doc) schedule()
    },
    destroy: () => {
      version += 1
      clearTimeout(timer)
      view.dom.removeEventListener("compositionend", handleCompositionEnd)
    }
  }
}

async function getCodeDecorations(doc, highlight, isCurrent) {
  const blocks = []
  const decorations = []
  const messages = {}
  let characters = 0
  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") blocks.push({ node, pos })
  })
  for (const { node, pos } of blocks) {
    if (!isCurrent()) return null
    if (!node.textContent || getCodeLanguage(node.attrs.language) === "plaintext") continue
    const length = node.textContent.length
    // 限额只控制着色开销，超限代码仍完整保留并可编辑、保存和导出。
    if (length > MAX_CODE_HIGHLIGHT_LENGTH || characters + length > MAX_CODE_HIGHLIGHT_TOTAL) {
      messages[pos] = "代码较长，当前按纯文本显示；源码可正常编辑和保存"
      continue
    }
    characters += length
    try {
      const tokens = await highlight(node.textContent, node.attrs.language)
      if (!isCurrent()) return null
      // pos 指向块节点边界，正文从 pos + 1 开始；无样式文本也必须推进偏移。
      let offset = pos + 1
      for (const token of tokens) {
        if (token.text.length && token.classes.length) {
          decorations.push(Decoration.inline(offset, offset + token.text.length, { class: token.classes.join(" ") }))
        }
        offset += token.text.length
      }
    } catch {
      messages[pos] = "高亮暂不可用，源码已保留；修改代码或语言可重试"
    }
  }
  return { doc, decorations: DecorationSet.create(doc, decorations), messages }
}
