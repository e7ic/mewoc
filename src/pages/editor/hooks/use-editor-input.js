import { useEffect } from "react"
import { message } from "antd"
import { isSafeLink } from "../tools/document-schema.js"
import { FONT_FAMILIES, FONT_SIZES, LINE_HEIGHTS, FIRST_LINE_INDENTS, LEFT_INDENTS } from "../constants/editor-constants.js"
import { parseParagraphIndent } from "../extensions/paragraph-indent.js"
import { getFormulaSourceError } from "../tools/formula.js"

export function useEditorInput(editor, store, insertImages, saveDocument) {
  useEffect(() => {
    if (!editor) return
    const handlePaste = event => {
      if (!editor.isEditable) return
      const files = [...event.clipboardData.files].filter(file => file.type.startsWith("image/"))
      if (!files.length) return
      event.preventDefault()
      event.stopImmediatePropagation()
      insertImages(files)
    }
    const handleDrop = event => {
      if (!editor.isEditable || !event.dataTransfer.files.length) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
      insertImages([...event.dataTransfer.files], position)
    }
    const handleKeyDown = event => {
      if (!(event.metaKey || event.ctrlKey) || event.isComposing) return
      if (event.key.toLowerCase() === "s") {
        event.preventDefault()
        saveDocument()
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault()
        store.getState().updateView({ searchOpen: true })
      }
    }
    const dom = editor.view.dom
    dom.addEventListener("paste", handlePaste, true)
    dom.addEventListener("drop", handleDrop, true)
    dom.addEventListener("keydown", handleKeyDown)
    return () => {
      dom.removeEventListener("paste", handlePaste, true)
      dom.removeEventListener("drop", handleDrop, true)
      dom.removeEventListener("keydown", handleKeyDown)
    }
  }, [editor, store, insertImages, saveDocument])
}

export function cleanPastedHtml(html, hasAsset = () => false) {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  const formulas = new Set()
  parsed.querySelectorAll('span[data-type="inline-math"], div[data-type="block-math"]').forEach(element => {
    const latex = element.getAttribute("data-latex")
    if (getFormulaSourceError(latex)) return
    element.textContent = latex
    formulas.add(element)
  })
  const blocked = parsed.querySelectorAll("script, style, iframe, object, embed, svg, math, link, meta")
  let hasExternalImages = false
  blocked.forEach(node => node.remove())
  parsed.querySelectorAll("img").forEach(image => {
    if (!hasAsset(image.getAttribute("data-mewoc-asset-id"))) {
      hasExternalImages = true
      image.remove()
    }
  })
  parsed.body.querySelectorAll("*").forEach(element => {
    const textStyle = getPastedTextStyle(element)
    for (const attr of [...element.attributes]) {
      const isLink = element.tagName === "A" && attr.name === "href" && isSafeLink(attr.value)
      const isTableSpan = ["TD", "TH"].includes(element.tagName) && ["colspan", "rowspan"].includes(attr.name) && /^[1-9]\d{0,2}$/.test(attr.value)
      const isImageId = element.tagName === "IMG" && attr.name === "data-mewoc-asset-id"
      const isImageText = element.tagName === "IMG" && ["alt", "title"].includes(attr.name) && attr.value.length <= 1000
      const isImageSize = element.tagName === "IMG" && ["width", "height"].includes(attr.name) && Number(attr.value) > 0 && Number(attr.value) <= 20000
      const isFormula = formulas.has(element) && ["data-type", "data-latex"].includes(attr.name)
      if (!isLink && !isTableSpan && !isImageId && !isImageText && !isImageSize && !isFormula) element.removeAttribute(attr.name)
    }
    if (textStyle) element.setAttribute("style", textStyle)
  })
  if (hasExternalImages) message.info("已粘贴文字。网页图片请保存后通过「图片」插入")
  return parsed.body.innerHTML
}

function getPastedTextStyle(element) {
  const styles = []
  const css = element.style
  for (const property of ["color", "background-color"]) {
    const value = css.getPropertyValue(property)
    const match = value.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/)
    if (match) {
      const color = match.slice(1).map(channel => Number(channel).toString(16).padStart(2, "0")).join("")
      styles.push(`${property}: #${color}`)
    }
  }
  const family = css.fontFamily.replace(/["']/g, "")
  const font = FONT_FAMILIES.find(item => item.value && item.value === family)
  if (font) styles.push(`font-family: ${font.value}`)
  if (FONT_SIZES.includes(css.fontSize)) styles.push(`font-size: ${css.fontSize}`)
  if (["P", "H1", "H2", "H3"].includes(element.tagName)) {
    if (["left", "center", "right", "justify"].includes(css.textAlign)) styles.push(`text-align: ${css.textAlign}`)
    if (LINE_HEIGHTS.includes(Number(css.lineHeight))) styles.push(`line-height: ${css.lineHeight}`)
    const firstLine = parseParagraphIndent(css.textIndent, FIRST_LINE_INDENTS)
    const left = parseParagraphIndent(css.marginLeft, LEFT_INDENTS)
    if (firstLine) styles.push(`text-indent: ${firstLine}em`)
    if (left) styles.push(`margin-left: ${left}em`)
  }
  return styles.join("; ")
}
