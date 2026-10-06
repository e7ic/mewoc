/** 媒体存在性只读取快照，用于不支持播放内容的文件格式提示，不把提示混入正文。 */
export function hasDocumentMedia(content) {
  return content?.type === "media" || (content?.content || []).some(hasDocumentMedia)
}

export const MEDIA_PRINT_WARNING = "打印/PDF 只保留音频和视频的文件说明；完整资源请使用 Mewoc 文件或 HTML"
