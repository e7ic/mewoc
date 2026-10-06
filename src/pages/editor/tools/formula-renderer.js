/**
 * 隔离按需加载的 KaTeX 实现，将已校验的 LaTeX 源码转换为原生 MathML。
 * 渲染异常向调用方传播，由编辑视图或静态输出各自保留源码并展示错误状态。
 */
import katex from "katex"

/**
 * 输出原生 MathML，静态 HTML 和打印无需额外字体/脚本。
 * 限制宏展开和尺寸，拒绝外部资源与 HTML 指令；每次使用新宏对象，公式之间不共享定义。
 */
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
