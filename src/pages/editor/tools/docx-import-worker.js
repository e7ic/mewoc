/**
 * 一次性 Worker 的协议入口：接收转移来的文件 ArrayBuffer，返回转换数据或用户可读错误。
 * 超时与取消由主线程直接终止 Worker，因此此处不维护编辑器状态或常驻资源。
 */
import { convertDocxImport } from "./docx-import-converter.js"

// 将异常转换成可克隆的字符串，避免跨线程传递 Error 对象造成额外的消息读取失败。
self.onmessage = async event => {
  try {
    const result = await convertDocxImport(new Uint8Array(event.data))
    self.postMessage({ result })
  } catch (error) {
    self.postMessage({ error: error.message || "Word 转换失败，请重试" })
  }
}
