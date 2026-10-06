/**
 * DOCX 文件入口：在加载较重导入模块前先检查扩展名、文件大小与取消状态。
 * 合格文件才进入 Worker 会话流程；这里返回待预览/确认的记录，不改写当前编辑文档。
 */
export async function readDocxDocument(file, signal) {
  if (!/\.docx$/i.test(file.name)) throw new Error("请选择 .docx 文件；旧版 .doc 暂不支持")
  if (!file.size || file.size > 32 * 1024 * 1024) throw new Error("Word 文件不能为空且不能超过 32 MiB")
  signal?.throwIfAborted()
  // 动态加载期间用户也可能取消；加载完成后再次检查，避免启动已失效的导入会话。
  const importer = await import("./docx-import-session.js")
  signal?.throwIfAborted()
  return importer.readDocxSession(file, signal)
}
