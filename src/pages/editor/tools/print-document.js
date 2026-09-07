export async function printDocument(html, signal) {
  if (signal?.aborted) throw new DOMException("打印已取消", "AbortError")
  const frame = document.createElement("iframe")
  frame.title = "文档打印预览"
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden"
  let timeout
  let cleanupTimer
  let disposed = false
  let handleAbort
  const cleanup = () => {
    disposed = true
    clearTimeout(timeout)
    clearTimeout(cleanupTimer)
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
      timeout = setTimeout(() => reject(new Error("打印资源加载超时，请重试")), 15000)
      frame.onload = async () => {
        try {
          const printWindow = frame.contentWindow
          await printWindow.document.fonts.ready
          await Promise.all([...printWindow.document.images].map(image => image.decode()))
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
    // 部分浏览器不触发 afterprint，最终释放 iframe 与其中的解码图片。
    if (!disposed) cleanupTimer = setTimeout(cleanup, 60000)
    return cleanup
  } catch (error) {
    cleanup()
    throw error
  }
}
