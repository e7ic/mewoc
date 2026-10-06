/**
 * 组合便携备份、schema HTML、公式/代码渲染和批注说明，生成可离线阅读与打印的输出。
 * 静态输出从快照重建，二进制资源内嵌；下载入口管理临时地址而不依赖编辑界面 DOM。
 */
import { createDocumentHtml as createSnapshotHtml } from "./html-export.js"
import contentStyles from "../sass/content.scss?inline"

export { createPortableFile, readPortableFile } from "./portable-file.js"

/**
 * 从最新文档快照生成独立 HTML：先内嵌资源，再通过 schema 输出正文并补公式/代码渲染。
 * 不读取编辑器 NodeView 的 DOM，因此缩放手柄、选区和工具栏不会进入导出或打印。
 */
export async function createDocumentHtml(document, assets) {
  return createSnapshotHtml(document, assets, contentStyles)
}

// 借助临时 a 元素触发浏览器下载，标题中的文件名禁用字符替换为下划线，扩展名由导出入口指定。
export function downloadDocument(blob, title, extension) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `${title.replace(/[\\/:*?"<>|]/g, "_") || "未命名文档"}.${extension}`
  link.click()
  // 浏览器下载读取 object URL 是异步的，留出读取时间再释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
