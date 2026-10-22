/** 几何验收先确认真实页面可见且动画帧执行，避免把环境挂起重复计为产品失败。 */
export async function requireVisibleBrowser({ timeoutMs = 3000 } = {}) {
  let frames = 0
  let frame
  let timeout

  try {
    await new Promise((resolve, reject) => {
      const measure = () => {
        frames += 1
        if (document.visibilityState === "visible" && frames >= 2) {
          resolve()
          return
        }
        frame = requestAnimationFrame(measure)
      }

      timeout = setTimeout(() => {
        const diagnostics = {
          visibility: document.visibilityState,
          focused: document.hasFocus(),
          frames,
          topLevel: window.top === window,
          url: location.href
        }
        reject(new Error(`验收环境未就绪，尚未创建测试文档：${JSON.stringify(diagnostics)}`))
      }, timeoutMs)
      frame = requestAnimationFrame(measure)
    })
  } finally {
    clearTimeout(timeout)
    cancelAnimationFrame(frame)
  }
}
