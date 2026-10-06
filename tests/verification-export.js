/** 验收结果下载辅助：将运行环境和逐项结果序列化为独立 JSON 证据文件。 */
// 只在验收结束后下载，避免诊断下载 URL 混入运行中的资源计数。
// 保留浏览器、访问源和时间，区分当前回归与历史记录。
export function exportVerification(name, results) {
  const report = {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: location.href,
    results
  }
  // 临时下载 URL 延迟回收，给浏览器完成下载准备；不要在活动资源测量中触发此入口。
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `mewoc-m5-${name}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
