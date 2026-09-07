import { createLowlight } from "lowlight"
import javascript from "highlight.js/lib/languages/javascript"
import html from "highlight.js/lib/languages/xml"
import css from "highlight.js/lib/languages/css"
import json from "highlight.js/lib/languages/json"
import bash from "highlight.js/lib/languages/bash"
import python from "highlight.js/lib/languages/python"

const LOWLIGHT = createLowlight({ javascript, html, css, json, bash, python })

export function getCodeTokens(text, language) {
  const tree = LOWLIGHT.highlight(language, text)
  const tokens = []
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
