/**
 * 流式文本框与可折叠详情的文档节点。
 * 折叠仅由 NodeView 保存为当前视图状态；JSON、复制、静态 HTML 和打印始终包含完整正文。
 */
import { Extension, Node, getTextBetween, getTextSerializersFromSchema } from "@tiptap/core"
import { DOMParser } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server.js"
import { IconChevronRight } from "@tabler/icons-react"
import { DETAILS_DEFAULTS, TEXT_BOX_DEFAULTS, exitBlockContainer, validateBlockContainerAttrs } from "../tools/block-containers.js"
import { normalizeTableColor } from "./table-appearance.js"

const boxData = { backgroundColor: "data-background-color", borderColor: "data-border-color", borderWidth: "data-border-width", padding: "data-padding" }
// 图标来自项目统一的 Tabler 图标库，只序列化一次；每个 NodeView 不额外创建 React 根。
const chevronMarkup = renderToStaticMarkup(createElement(IconChevronRight, { size: 20, stroke: 2 }))

// 内部 HTML 使用显式数据属性往返；外部标记只接收纯色和整数 px，不继承任意 CSS 表达式。
export function parseTextBoxAttrs(element) {
  const attrs = { ...TEXT_BOX_DEFAULTS }
  for (const key of Object.keys(boxData)) {
    const raw = element.getAttribute(boxData[key])
    if (raw !== null) attrs[key] = ["borderWidth", "padding"].includes(key) ? /^\d+$/.test(raw) ? Number(raw) : NaN : raw
    else if (["backgroundColor", "borderColor"].includes(key)) {
      const value = key === "backgroundColor" ? element.style.backgroundColor : element.style.borderTopColor
      if (value) attrs[key] = normalizeTableColor(value, "")
    } else {
      const value = key === "borderWidth" ? element.style.borderTopWidth : element.style.paddingTop
      if (value) attrs[key] = /^\d+px$/.test(value) ? Number.parseInt(value) : NaN
    }
  }
  return validateBlockContainerAttrs("textBox", attrs) ? false : attrs
}

export function getTextBoxHTMLAttrs(attrs) {
  const values = validateBlockContainerAttrs("textBox", attrs) ? TEXT_BOX_DEFAULTS : { ...TEXT_BOX_DEFAULTS, ...attrs }
  return {
    "data-type": "text-box",
    ...Object.fromEntries(Object.entries(boxData).map(([key, name]) => [name, String(values[key])])),
    style: `background-color: ${values.backgroundColor}; border: ${values.borderWidth}px solid ${values.borderColor}; padding: ${values.padding}px`
  }
}

export const DocumentTextBox = Node.create({
  name: "textBox",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() {
    return Object.fromEntries(Object.entries(TEXT_BOX_DEFAULTS).map(([key, value]) => [key, { default: value, rendered: false }]))
  },
  parseHTML: () => [{ tag: 'div[data-type="text-box"]', getAttrs: parseTextBoxAttrs }],
  renderHTML: ({ node }) => ["div", getTextBoxHTMLAttrs(node.attrs), 0],
  addExtensions() { return [BlockContainerNavigation] }
})

// 无效详情不接管节点，由普通 HTML 解析保留其标题与正文；合法外部详情只移除首个摘要标题。
function detailsAttrs(element) {
  const summaries = Array.from(element.children).filter(child => child.tagName === "SUMMARY")
  if (summaries.length !== 1) return false
  const bodies = Array.from(element.children).filter(child => child.hasAttribute("data-details-content"))
  // 内部结构损坏时不能只取第一个正文包装而丢掉尾文，拒绝接管后由普通解析完整保留内容。
  if (bodies.length > 1 || element.dataset.type === "details" && bodies.length !== 1) return false
  if (bodies.length && Array.from(element.childNodes).some(child => child !== summaries[0] && child !== bodies[0] && (child.nodeType !== 3 || child.textContent.trim()))) return false
  const summary = summaries[0].textContent
  return validateBlockContainerAttrs("details", { summary }) ? false : { summary }
}

function detailsContent(element, schema) {
  const body = Array.from(element.children).find(child => child.hasAttribute("data-details-content"))
  if (body) return DOMParser.fromSchema(schema).parse(body).content
  const wrapper = document.createElement("div")
  for (const child of element.childNodes) if (child.nodeName !== "SUMMARY") wrapper.append(child.cloneNode(true))
  return DOMParser.fromSchema(schema).parse(wrapper).content
}

