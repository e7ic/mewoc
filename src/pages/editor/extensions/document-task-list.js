/** 待办清单复用官方列表结构和拆分规则，补齐安全的勾选、跨列表转换及静态输出。 */
import { TaskList, TaskItem } from "@tiptap/extension-list"
import { Fragment } from "@tiptap/pm/model"
import { AllSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { runEditingCommand } from "./editing-history.js"

const LIST_TYPES = ["bulletList", "orderedList", "taskList"]
const TASK_VIEW_KEY = new PluginKey("mewocTaskView")

// 与现有普通列表一致：光标在某层列表时切换整层，子列表保持自己的类型与勾选状态。
function currentList(state) {
  const { selection, doc } = state
  // StarterKit 自动在末尾列表后补一个空段落，不能因此让 Ctrl+A 后的列表切换突然不可用。
  const hasTrailingParagraph = doc.childCount === 2 && doc.lastChild.type.name === "paragraph" && !doc.lastChild.content.size
  if (selection instanceof AllSelection && (doc.childCount === 1 || hasTrailingParagraph) && LIST_TYPES.includes(doc.firstChild.type.name)) {
    return { node: doc.firstChild, pos: 0 }
  }
  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    const node = selection.$from.node(depth)
    if (LIST_TYPES.includes(node.type.name) && selection.to <= selection.$from.after(depth)) {
      return { node, pos: selection.$from.before(depth) }
    }
  }
  return null
}

// 工具栏必须按最近的列表层级回显；isActive(taskItem) 也会命中嵌套普通列表外的任务祖先。
export function getCurrentListType(editor) {
  return editor ? currentList(editor.state)?.node.type.name || null : null
}

function supportsListSelection(state) {
  const { selection, doc } = state
  if (!(selection instanceof TextSelection || selection instanceof AllSelection)) return false
  if (currentList(state)) return true
  // 混合选中列表和外部块时不冒险展平已有层级；普通多段文字仍由官方 wrap/lift 处理。
  let crossesList = false
  doc.nodesBetween(selection.from, selection.to, node => {
    if (LIST_TYPES.includes(node.type.name)) crossesList = true
    return !crossesList
  })
  return !crossesList
}

// 只查询选区结构，供 UI selector 缓存；只读/组合输入属于执行时状态，由按钮和命令另外核对。
export function supportsDocumentListSelection(editor) {
  return !!editor && supportsListSelection(editor.state)
}

function toggleDocumentList(type, attributes = {}) {
  return context => runEditingCommand(context, () => {
    const { state, tr, commands, dispatch } = context
    if (!LIST_TYPES.includes(type) || !supportsListSelection(state)) return false
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)
      || Object.keys(attributes).some(key => type !== "orderedList" || !["start", "type"].includes(key))
      || (attributes.start !== undefined && (!Number.isSafeInteger(attributes.start) || attributes.start < 1))
      || (attributes.type !== undefined && !["1", "a", "A", "i", "I"].includes(attributes.type))) return false
    const target = state.schema.nodes[type]
    const itemType = state.schema.nodes[type === "taskList" ? "taskItem" : "listItem"]
    const current = currentList(state)
    if (current && current.node.type !== target) {
      // 直接替换等长列表壳和直属 item。clearNodes() 会拆散嵌套/多段内容，不能用来转换任务列表。
      const items = []
      current.node.forEach(item => items.push(itemType.create(type === "taskList" ? { checked: false } : null, item.content)))
      const content = Fragment.from(items)
      if (!target.validContent(content)) return false
      if (dispatch) {
        const bookmark = tr.selection.getBookmark()
        tr.replaceWith(current.pos, current.pos + current.node.nodeSize, target.create(attributes, content))
        // 壳层大小不变，恢复原数字位置，防止 replaceWith 把光标跳到整张列表末尾。
        tr.setSelection(bookmark.resolve(tr.doc))
      }
      return true
    }
    if (current && state.selection instanceof AllSelection) {
      // 仅列表内部参与 lift，留下自动补出的尾段；can() 使用的是独立事务，不修改真实选区。
      return context.chain().command(({ tr: transaction }) => {
        transaction.setSelection(TextSelection.between(transaction.doc.resolve(current.pos + 1), transaction.doc.resolve(current.pos + current.node.nodeSize - 1)))
        return true
      }).liftListItem(itemType.name).run()
    }
    return commands.toggleList(type, itemType.name, false, attributes)
  })
}

