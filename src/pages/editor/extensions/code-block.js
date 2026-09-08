import CodeBlock from "@tiptap/extension-code-block"
import { Extension, textblockTypeInputRule } from "@tiptap/core"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { getCodeLanguage } from "../constants/code-languages.js"
import { getPastedCodeLanguage } from "../tools/code-highlight.js"
import { getCodeBlockTarget, insertCodeBlock, indentCodeBlock, insertCodeNewline, exitCodeBlock } from "../tools/code-block-commands.js"
import { createCodeHighlightPlugin } from "./code-highlight.js"

// 语言属性保留原值以便文件往返，展示时再映射为支持的高亮语言；未知语言按纯文本处理。
export const DocumentCodeBlock = CodeBlock.extend({
  addAttributes() {
    return { language: { default: null, rendered: false, parseHTML: getPastedCodeLanguage } }
  },
  renderHTML({ node }) {
    return ["pre", { "data-code-language": node.attrs.language },
      ["code", { class: `language-${getCodeLanguage(node.attrs.language)}` }, 0]]
  },
  addKeyboardShortcuts() {
    const editor = this.editor
    const parent = this.parent()
    const guard = handler => () => {
      if (!editor.isEditable || editor.view.composing) return false
      return handler({ editor })
    }
    return {
      Backspace: guard(parent.Backspace),
      ArrowUp: guard(parent.ArrowUp),
      ArrowDown: guard(parent.ArrowDown),
      Tab: () => indentCodeBlock(editor),
      "Shift-Tab": () => indentCodeBlock(editor, true),
      Enter: () => insertCodeNewline(editor),
      "Mod-Enter": () => exitCodeBlock(editor),
      "Mod-Alt-c": () => getCodeBlockTarget(editor.state.selection) ? exitCodeBlock(editor) : insertCodeBlock(editor)
    }
  },
  addInputRules() {
    return [/^```([a-z0-9#+._-]{1,40})? $/i, /^~~~([a-z0-9#+._-]{1,40})? $/i].map(find => textblockTypeInputRule({
      find, type: this.type, getAttributes: match => ({ language: match[1] || "plaintext" })
    }))
  },
  addExtensions() {
    return [CodeBlockPaste]
  },
  addProseMirrorPlugins() {
    return [createCodeHighlightPlugin()]
  }
})

// VS Code 的明确源码先于链接粘贴处理，节点本身保持默认顺序，避免改变空文档的默认段落。
const CodeBlockPaste = Extension.create({
  name: "codeBlockPaste",
  priority: 1001,
  addProseMirrorPlugins() {
    return [createCodePastePlugin(this.editor, this.editor.schema.nodes.codeBlock)]
  }
})

function createCodePastePlugin(editor, type) {
  return new Plugin({
    key: new PluginKey("documentCodePaste"),
    props: {
      handlePaste: (view, event) => {
        if (!editor.isEditable || view.composing || !event.clipboardData) return false
        const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n")
        const target = getCodeBlockTarget(view.state.selection)
        // 已在代码块中时只消费纯文本，避免富文本样式或自动链接改变源码结构。
        if (target && view.state.selection instanceof TextSelection) {
          if (!text) return false
          view.dispatch(closeHistory(view.state.tr).insertText(text).setMeta("paste", true))
          view.dispatch(closeHistory(view.state.tr))
          return true
        }
        const metadata = event.clipboardData.getData("vscode-editor-data")
        if (!metadata || !text) return false
        let language
        try {
          language = JSON.parse(metadata)?.mode
        } catch {
          return false
        }
        if (typeof language !== "string" || !language || language.length > 1000) return false
        const tr = closeHistory(view.state.tr).replaceSelectionWith(type.create({ language }, view.state.schema.text(text)))
        if (tr.selection.$from.parent.type !== type) {
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, tr.selection.from - 2))))
        }
        view.dispatch(tr.setMeta("paste", true))
        view.dispatch(closeHistory(view.state.tr))
        return true
      }
    }
  })
}