export const DocumentDetails = Node.create({
  name: "details",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() { return { summary: { default: DETAILS_DEFAULTS.summary, rendered: false } } },
  parseHTML: () => [{ tag: "details", getAttrs: detailsAttrs, getContent: detailsContent }],
  renderHTML: ({ node }) => ["details", { "data-type": "details", open: "open" }, ["summary", node.attrs.summary], ["div", { "data-details-content": "true" }, 0]],
  renderText({ node, pos, range }) {
    // 标题保存在 attrs；只有选中完整外壳才复制标题，普通正文部分选区不能扩选成整块内容。
    const from = Math.max(0, Math.min(node.content.size, range.from - pos - 1))
    const to = Math.max(from, Math.min(node.content.size, range.to - pos - 1))
    const body = getTextBetween(node, { from, to }, { textSerializers: getTextSerializersFromSchema(node.type.schema) })
    const complete = range.from <= pos && range.to >= pos + node.nodeSize
    return complete ? `${node.attrs.summary}${body ? `\n\n${body}` : ""}` : body
  },
  addNodeView() { return props => createDetailsView(props) }
})

// 键盘行为优先于内部代码块，节点排序仍跟随普通 block，避免空文档的默认块变成递归容器。
const BlockContainerNavigation = Extension.create({
  name: "blockContainerNavigation",
  priority: 1001,
  addKeyboardShortcuts() { return { "Mod-Enter": () => exitBlockContainer(this.editor).ok } }
})

function createDetailsView({ node, editor, getPos }) {
  let current = node
  let expanded = true
  const dom = document.createElement("div")
  const toggle = document.createElement("button")
  const chevron = document.createElement("span")
  const label = document.createElement("span")
  const contentDOM = document.createElement("div")
  dom.dataset.type = "details"
  dom.dataset.detailsView = "true"
  toggle.type = "button"
  toggle.contentEditable = "false"
  toggle.dataset.detailsToggle = "true"
  chevron.dataset.detailsChevron = "true"
  chevron.setAttribute("aria-hidden", "true")
  chevron.innerHTML = chevronMarkup
  contentDOM.dataset.detailsContent = "true"
  toggle.append(chevron, label)
  dom.append(toggle, contentDOM)

  const sync = () => {
    label.textContent = current.attrs.summary
    toggle.setAttribute("aria-expanded", String(expanded))
    toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"}详情：${current.attrs.summary}`)
    dom.dataset.expanded = String(expanded)
    contentDOM.hidden = !expanded
  }
  // 只改变视图；收起当前光标所在的正文时选中整个外壳，避免留下一个不可见的文字插入点。
  const onToggle = () => {
    if (editor.isDestroyed || editor.view.composing) return
    const pos = getPos()
    if (typeof pos !== "number") return
    if (expanded) {
      const selection = editor.state.selection
      if (selection.from > pos && selection.to < pos + current.nodeSize) {
        editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)).setMeta("addToHistory", false))
      }
    }
    expanded = !expanded
    sync()
  }
  const onMouseDown = event => event.preventDefault()
  toggle.addEventListener("mousedown", onMouseDown)
  toggle.addEventListener("click", onToggle)
  // 大纲、搜索和选区恢复可能将光标移入已折叠正文；就地展开所有命中的祖先，不派发正文事务。
  const revealSelection = () => {
    if (expanded || editor.isDestroyed) return
    const pos = getPos()
    if (typeof pos !== "number") return
    const selection = editor.state.selection
    if (selection.from > pos && selection.to < pos + current.nodeSize) { expanded = true; sync() }
  }
  editor.on("selectionUpdate", revealSelection)
  sync()
  return {
    dom, contentDOM,
    update(next) {
      if (next.type !== current.type) return false
      current = next
      sync()
      revealSelection()
      return true
    },
    stopEvent: event => toggle.contains(event.target),
    ignoreMutation: mutation => {
      if (mutation.type === "selection") return false
      if (toggle.contains(mutation.target)) return true
      if (mutation.type === "attributes" && mutation.target === dom) return true
      return mutation.type === "attributes" && mutation.target === contentDOM && mutation.attributeName === "hidden"
    },
    destroy() {
      editor.off("selectionUpdate", revealSelection)
      toggle.removeEventListener("mousedown", onMouseDown)
      toggle.removeEventListener("click", onToggle)
    }
  }
}
