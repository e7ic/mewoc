/** Word 的字母编号在 z 后按 aa、bb 重复；自有列表每 26 项分段，前缀保留浏览器进位规则。 */
import { getWordValue, WORD_XML } from "./docx-import-xml.js"
import { validateDocxNumberingSemantics } from "./docx-import-numbering-definitions.js"

const STYLE_NAME = "Mewoc Alphabetic v1 group "
export const DOCX_LETTER_NUMBERING_WARNING = "跨过 z 的字母编号按 26 项分段保留 a、b…z、aa、ab 的显示；在 Word 中跨分段增删项目后请从 Mewoc 重新导出"

export function createDocxLetterStyle(index) {
  return { id: `MewocAlphaV1G${index}`, name: `${STYLE_NAME}${index}`, basedOn: "Normal", next: "Normal", semiHidden: true }
}

export function getDocxLetterSegment(value, type) {
  const start = (value - 1) % 26 + 1
  let prefix = ""
  for (let remaining = Math.floor((value - 1) / 26); remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    prefix = String.fromCharCode((type === "A" ? 65 : 97) + (remaining - 1) % 26) + prefix
  }
  return { prefix, start }
}

// 仅恢复自有样式标记且显示语义完全可解释的段；样式名不是忽略未知编号内容的许可。
export function readDocxLetterSegment(style, entry, level) {
  const name = getWordValue(style, "name")
  if (!name?.startsWith(STYLE_NAME)) return undefined
  const invalid = () => new Error("Mewoc 字母编号分段已改变，无法可靠恢复，请保留原 DOCX")
  if (!/^[1-9]\d*$/.test(name.slice(STYLE_NAME.length)) || style.getAttributeNS(WORD_XML, "type") !== "paragraph" ||
    !["a", "A"].includes(entry.format) || entry.start < 1 || entry.start > 26 || entry.suffix !== "tab") throw invalid()
  validateDocxNumberingSemantics(entry)
  const placeholder = `%${level + 1}.`
  if (!entry.text?.endsWith(placeholder)) throw invalid()
  const prefix = entry.text.slice(0, -placeholder.length)
  if (!(entry.format === "a" ? /^[a-z]{0,6}$/ : /^[A-Z]{0,6}$/).test(prefix)) throw invalid()
  let offset = 0
  for (const letter of prefix.toLowerCase()) offset = offset * 26 + letter.charCodeAt(0) - 96
  offset *= 26
  if (!Number.isSafeInteger(offset)) throw invalid()
  return { id: `mewoc-alpha:${style.getAttributeNS(WORD_XML, "styleId")}`, offset }
}
