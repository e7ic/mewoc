/**
 * 段落稳定锚点、自动目录和编辑/浏览两种内部链接交互。
 * 标题正文仍可正常输入；导航元数据由同一正文事务的追加步骤维护，不响应纯选区或展示切换。
 */
import { Extension, Node } from "@tiptap/core"
import { DOMSerializer } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { ReplaceAroundStep } from "@tiptap/pm/transform"
import { createId } from "../tools/create-id.js"
import { navigateToTarget } from "../tools/navigation-commands.js"
import { getTableOfContentsEntrySets, isInternalNavigationHref, isNavigationId, isNavigationName, NAVIGATION_SYNC_META, NAVIGATION_UPDATE_META, TABLE_OF_CONTENTS_DEFAULTS, validateTableOfContentsAttrs } from "../tools/document-navigation.js"

const NAVIGATION_KEY = new PluginKey("mewocDocumentNavigation")
const eligible = node => ["paragraph", "heading"].includes(node?.type.name)

function parseNavigationId(element) {
  const id = element.getAttribute("data-navigation-id") || element.getAttribute("id")
  return isNavigationId(id) ? id : null
}

function isNodeMarkup(step, pos, node) {
  return step instanceof ReplaceAroundStep && step.structure && step.from === pos && step.to === pos + node.nodeSize && step.gapFrom === pos + 1 && step.gapTo === pos + node.nodeSize - 1 && step.insert === 1
}

// 重复 ID 优先留给编辑前的原节点。副本插在原节点之前、或 Enter 拆段都不会夺走旧链接的目标身份。
function originalIdentities(oldState, transactions, state) {
  const identities = new Map()
  oldState.doc.descendants((node, pos) => {
    if (!eligible(node) || !isNavigationId(node.attrs.navigationId)) return
    let position = pos
    let valid = true
    for (const transaction of transactions) {
      for (let index = 0; index < transaction.steps.length; index += 1) {
        const step = transaction.steps[index]
        const before = transaction.docs[index].nodeAt(position)
        const mapped = step.getMap().mapResult(position, 1)
        const after = (transaction.docs[index + 1] || transaction.doc).nodeAt(mapped.pos)
        if (!eligible(before) || !eligible(after) || mapped.deleted && !isNodeMarkup(step, position, before)) { valid = false; break }
        position = mapped.pos
      }
      if (!valid) break
    }
    if (valid && state.doc.nodeAt(position)?.attrs.navigationId === node.attrs.navigationId) identities.set(node.attrs.navigationId, position)
  })
  return identities
}

function navigationUpdate(state, oldState, transactions) {
  const tr = state.tr
  const preferred = originalIdentities(oldState, transactions, state)
  const used = new Map()
  const allIds = new Set()
  let hasToc = false
  state.doc.descendants(node => {
    if (node.type.name === "tableOfContents") hasToc = true
    if (eligible(node) && isNavigationId(node.attrs.navigationId)) allIds.add(node.attrs.navigationId)
  })
  const allocate = () => {
    let id
    do { id = `nav-${createId()}` } while (allIds.has(id))
    allIds.add(id)
    return id
  }
  state.doc.descendants((node, pos) => {
    if (!eligible(node)) return
    let id = node.attrs.navigationId
    let name = node.attrs.bookmarkName
    // 普通段落没有书签时不保留孤立的标题锚点；标题转换成正文后，旧标题链接成为可提示的悬空链接。
    if (node.type.name === "paragraph" && !name) id = null
    if (isNavigationId(id)) {
      const preferredPos = preferred.get(id)
      if (preferredPos !== undefined && preferredPos !== pos || used.has(id)) {
        // 拆分携带了原属性：只有原段落保留 named bookmark，新段不会复制同一个书签入口。
        name = null
        id = node.type.name === "heading" ? allocate() : null
      }
    } else if (name || hasToc && node.type.name === "heading") id = allocate()
    if (isNavigationId(id)) used.set(id, pos)
    if (id !== node.attrs.navigationId || name !== node.attrs.bookmarkName) tr.setNodeMarkup(pos, undefined, { ...node.attrs, navigationId: id, bookmarkName: name })
  })
  // 所有目录采用当前真实标题顺序和级别；快照相同不派发新事务，防止插件形成刷新循环。
  if (hasToc) {
    const entriesByLevel = getTableOfContentsEntrySets(tr.doc.toJSON())
    tr.doc.descendants((node, pos) => {
      if (node.type.name !== "tableOfContents") return
      const entries = entriesByLevel[node.attrs.maxLevel]
      if (JSON.stringify(entries) !== JSON.stringify(node.attrs.entries)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, entries })
    })
  }
  return tr.docChanged ? tr.setMeta(NAVIGATION_UPDATE_META, true) : null
}

