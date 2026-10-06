/**
 * 文档导航的纯 JSON 契约、目标收集和目录快照刷新。
 * 此模块不依赖编辑器或 schema，可由文件校验、剪贴板、导出和 UI 共用。
 */
export const NAVIGATION_ID_PATTERN = /^nav-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/
export const TABLE_OF_CONTENTS_DEFAULTS = Object.freeze({ title: "目录", maxLevel: 3, entries: [] })
export const MAX_TOC_ENTRIES = 2000
export const MAX_NAVIGATION_TEXT = 1000
export const NAVIGATION_UPDATE_META = "mewocNavigationUpdate"
export const NAVIGATION_SYNC_META = "mewocNavigationSync"
const containers = new Set(["doc", "paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "taskList", "listItem", "taskItem", "table", "tableRow", "tableCell", "tableHeader", "textBox", "details"])

export const isNavigationId = value => typeof value === "string" && NAVIGATION_ID_PATTERN.test(value)
export const isNavigationName = value => typeof value === "string" && value.trim().length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value)

export function isInternalNavigationHref(value) {
  return typeof value === "string" && value.startsWith("#") && isNavigationId(value.slice(1))
}

// 内部地址仅接受本项目的稳定 ID；外部协议维持既有绝对 URL 白名单，拒绝空白与控制字符。
export function isSafeDocumentLink(value) {
  if (isInternalNavigationHref(value)) return true
  if (typeof value !== "string" || /[\u0000-\u0020]/.test(value)) return false
  try { return ["https:", "http:", "mailto:", "tel:"].includes(new URL(value).protocol) }
  catch { return false }
}

export function validateNavigationBlockAttrs(attrs = {}) {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return "导航属性格式无效。"
  if (attrs.navigationId !== undefined && attrs.navigationId !== null && !isNavigationId(attrs.navigationId)) return "导航 ID 无效。"
  if (attrs.bookmarkName !== undefined && attrs.bookmarkName !== null && !isNavigationName(attrs.bookmarkName)) return "书签名称须为 1–80 个单行字符。"
  if (attrs.bookmarkName !== null && attrs.bookmarkName !== undefined && !isNavigationId(attrs.navigationId)) return "书签缺少有效的导航 ID。"
  return ""
}

export function validateTableOfContentsAttrs(attrs = {}) {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs) || Object.keys(attrs).some(key => !["title", "maxLevel", "entries"].includes(key))) return "目录属性格式无效。"
  if (Object.hasOwn(attrs, "title") && !isNavigationName(attrs.title)) return "目录标题须为 1–80 个单行字符。"
  if (Object.hasOwn(attrs, "maxLevel") && (!Number.isInteger(attrs.maxLevel) || attrs.maxLevel < 1 || attrs.maxLevel > 6)) return "目录标题级别须为 1–6 的整数。"
  if (Object.hasOwn(attrs, "entries")) {
    if (!Array.isArray(attrs.entries) || attrs.entries.length > MAX_TOC_ENTRIES) return "目录条目过多或格式无效。"
    const ids = new Set()
    for (const entry of attrs.entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some(key => !["id", "level", "text"].includes(key)) || !isNavigationId(entry.id) || ids.has(entry.id)
        || !Number.isInteger(entry.level) || entry.level < 1 || entry.level > 6 || typeof entry.text !== "string" || entry.text.length > MAX_NAVIGATION_TEXT || /[\u0000-\u001f\u007f]/.test(entry.text)) return "目录条目属性无效或目标重复。"
      ids.add(entry.id)
    }
  }
  return ""
}

function navigationText(node) {
  const text = child => {
    if (child.type === "text") return child.text || ""
    if (child.type === "hardBreak") return " "
    if (child.type === "inlineMath") return child.attrs?.latex || ""
    return (child.content || []).map(text).join("")
  }
  return text(node).replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, MAX_NAVIGATION_TEXT)
}

// heading 与同段 named bookmark 可共用 ID；分别返回两种入口，目录只采用 heading 行。
export function collectNavigationTargets(content) {
  const targets = []
  const visit = (node, pos) => {
    if (["paragraph", "heading"].includes(node.type)) {
      const id = isNavigationId(node.attrs?.navigationId) ? node.attrs.navigationId : null
      const text = navigationText(node)
      if (node.type === "heading") targets.push({ id, type: "heading", name: text || "未命名标题", text, level: node.attrs?.level || 1, pos })
      if (isNavigationName(node.attrs?.bookmarkName) && id) targets.push({ id, type: "bookmark", name: node.attrs.bookmarkName, text, pos })
    }
    let childPos = node.type === "doc" ? 0 : pos + 1
    let contentSize = 0
    // 遍历同时返回节点大小，避免每层容器再次扫描所有后代；坐标与 ProseMirror 的首尾 token 一致。
    for (const child of node.content || []) {
      const size = visit(child, childPos)
      childPos += size
      contentSize += size
    }
    if (node.type === "text") return node.text?.length || 0
    return node.type === "doc" ? contentSize : containers.has(node.type) || node.content ? contentSize + 2 : 1
  }
  if (content) visit(content, -1)
  return targets
}

function entriesFromTargets(targets, maxLevel) {
  const ids = new Set()
  return targets.filter(target => {
    if (target.type !== "heading" || !target.id || target.level > maxLevel || ids.has(target.id)) return false
    ids.add(target.id)
    return true
  }).slice(0, MAX_TOC_ENTRIES).map(({ id, level, text }) => ({ id, level, text }))
}

export function getTableOfContentsEntries(content, maxLevel = TABLE_OF_CONTENTS_DEFAULTS.maxLevel) {
  return entriesFromTargets(collectNavigationTargets(content), maxLevel)
}

// 同一份文档最多只有六种级别筛选；所有目录共享一次目标收集，避免多目录反复全树扫描。
export function getTableOfContentsEntrySets(content) {
  const targets = collectNavigationTargets(content)
  return Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [level, entriesFromTargets(targets, level)]))
}

// 导出只刷新已有稳定目标的目录快照，不生成新 ID；原文档对象及撤销历史完全不受影响。
export function prepareNavigationContent(content) {
  const result = structuredClone(content)
  const entriesByLevel = getTableOfContentsEntrySets(result)
  const visit = node => {
    if (node.type === "tableOfContents") node.attrs = { ...TABLE_OF_CONTENTS_DEFAULTS, ...node.attrs, entries: structuredClone(entriesByLevel[node.attrs?.maxLevel ?? TABLE_OF_CONTENTS_DEFAULTS.maxLevel]) }
    node.content?.forEach(visit)
  }
  visit(result)
  return result
}
