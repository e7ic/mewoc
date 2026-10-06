/**
 * 按需加载的代码着色实现，把 lowlight 的语法树转换成文本及样式类片段。
 * 结果仅描述外观，不改变源码或文档属性，编辑视图与静态导出可以按片段长度定位文字。
 */
import { createLowlight } from "lowlight"
import javascript from "highlight.js/lib/languages/javascript"
import html from "highlight.js/lib/languages/xml"
import css from "highlight.js/lib/languages/css"
import json from "highlight.js/lib/languages/json"
import bash from "highlight.js/lib/languages/bash"
import python from "highlight.js/lib/languages/python"

// 此模块按需加载，只注册菜单支持的语言，避免把全部语言解析器加入首屏依赖。
const LOWLIGHT = createLowlight({ javascript, html, css, json, bash, python })

// 将嵌套高亮树展平成连续文本片段，继承祖先样式类；调用方据文本长度映射正文位置。
export function getCodeTokens(text, language) {
  const tree = LOWLIGHT.highlight(language, text)
  const tokens = []
  // 沿树递归携带祖先样式，叶子文本保持原顺序；组合类名使嵌套语法仍保留全部着色信息。
  const visit = (node, classes) => {
    if (node.type === "text") {
      tokens.push({ text: node.value, classes })
      return
    }
    const names = [...classes, ...(node.properties?.className || [])]
    node.children?.forEach(child => visit(child, names))
  }
  visit(tree, [])
  return tokens
}
