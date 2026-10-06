/**
 * 在 Tiptap 代码块节点上接入语言持久化、源码粘贴和编辑快捷键。
 * 节点保存原始文字，着色由独立视图插件提供；键盘编辑复用命令工具，粘贴与围栏输入在本扩展处理。
 */
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
    // 原始语言进入 data 属性供往返恢复，class 使用受支持语言名称供静态输出着色。
    return ["pre", { "data-code-language": node.attrs.language },
      ["code", { class: `language-${getCodeLanguage(node.attrs.language)}` }, 0]]
  },
  addKeyboardShortcuts() {
    // 继承的移动/删除命令也要经过只读与输入法保护，避免绕过本项目的编辑约束。
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
    // 输入围栏加空格才转换段落；捕获的语言留在节点属性中，缺省值为纯文本。
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

// 识别代码块内纯文本与 VS Code 元数据；未匹配的剪贴板继续走普通粘贴流程。
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
        // 代码块外必须有明确的编辑器元数据，不能把任意多行文字误判成源码。
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
        // 替换后若选区落到块外，将光标移回代码块附近，让用户能继续编辑刚粘贴的源码。
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
