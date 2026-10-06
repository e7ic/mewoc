/** 剪贴板只恢复 Mewoc 的受支持块容器；畸形或外部折叠结构展开时仍保留全部正文。 */
import { TEXT_BOX_DEFAULTS, validateBlockContainerAttrs } from "./block-containers.js"

const TEXT_BOX_DATA = { backgroundColor: "data-background-color", borderColor: "data-border-color", borderWidth: "data-border-width", padding: "data-padding" }

/** 返回每个合法容器的属性白名单和重建样式，供统一 HTML 清理器使用。 */
export function cleanPastedBlockContainers(parsed) {
  const containers = new Map()
  parsed.querySelectorAll('div[data-type="text-box"]').forEach(element => {
    const attrs = { ...TEXT_BOX_DEFAULTS }
    for (const [key, attribute] of Object.entries(TEXT_BOX_DATA)) {
      if (!element.hasAttribute(attribute)) continue
      const value = element.getAttribute(attribute)
      // Number("") 会把坏输入变成合法零，必须先核验整数的字面表示。
      attrs[key] = ["borderWidth", "padding"].includes(key) ? /^\d+$/.test(value) ? Number(value) : NaN : value
    }
    if (validateBlockContainerAttrs("textBox", attrs)) {
      // 只剥离容器语义和外观，子节点继续由总清理器处理，不能因一个坏颜色丢掉正文。
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name)
      return
    }
    for (const [key, attribute] of Object.entries(TEXT_BOX_DATA)) element.setAttribute(attribute, String(attrs[key]))
    containers.set(element, {
      attributes: new Set(["data-type", ...Object.values(TEXT_BOX_DATA)]),
      style: `background-color: ${attrs.backgroundColor}; border: ${attrs.borderWidth}px solid ${attrs.borderColor}; padding: ${attrs.padding}px`
    })
  })
  // 反向处理允许保留内部的合法详情，外层畸形结构展开时不会丢掉已清理的子树。
  for (const element of [...parsed.querySelectorAll("details")].reverse()) {
    const children = [...element.children]
    const summary = children.find(child => child.tagName === "SUMMARY")
    const body = children.find(child => child.tagName === "DIV" && child.hasAttribute("data-details-content"))
    const attrs = { summary: summary?.textContent ?? "" }
    const extraText = [...element.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())
    const valid = element.getAttribute("data-type") === "details" && children.length === 2 && children[0] === summary && children[1] === body && summary && body && !extraText
      && !validateBlockContainerAttrs("details", attrs)
    if (!valid) {
      flattenDetails(element, parsed)
      continue
    }
    // 标题只允许普通文字，剪贴板携带的嵌套标签和事件不成为可交互标题。
    summary.textContent = attrs.summary
    element.setAttribute("open", "")
    containers.set(element, { attributes: new Set(["data-type", "open"]), style: "" })
    containers.set(summary, { attributes: new Set(), style: "" })
    containers.set(body, { attributes: new Set(["data-details-content"]), style: "" })
  }
  return containers
}

// 不使用 contentElement 截取畸形结构：标题、正文包装之外的文字和重复正文都要按原顺序保留。
function flattenDetails(element, parsed) {
  const replacement = parsed.createElement("div")
  for (const child of [...element.childNodes]) {
    if (child.nodeType === 1 && child.tagName === "SUMMARY") {
      const paragraph = parsed.createElement("p")
      paragraph.append(...child.childNodes)
      replacement.append(paragraph)
    } else if (child.nodeType === 1 && child.tagName === "DIV" && child.hasAttribute("data-details-content")) replacement.append(...child.childNodes)
    else replacement.append(child)
  }
  element.replaceWith(replacement)
}
