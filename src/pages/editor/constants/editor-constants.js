export const FONT_FAMILIES = [
  { label: "系统默认", value: "" },
  { label: "宋体 / 衬线", value: "SimSun, Songti SC, serif" },
  { label: "黑体 / 无衬线", value: "Microsoft YaHei, PingFang SC, sans-serif" },
  { label: "等宽字体", value: "Consolas, Menlo, monospace" }
]
export const FONT_SIZES = ["10pt", "12pt", "14pt", "16pt", "18pt", "24pt", "32pt"]
export const LINE_HEIGHTS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3]
export const FIRST_LINE_INDENTS = [0, 1, 2, 3, 4]
export const LEFT_INDENTS = [0, 1, 2, 3, 4, 5, 6, 7, 8]
export const DEFAULT_PAGE = {
  size: "A4",
  orientation: "portrait",
  marginsMm: { top: 20, right: 20, bottom: 20, left: 20 }
}
// 首期便携文件采用 base64；限制原始图片总量，避免编辑与导出同时驻留过大数据。
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_ASSET_BYTES = 20 * 1024 * 1024
export const MAX_FILE_BYTES = 32 * 1024 * 1024
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"]
export const SAVE_DELAY = 800
export const MAX_SAVE_DELAY = 5000
