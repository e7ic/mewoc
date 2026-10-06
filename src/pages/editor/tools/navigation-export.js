/** 导出导航只处理正文副本：更新目录快照、恢复当前文档内的目标，并剥离已经失效的跳转。 */
import { collectNavigationTargets, isInternalNavigationHref, isNavigationId, prepareNavigationContent } from "./document-navigation.js"

export const MISSING_NAVIGATION_WARNING = "有文内链接的目标已不存在，已保留文字并移除失效跳转"

/** HTML、Word 和纯文本复用同一导航副本，不向原稿写目录更新或链接清理事务。 */
export function prepareNavigationExportContent(source) {
  const content = prepareNavigationContent(source)
  const targets = new Map()
  // 同一标题也可以是命名书签；按稳定 ID 去重，不能为同一段落生成两套相互冲突的导出锚点。
  for (const target of collectNavigationTargets(content)) if (target.id && !targets.has(target.id)) targets.set(target.id, target)
  // 文件协议也允许没有显示名称的普通段落锚点；是否能跳转应看节点实际存在，不能只看 UI 目标列表。
  const collectIds = node => {
    const id = node.attrs?.navigationId
    if (["paragraph", "heading"].includes(node.type) && isNavigationId(id) && !targets.has(id)) targets.set(id, { id, type: "paragraph" })
    node.content?.forEach(collectIds)
  }
  collectIds(content)
  const warnings = new Set()
  const visit = node => {
    if (node.marks) node.marks = node.marks.filter(mark => {
      if (mark.type !== "link" || !isInternalNavigationHref(mark.attrs?.href)) return true
      if (!targets.has(mark.attrs.href.slice(1))) {
        warnings.add(MISSING_NAVIGATION_WARNING)
        return false
      }
      // 外部链接仍沿用原窗口规则；文内锚点必须在当前导出文档内定位，而不是打开另一份 HTML。
      mark.attrs = { ...mark.attrs, target: "_self" }
      return true
    })
    node.content?.forEach(visit)
  }
  visit(content)
  return { content, targets, warnings: [...warnings] }
}
