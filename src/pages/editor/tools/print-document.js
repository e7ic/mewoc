/**
 * 将快照生成的静态 HTML 放入独立 iframe 执行浏览器打印，隔离编辑界面和焦点装饰。
 * 等待资源加载、取消、超时和打印结束共用幂等清理，调用方也可在会话切换时释放尚存 iframe。
 */
/**
 * 用独立 iframe 打印已生成的静态 HTML，等待字体和图片就绪后才唤起系统打印。
 * 返回清理函数供调用方管理；Promise 完成只表示已调用打印，不代表用户实际打印/保存。
 * signal 可终止资源等待并移除 iframe，不等同于能关闭已打开的系统打印窗口。
 */
export async function printDocument(html, signal) {
  if (signal?.aborted) throw new DOMException("打印已取消", "AbortError")
  // 输出窗口在页面中保持不可见，只承载打印文档；不通过主编辑器 DOM 临时切换样式。
  const frame = document.createElement("iframe")
  frame.title = "文档打印预览"
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden"
  let timeout
  let disposed = false
  let handleAbort
  const cleanup = () => {
    // afterprint、取消和下一次打印可能重复收口；不要再访问已移除 iframe 的窗口。
    if (disposed) return
    disposed = true
    clearTimeout(timeout)
    signal?.removeEventListener("abort", handleAbort)
    frame.contentWindow?.removeEventListener("afterprint", cleanup)
    frame.onload = null
    frame.remove()
  }
  try {
    await new Promise((resolve, reject) => {
      handleAbort = () => {
        cleanup()
        reject(new DOMException("打印已取消", "AbortError"))
      }
      signal?.addEventListener("abort", handleAbort, { once: true })
      // 资源等待设超时以避免 Promise 永久挂起；打印已唤起后清除计时，不能把系统对话框停留算作超时。
      timeout = setTimeout(() => reject(new Error("打印资源加载超时，请重试")), 15000)
      frame.onload = async () => {
        try {
          const printWindow = frame.contentWindow
          // 字体与所有图片就绪后再打印，防止系统截取字体替换或未载入图像的中间状态。
          await printWindow.document.fonts.ready
          await Promise.all([...printWindow.document.images].map(image => image.decode()))
          // 字体/图片等待期间可能取消，恢复异步执行后先确认 iframe 仍存活，避免对已释放窗口调用 print。
          if (disposed) return
          clearTimeout(timeout)
          printWindow.addEventListener("afterprint", cleanup, { once: true })
          printWindow.focus()
          printWindow.print()
          resolve()
        } catch {
          reject(new Error("部分图片未能载入，打印已停止，请重试"))
        }
      }
      frame.srcdoc = html
      document.body.append(frame)
    })
    // 系统打印窗口可能停留很久，不能按固定时长销毁仍在使用的输出。
    // 未触发 afterprint 时，调用方在下一次打印或会话卸载时释放，最多保留一个 iframe。
    return cleanup
  } catch (error) {
    cleanup()
    throw error
  }
}
