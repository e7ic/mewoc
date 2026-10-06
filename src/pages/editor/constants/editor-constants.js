/**
 * 集中定义编辑控件可选值、默认纸张以及资源/文件容量和保存调度上限。
 * 这些常量同时约束界面操作和持久文档校验；字号使用 pt，缩进使用 em 倍数，容量使用原始字节。
 */
// 菜单与文件属性白名单共用这些值；新增选项也意味着扩展文档可接受的持久化格式。
export const FONT_FAMILIES = [
  { label: "系统默认", value: "" },
  { label: "宋体 / 衬线", value: "SimSun, Songti SC, serif" },
  { label: "黑体 / 无衬线", value: "Microsoft YaHei, PingFang SC, sans-serif" },
  { label: "等宽字体", value: "Consolas, Menlo, monospace" }
]
// 保留标题现有 30 / 20 / 17 px 外观；六级标题的默认字号均有对应的精确 pt 值。
export const FONT_SIZES = ["9.75pt", "10pt", "10.5pt", "11.25pt", "12pt", "12.75pt", "14pt", "15pt", "16pt", "18pt", "22.5pt", "24pt", "32pt"]
// 字重以 CSS 规范字符串保存，行距以无单位倍数保存，避免界面格式与文档校验使用不同数据类型。
export const FONT_WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"]
export const LINE_HEIGHTS = [1, 1.25, 1.5, 1.55, 1.75, 2, 2.5, 3]
// 首行/左缩进是相对字体的 em 倍数，0 表示明确取消缩进，区别于属性缺省的继承行为。
export const FIRST_LINE_INDENTS = [0, 1, 2, 3, 4]
export const LEFT_INDENTS = [0, 1, 2, 3, 4, 5, 6, 7, 8]
// 默认 A4 竖版使用物理毫米边距；创建文档时必须深克隆，防止某份文档修改全局默认对象。
export const DEFAULT_PAGE = {
  size: "A4",
  orientation: "portrait",
  marginsMm: { top: 20, right: 20, bottom: 20, left: 20 }
}
// 便携文件采用 base64；图片与附件共用原始字节预算，避免编辑与导出同时驻留过大数据。
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
// 音视频保留本地原始字节，与图片/附件共享总额度，不扩大便携文件预算。
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024
export const MEDIA_TYPES = { audio: ["audio/mpeg", "audio/wav"], video: ["video/mp4", "video/webm"] }
export const MEDIA_LOAD_TIMEOUT = 10000
export const MAX_ASSET_BYTES = 20 * 1024 * 1024
export const MAX_FILE_BYTES = 32 * 1024 * 1024
// 限制可解码的静态图片种类，实际导入还会核对头部特征，MIME 白名单并非完整内容验证。
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"]
// 单位为毫秒：输入停顿后保存，连续输入达到最长等待也发起保存；并非退出前落盘保证。
export const SAVE_DELAY = 800
export const MAX_SAVE_DELAY = 5000