export const DocumentNavigation = Extension.create({
  name: "documentNavigation",
  priority: 1050,
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: {
        navigationId: { default: null, parseHTML: parseNavigationId, renderHTML: attrs => isNavigationId(attrs.navigationId) ? { id: attrs.navigationId, "data-navigation-id": attrs.navigationId } : {} },
        bookmarkName: { default: null, parseHTML: element => {
          const name = element.getAttribute("data-bookmark-name")
          return isNavigationName(name) && parseNavigationId(element) ? name : null
        }, renderHTML: attrs => isNavigationName(attrs.bookmarkName) ? { "data-bookmark-name": attrs.bookmarkName } : {} }
      }
    }, {
      types: ["link"],
      attributes: {
        // 对直接解析/命令创建的内部地址也统一 DOM target，不能在阅读文档时误开第二个页面。
        target: { default: "_blank", parseHTML: element => isInternalNavigationHref(element.getAttribute("href")) ? "_self" : "_blank",
          renderHTML: attrs => ({ target: isInternalNavigationHref(attrs.href) ? "_self" : attrs.target || "_blank" }) }
      }
    }]
  },
  addProseMirrorPlugins() {
    const { editor } = this
    return [new Plugin({
      key: NAVIGATION_KEY,
      appendTransaction: (transactions, oldState, state) => {
        if (!editor.isEditable || editor.view.composing || !transactions.some(tr => tr.docChanged || tr.getMeta(NAVIGATION_SYNC_META))) return null
        const update = navigationUpdate(state, oldState, transactions)
        // 组合输入结束后的延迟补齐不建立第二个撤销事件；正文 undo/redo 会按恢复的标题再次计算目录。
        if (update && transactions.some(tr => tr.getMeta(NAVIGATION_SYNC_META))) update.setMeta("addToHistory", false)
        return update
      },
      props: {
        // handleClick 依赖 ProseMirror 的编辑鼠标流程；只读时必须直接处理 DOM click，阻止浏览器改 URL。
        handleDOMEvents: { click: (view, event) => {
          const element = event.target?.closest?.("a[href]")
          const href = element?.getAttribute("href")
          if (!element || !view.dom.contains(element) || !isInternalNavigationHref(href)) return false
          event.preventDefault()
          // 编辑时普通点击仍保留编辑语义；只读浏览使用普通点击，输入法候选未确认时不移动光标。
          if (view.composing || editor.isEditable && !event.metaKey && !event.ctrlKey) return true
          const result = navigateToTarget(editor, href.slice(1))
          if (!result.ok) editor.emit("navigationError", { editor, id: href.slice(1), message: result.error })
          return true
        } }
      },
      view: view => {
        let timer = null
        const onCompositionEnd = () => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            if (!editor.isDestroyed && editor.isEditable && !view.composing) view.dispatch(view.state.tr.setMeta(NAVIGATION_SYNC_META, true).setMeta("addToHistory", false))
          }, 30)
        }
        view.dom.addEventListener("compositionend", onCompositionEnd)
        return { destroy: () => { clearTimeout(timer); view.dom.removeEventListener("compositionend", onCompositionEnd) } }
      }
    })]
  }
})

function tocHTMLSpec(attrs) {
  const values = validateTableOfContentsAttrs(attrs) ? TABLE_OF_CONTENTS_DEFAULTS : { ...TABLE_OF_CONTENTS_DEFAULTS, ...attrs }
  return ["nav", { "data-type": "table-of-contents", class: "mewoc-table-of-contents", "data-title": values.title,
    "data-max-level": String(values.maxLevel), "data-entries": JSON.stringify(values.entries), "aria-label": values.title },
  ["div", { "data-toc-title": "true" }, values.title],
  ...(values.entries.length ? [["ol", { "data-toc-entries-list": "true" }, ...values.entries.map(entry => ["li", { "data-toc-level": String(entry.level) },
    ["a", { href: `#${entry.id}`, target: "_self" }, entry.text || "未命名标题"]])]] : [["p", { "data-toc-empty": "true" }, "暂无可用标题"]])]
}

export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  marks: "",
  addAttributes() { return Object.fromEntries(Object.entries(TABLE_OF_CONTENTS_DEFAULTS).map(([name, value]) => [name, { default: value, rendered: false }])) },
  parseHTML: () => [{ tag: 'nav[data-type="table-of-contents"]', getAttrs: element => {
    try {
      const attrs = { title: element.getAttribute("data-title"), maxLevel: Number(element.getAttribute("data-max-level")), entries: JSON.parse(element.getAttribute("data-entries")) }
      return validateTableOfContentsAttrs(attrs) ? false : attrs
    } catch { return false }
  } }],
  renderHTML: ({ node }) => tocHTMLSpec(node.attrs),
  renderText: ({ node }) => [node.attrs.title, ...node.attrs.entries.map(entry => entry.text || "未命名标题")].join("\n\n"),
  addNodeView() {
    return ({ node }) => {
      let current = node
      let selected = false
      const dom = document.createElement("nav")
      const sync = next => {
        current = next
        const rendered = DOMSerializer.renderSpec(document, tocHTMLSpec(next.attrs)).dom
        for (const attr of [...dom.attributes]) dom.removeAttribute(attr.name)
        for (const attr of [...rendered.attributes]) dom.setAttribute(attr.name, attr.value)
        dom.dataset.tocView = "true"
        dom.contentEditable = "false"
        if (selected) dom.classList.add("ProseMirror-selectednode")
        dom.replaceChildren(...rendered.childNodes)
      }
      sync(node)
      return { dom, selectNode: () => { selected = true; dom.classList.add("ProseMirror-selectednode") },
        deselectNode: () => { selected = false; dom.classList.remove("ProseMirror-selectednode") }, update(next) {
        if (next.type !== current.type) return false
        if (JSON.stringify(next.attrs) !== JSON.stringify(current.attrs)) sync(next)
        return true
      }, ignoreMutation: mutation => mutation.type !== "selection" }
    }
  }
})
