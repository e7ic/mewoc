// 只在验收结束后下载，避免诊断下载 URL 混入运行中的资源计数。
// 保留浏览器、访问源和时间，区分当前回归与历史记录。
export function exportVerification(name, results) {
  const report = {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: location.href,
    results
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `mewoc-m5-${name}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