export const DocumentTaskList = TaskList.extend({
  priority: 110,
  addCommands() {
    return {
      toggleTaskList: () => toggleDocumentList("taskList"),
      toggleDocumentList
    }
  },
  addKeyboardShortcuts() {
    // 同时接管普通列表快捷键，避免键盘绕过保留嵌套内容的转换命令。
    return {
      "Mod-Shift-7": () => this.editor.commands.toggleDocumentList("orderedList"),
      "Mod-Shift-8": () => this.editor.commands.toggleDocumentList("bulletList"),
      "Mod-Shift-9": () => this.editor.commands.toggleTaskList()
    }
  }
})

export const DocumentTaskItem = TaskItem.extend({
  addCommands() {
    return {
      setTaskCheckedAt: (position, checked) => context => runEditingCommand(context, () => {
        const { tr, dispatch } = context
        if (!Number.isInteger(position) || position < 0 || position >= tr.doc.content.size || typeof checked !== "boolean") return false
        const node = tr.doc.nodeAt(position)
        if (node?.type.name !== this.name) return false
        if (dispatch && node.attrs.checked !== checked) tr.setNodeMarkup(position, undefined, { ...node.attrs, checked })
        return true
      })
    }
  },
  addKeyboardShortcuts() {
    // Enter 沿用官方 keepOnSplit:false，新任务不会继承已完成状态；所有键盘入口核对输入法和只读。
    const shortcuts = this.parent?.() || {}
    return Object.fromEntries(Object.entries(shortcuts).map(([key, action]) => [key, () => {
      if (!this.editor.isEditable || this.editor.view.composing) return false
      return action()
    }]))
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["li", { ...HTMLAttributes, "data-type": this.name },
      ["label", ["input", { type: "checkbox", disabled: "disabled", checked: node.attrs.checked ? "checked" : null,
        "aria-label": `待办：${node.firstChild?.textContent || "空白事项"}` }]],
      ["div", 0]
    ]
  },
  addNodeView() {
    return props => createTaskItemView(props)
  },
  addProseMirrorPlugins() {
    const { editor } = this
    return [new Plugin({
      key: TASK_VIEW_KEY,
      view: () => {
        let editable = editor.isEditable
        return { update: view => {
          // setEditable(false, false) 不发正文事务；View 更新仍会到这里，同步复选框的键盘禁用状态。
          if (editable === editor.isEditable) return
          editable = editor.isEditable
          view.dom.querySelectorAll('li[data-type="taskItem"] > label > input').forEach(input => { input.disabled = !editable })
        } }
      }
    })]
  }
}).configure({ nested: true })

function createTaskItemView({ node, editor, getPos }) {
  let current = node
  const dom = document.createElement("li")
  const label = document.createElement("label")
  const checkbox = document.createElement("input")
  const contentDOM = document.createElement("div")
  dom.dataset.type = "taskItem"
  label.contentEditable = "false"
  checkbox.type = "checkbox"
  const sync = next => {
    current = next
    checkbox.checked = next.attrs.checked
    checkbox.disabled = !editor.isEditable
    checkbox.setAttribute("aria-label", `待办：${next.firstChild?.textContent || "空白事项"}`)
    dom.dataset.checked = String(next.attrs.checked)
  }
  label.addEventListener("mousedown", event => event.preventDefault())
  checkbox.addEventListener("change", () => {
    const position = getPos()
    if (!editor.isDestroyed && typeof position === "number") editor.commands.setTaskCheckedAt(position, checkbox.checked)
    // 拒绝只读/组合输入、节点已删除或值未变化时，也必须撤回浏览器临时勾选。
    sync(current)
  })
  sync(node)
  label.append(checkbox)
  dom.append(label, contentDOM)
  return {
    dom, contentDOM,
    update(next) {
      if (next.type !== current.type) return false
      sync(next)
      return true
    },
    stopEvent: event => label.contains(event.target),
    ignoreMutation: mutation => mutation.type !== "selection" && !contentDOM.contains(mutation.target)
  }
}
