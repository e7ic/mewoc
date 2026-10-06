/**
 * HTML 粘贴与本地拖动复制共用身份分配规则。移动保留原身份，副本只能引用副本自己的新目标。
 * ProseMirror 本地拖动直接传递 Slice，不能依赖 transformPastedHTML 来修复导航引用。
 */
import { Fragment, Slice } from "@tiptap/pm/model"
import { createId } from "./create-id.js"
import { collectNavigationTargets, isInternalNavigationHref, isNavigationId, isNavigationName } from "./document-navigation.js"

export function createNavigationCopyPlan(targets, currentContent) {
  const usedIds = new Set()
  const collectIds = node => {
    if (!node) return
    if (["paragraph", "heading"].includes(node.type) && isNavigationId(node.attrs?.navigationId)) usedIds.add(node.attrs.navigationId)
    node.content?.forEach(collectIds)
  }
  collectIds(currentContent)
  const usedNames = new Set(collectNavigationTargets(currentContent).filter(target => target.type === "bookmark").map(target => target.name))
  const counts = new Map()
  for (const target of targets) counts.set(target.id, (counts.get(target.id) || 0) + 1)
  const ambiguous = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id))
  const remapped = new Map()
  const copies = targets.map(target => {
    let id = target.id
    if (usedIds.has(id) || ambiguous.has(id)) {
      do { id = `nav-${createId()}` } while (usedIds.has(id))
    }
    usedIds.add(id)
    if (!ambiguous.has(target.id)) remapped.set(target.id, id)
    let name = null
    if (isNavigationName(target.name)) {
      name = availableBookmarkName(target.name, usedNames)
      usedNames.add(name)
    }
    return { id, name }
  })
  return { copies, remapped, ambiguous }
}

export function hasNavigationSliceFeatures(slice) {
  let found = false
  slice.content.descendants(node => {
    if (["paragraph", "heading"].includes(node.type.name) && isNavigationId(node.attrs.navigationId) || node.type.name === "tableOfContents") found = true
    return !found
  })
  return found
}

export function remapNavigationSlice(slice, currentContent) {
  const targets = []
  slice.content.descendants(node => {
    if (["paragraph", "heading"].includes(node.type.name) && isNavigationId(node.attrs.navigationId)) targets.push({ id: node.attrs.navigationId, name: node.attrs.bookmarkName })
  })
  const { copies, remapped, ambiguous } = createNavigationCopyPlan(targets, currentContent)
  let index = 0
  const visit = fragment => {
    const children = []
    fragment.forEach(node => {
      let attrs = node.attrs
      // 按遍历顺序分配，不能以 Node 对象作为 Map 键：不可变节点可以在同一个 Fragment 内复用。
      if (["paragraph", "heading"].includes(node.type.name) && isNavigationId(attrs.navigationId)) {
        const copy = copies[index++]
        attrs = { ...attrs, navigationId: copy.id, bookmarkName: copy.name }
      } else if (node.type.name === "tableOfContents") {
        attrs = { ...attrs, entries: attrs.entries.filter(entry => !ambiguous.has(entry.id)).map(entry => ({ ...entry, id: remapped.get(entry.id) || entry.id })) }
      }
      const marks = node.marks.flatMap(mark => {
        if (mark.type.name !== "link" || !isInternalNavigationHref(mark.attrs.href)) return [mark]
        const id = mark.attrs.href.slice(1)
        if (ambiguous.has(id)) return []
        return remapped.has(id) ? [mark.type.create({ ...mark.attrs, href: `#${remapped.get(id)}`, target: "_self" })] : [mark]
      })
      const content = node.content.size ? visit(node.content) : node.content
      children.push(node.isText ? node.mark(marks) : node.type.create(attrs, content, marks))
    })
    return Fragment.from(children)
  }
  return new Slice(visit(slice.content), slice.openStart, slice.openEnd)
}

// 副本后缀也计入 80 字符限制；名称不承担链接身份，改名不会改变 ID 或既有链接。
function availableBookmarkName(source, usedNames) {
  if (!usedNames.has(source)) return source
  let index = 1
  let name
  do {
    const suffix = `（副本 ${index++}）`
    name = `${source.slice(0, 80 - suffix.length)}${suffix}`
  } while (usedNames.has(name))
  return name
}
