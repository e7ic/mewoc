export const CODE_LANGUAGES = [
  { value: "plaintext", label: "纯文本" },
  { value: "javascript", label: "JavaScript" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "json", label: "JSON" },
  { value: "bash", label: "Bash" },
  { value: "python", label: "Python" }
]

const LANGUAGE_ALIASES = { js: "javascript", jsx: "javascript", xml: "html", sh: "bash", shell: "bash", py: "python", text: "plaintext", txt: "plaintext" }

export function getCodeLanguage(language) {
  const value = typeof language === "string" ? language.toLowerCase() : "plaintext"
  if (Object.hasOwn(LANGUAGE_ALIASES, value)) return LANGUAGE_ALIASES[value]
  return CODE_LANGUAGES.find(item => item.value === value)?.value || "plaintext"
}
