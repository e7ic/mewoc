/**
 * Node DOCX 导入原型的编排入口：先检查 ZIP，再由 Mammoth 转 HTML，显式映射为业务 JSON。
 * 资源按内容哈希去重，记录 Blob 与元信息并验证文档；只返回独立 record，不加载生产会话。
 */
import { createHash } from "node:crypto"
import mammoth from "mammoth"
import { imageSize } from "image-size"
import { createDocument, validateDocument, getReferencedAssetIds } from "../../src/pages/editor/tools/document-schema.js"
import { createId } from "../../src/pages/editor/tools/create-id.js"
import { validateImageBlob } from "../../src/pages/editor/tools/image-assets.js"
import { MAX_ASSET_BYTES } from "../../src/pages/editor/constants/editor-constants.js"
import { readDocxArchive } from "./archive.js"
import { createDocxContent } from "./html-content.js"

// 独立 Node 原型：返回与便携文件导入相同的新 record，但不持久化、不切换编辑器会话。
// 原型只读取图片尺寸与文件签名；正式浏览器入口仍需补实际解码和卸载取消验收。
export async function readDocxPrototype(source, title = "Word 导入文档", signal) {
  const warnings = new Set(["原型按内容语义导入；字体、字号、颜色、间距和纸张布局使用编辑器默认值，请保留原 DOCX"])
  const buffer = await readDocxArchive(source, warnings, signal)
  signal?.throwIfAborted()
  // HTML src 使用内部哈希键，资源表同时存显示尺寸；不生成 data/blob URL 或请求图片地址。
  const images = new Map()
  let bytes = 0
  const converted = await mammoth.convertToHtml({ buffer }, {
    // 固定样式映射且禁用外部文件读取，不接受包内嵌入的任意转换配置。
    externalFileAccess: false,
    includeEmbeddedStyleMap: false,
    ignoreEmptyParagraphs: false,
    styleMap: ["u => u", "strike => s"],
    // 读取内嵌原字节并验签名/尺寸，唯一图片才累计资源预算，重复显示共享资产 ID。
    convertImage: mammoth.images.imgElement(async image => {
      signal?.throwIfAborted()
      const source = await image.readAsBuffer()
      const blob = new Blob([source], { type: image.contentType })
      await validateImageBlob(blob)
      const key = `mewoc-image-${createHash("sha256").update(source).digest("hex")}`
      if (!images.has(key)) {
        const size = imageSize(source)
        if (!size.width || !size.height || size.width * size.height > 40000000) throw new Error("图片尺寸无效或超过四千万像素")
        bytes += blob.size
        if (bytes > MAX_ASSET_BYTES) throw new Error("图片总量超过 20 MiB")
        // 仅限制 JSON 中的显示尺寸，Blob 保持原始图片，后续便携保存仍能保全字节。
        const ratio = Math.min(1, 520 / size.width, 20000 / size.height)
        const id = createId()
        images.set(key, {
          id, kind: "image", fileName: `Word 图片-${images.size + 1}.${size.type}`,
          mimeType: blob.type, byteLength: blob.size, blob,
          width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio))
        })
      }
      return { src: key }
    })
  })
  signal?.throwIfAborted()
  // Mammoth 将部分图片错误降为 messages；此时绝不能交付一份缺图却标为成功的文档。
  const failure = converted.messages.find(item => item.type === "error" || item.message.startsWith("An unrecognised element was ignored:"))
  if (failure) throw new Error(`DOCX 转换失败：${failure.message}`)
  converted.messages.forEach(item => warnings.add(`转换器提示：${item.message}`))
  const document = createDocument()
  document.title = typeof title === "string" ? title.slice(0, 100) : "Word 导入文档"
  document.content = createDocxContent(converted.value, images, warnings)
  // 最终 JSON 引用才决定保留哪些资产，避免转换器读过但正文未引用的资源进入新记录。
  const ids = new Set(getReferencedAssetIds(document.content))
  const assets = new Map()
  for (const image of images.values()) {
    if (!ids.has(image.id)) continue
    // 持久化元数据不包含 Blob 或临时尺寸，资源 Map 另带 Blob 供便携保存/导出使用。
    const { blob, width: _width, height: _height, ...metadata } = image
    document.assets.push(metadata)
    assets.set(image.id, { ...metadata, blob })
  }
  if (assets.size) warnings.add("图片以原始字节内嵌，显示宽度不超过 520px；浮动、裁剪和原排版尺寸不保留，正式接入前需补浏览器解码")
  // 业务格式通过后才交付 record；取消仍可阻断交付，storageVersion=0 表示尚未写入本地仓库。
  validateDocument(document)
  signal?.throwIfAborted()
  return { record: { document, assets, storageVersion: 0 }, warnings: [...warnings] }
}
