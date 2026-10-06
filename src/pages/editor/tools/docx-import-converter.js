/**
 * Worker 内的内容转换层：预处理 DOCX 后通过 Mammoth 生成受控 HTML，并收集内嵌图片。
 * 图片只返回 Blob 和稳定资源键，段落/公式由后续主线程阶段复原，不产生会话 URL。
 */
import mammoth from "mammoth"
import hash from "hash.js"
import { imageSize } from "image-size"
import { readDocxImportArchive } from "./docx-import-archive.js"
import { validateImageBlob } from "./image-assets.js"
import { createId } from "./create-id.js"
import { MAX_ASSET_BYTES } from "../constants/editor-constants.js"

// Worker 返回纯数据及 Blob；不创建 DOM、编辑器或会话 URL。
/** 返回可通过 Worker structured clone 传递的 HTML、元信息、资源和 warnings；任一步失败整体拒绝。 */
export async function convertDocxImport(source, signal) {
  const warnings = new Set(["按内容语义导入，字体、字号、颜色和段落间距使用编辑器默认值；原始分页不保证保留，请保留原 DOCX"])
  const { buffer, paragraphs, formulas, page } = await readDocxImportArchive(source, warnings, signal)
  // 按图片内容 SHA-256 去重，重复引用共享资源；总量只累计唯一图片的字节数。
  const images = new Map()
  let total = 0
  let count = 0
  // 两个入口共享同一块字节：浏览器适配器读取 arrayBuffer，Node 验证读取 buffer。
  const converted = await mammoth.convertToHtml({ arrayBuffer: buffer.buffer, buffer }, {
    // 不读取外部文件或包内自带样式映射，转换行为由应用的固定配置控制。
    externalFileAccess: false, includeEmbeddedStyleMap: false, ignoreEmptyParagraphs: false,
    styleMap: ["p[style-name='MewocImportParagraph'] => p.mewoc-docx-paragraph:fresh", "u => u", "strike => s"],
    // 固定版本的段落变换只关闭 Mammoth 的列表分组；身份、起点、层级改由源 XML 重建。
    // 统一标识每个段落并计数，让 HTML 中的段落可与源 XML 元信息一一配对。
    transformDocument: mammoth.transforms.paragraph(paragraph => {
      count += 1
      return { ...paragraph, numbering: null, styleId: "MewocImportParagraph", styleName: "MewocImportParagraph" }
    }),
    // 图片回调先验 MIME/文件头与尺寸，再用占位 src 连接主线程资源表，绝不加载远程地址。
    convertImage: mammoth.images.imgElement(async image => {
      signal?.throwIfAborted()
      const bytes = await image.readAsArrayBuffer()
      const blob = new Blob([bytes], { type: image.contentType })
      await validateImageBlob(blob)
      const size = imageSize(new Uint8Array(bytes))
      if (!size.width || !size.height || size.width * size.height > 40000000) throw new Error("图片尺寸无效或超过四千万像素")
      const key = `mewoc-image-${hash.sha256().update(new Uint8Array(bytes)).digest("hex")}`
      if (!images.has(key)) {
        total += blob.size
        if (total > MAX_ASSET_BYTES) throw new Error("图片总量超过 20 MiB")
        images.set(key, { key, id: createId(), kind: "image", fileName: `Word 图片-${images.size + 1}.${{ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[blob.type]}`, mimeType: blob.type, byteLength: blob.size, blob })
      }
      return { src: key }
    })
  })
  signal?.throwIfAborted()
  // Mammoth 的未知元素通常只是警告，但意味着正文可能被忽略，此处提升为整份导入失败。
  const failure = converted.messages.find(item => item.type === "error" || item.message.startsWith("An unrecognised element was ignored:"))
  if (failure) throw new Error(`Word 内容未能完整转换：${failure.message}`)
  converted.messages.forEach(item => warnings.add(`转换说明：${item.message}`))
  // HTML 长度限制防止下游 DOM 构造过大；段落数量一致是安全重建标题和列表的前提。
  if (count !== paragraphs.length || converted.value.length > 2000000) throw new Error("Word 段落无法完整对应或内容过大，请拆分文档后重试")
  if (formulas.length) warnings.add("常用 Word 公式已转换为可编辑公式，字体及细节间距可能不同")
  if (images.size) warnings.add("图片保留原始字节，显示宽度不超过 520px；浮动、裁剪和原排版尺寸不保留")
  if (converted.value.includes("<table")) warnings.add("表格保留内容和合并结构，列宽、行高、底色、边框与单元格设置使用编辑器默认值")
  // page 是纯数据，和正文/资源一起经过 Worker structured clone；不会读取当前编辑会话的页面。
  return { html: converted.value, paragraphs, formulas, page, images: [...images.values()], warnings: [...warnings] }
}
