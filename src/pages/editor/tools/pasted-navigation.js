/**
 * 剪贴板中的导航只恢复 Mewoc 标记；ID 冲突以副本为单位重映射，不能让副本抢占原目标。
 * 清理器返回逐元素属性白名单，后续统一清理仍会剥除事件、任意 CSS 和外部 id。
 */
import { isInternalNavigationHref, isNavigationId, validateTableOfContentsAttrs } from "./document-navigation.js"
import { createNavigationCopyPlan } from "./navigation-clipboard.js"

const TARGET_SELECTOR = "p[data-navigation-id], h1[data-navigation-id], h2[data-navigation-id], h3[data-navigation-id], h4[data-navigation-id], h5[data-navigation-id], h6[data-navigation-id]"

export function cleanPastedNavigation(parsed, currentContent) {
  const allowed = new Map()
  const targets = [...parsed.querySelectorAll(TARGET_SELECTOR)].filter(element => !element.closest('nav[data-type="table-of-contents"]') && isNavigationId(element.getAttribute("data-navigation-id")))
  const { copies, remapped, ambiguous } = createNavigationCopyPlan(targets.map(target => ({ id: target.getAttribute("data-navigation-id"), name: target.getAttribute("data-bookmark-name") })), currentContent)
  targets.forEach((target, index) => {
    const { id, name } = copies[index]
    target.setAttribute("id", id)
    target.setAttribute("data-navigation-id", id)
    const attributes = new Set(["id", "data-navigation-id"])
    if (name !== null) {
      target.setAttribute("data-bookmark-name", name)
      attributes.add("data-bookmark-name")
    }
    allowed.set(target, attributes)
  })
  // HTML 中重复源 ID 无法判断一条链接指向哪一个副本；保留标签文字，避免悄悄猜目标。
  for (const link of parsed.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href")
    if (!isInternalNavigationHref(href)) continue
    const sourceId = href.slice(1)
    if (ambiguous.has(sourceId)) link.removeAttribute("href")
    else if (remapped.has(sourceId)) link.setAttribute("href", `#${remapped.get(sourceId)}`)
  }
  for (const toc of [...parsed.querySelectorAll('nav[data-type="table-of-contents"]')]) {
    const attrs = readTocAttrs(toc)
    if (!attrs) {
      // 坏元数据不成为目录节点；现有标题、条目和额外正文仍按原顺序作为普通内容保留。
      const replacement = parsed.createElement("div")
      replacement.append(...toc.childNodes)
      toc.replaceWith(replacement)
      continue
    }
    attrs.entries = attrs.entries.filter(entry => !ambiguous.has(entry.id)).map(entry => ({ ...entry, id: remapped.get(entry.id) || entry.id }))
    toc.setAttribute("data-title", attrs.title)
    toc.setAttribute("data-max-level", String(attrs.maxLevel))
    toc.setAttribute("data-entries", JSON.stringify(attrs.entries))
    allowed.set(toc, new Set(["data-type", "data-title", "data-max-level", "data-entries"]))
    // 目录是只读快照而非任意 HTML 容器，显示内容完全由验证后的普通文本重建。
    const title = parsed.createElement("div")
    title.setAttribute("data-toc-title", "")
    title.textContent = attrs.title
    const list = parsed.createElement("ol")
    list.setAttribute("data-toc-entries-list", "")
    allowed.set(title, new Set(["data-toc-title"]))
    allowed.set(list, new Set(["data-toc-entries-list"]))
    for (const entry of attrs.entries) {
      const item = parsed.createElement("li")
      item.setAttribute("data-toc-level", String(entry.level))
      const link = parsed.createElement("a")
      link.setAttribute("href", `#${entry.id}`)
      link.textContent = entry.text || "未命名标题"
      item.append(link)
      list.append(item)
      allowed.set(item, new Set(["data-toc-level"]))
    }
    toc.replaceChildren(title, list)
  }
  return allowed
}

function readTocAttrs(element) {
  const rawEntries = element.getAttribute("data-entries")
  const rawLevel = element.getAttribute("data-max-level")
  if (!rawEntries || rawEntries.length > 2200000 || !/^[1-6]$/.test(rawLevel || "")) return null
  try {
    const attrs = { title: element.getAttribute("data-title"), maxLevel: Number(rawLevel), entries: JSON.parse(rawEntries) }
    return validateTableOfContentsAttrs(attrs) ? null : attrs
  } catch { return null }
}
