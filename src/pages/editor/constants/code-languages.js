/**
 * 定义代码语言菜单与兼容别名，供代码块命令、控件和着色入口共同使用。
 * 显示/渲染的规范值与文档原始 language 分离，未知语言仍可保存并按纯文本展示。
 */
export const CODE_LANGUAGES = [
  { value: "plaintext", label: "纯文本" },
  { value: "javascript", label: "JavaScript" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "json", label: "JSON" },
  { value: "bash", label: "Bash" },
  { value: "python", label: "Python" }
]

// 兼容复制来的常见简写，别名只映射到已有解析器，不为未知值自动加载语言实现。
const LANGUAGE_ALIASES = { js: "javascript", jsx: "javascript", xml: "html", sh: "bash", shell: "bash", py: "python", text: "plaintext", txt: "plaintext" }

// 仅用于选择渲染器和控件展示，不回写文档属性，未知语言的原始标记仍可往返保存。
export function getCodeLanguage(language) {
  const value = typeof language === "string" ? language.toLowerCase() : "plaintext"
  if (Object.hasOwn(LANGUAGE_ALIASES, value)) return LANGUAGE_ALIASES[value]
  return CODE_LANGUAGES.find(item => item.value === value)?.value || "plaintext"
}
