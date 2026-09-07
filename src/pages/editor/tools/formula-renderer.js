import katex from "katex"

export function renderFormulaMathml(latex, displayMode) {
  return katex.renderToString(latex, {
    displayMode,
    output: "mathml",
    throwOnError: true,
    strict: "error",
    trust: () => { throw new Error("公式不支持外部链接、图片或 HTML") },
    maxExpand: 200,
    maxSize: 20,
    macros: {}
  })
}
