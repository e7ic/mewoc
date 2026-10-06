/** 验收用资源观察器：计数本轮创建的 URL、两类活动 Observer 和指定窗口监听，结束后恢复原 API。 */
// 只观察安装后发生的资源操作；计数用于指定生命周期检查，不代表完整进程内存诊断。
export function observeSessionResources() {
  const urls = new Set()
  const observers = new Set()
  const mutationObservers = new Set()
  const listeners = new Map(["beforeunload", "mousemove", "mouseup", "blur"].map(type => [type, new Set()]))
  const original = {
    create: URL.createObjectURL, revoke: URL.revokeObjectURL, ResizeObserver: window.ResizeObserver,
    MutationObserver: window.MutationObserver,
    add: window.addEventListener, remove: window.removeEventListener
  }
  let createdUrls = 0
  let peakUrls = 0
  let peakObservers = 0
  let peakMutationObservers = 0
  // 创建/释放同时转发原生实现，Set 记录当前活动 URL，累积与峰值单独保存。
  URL.createObjectURL = blob => {
    const url = original.create.call(URL, blob)
    urls.add(url)
    createdUrls += 1
    peakUrls = Math.max(peakUrls, urls.size)
    return url
  }
  URL.revokeObjectURL = url => {
    urls.delete(url)
    original.revoke.call(URL, url)
  }
  // 保留原生观察行为，observe 标记活跃实例，disconnect 从活动计数中移除。
  window.ResizeObserver = class extends original.ResizeObserver {
    observe(...args) {
      observers.add(this)
      peakObservers = Math.max(peakObservers, observers.size)
      return super.observe(...args)
    }
    disconnect() {
      observers.delete(this)
      return super.disconnect()
    }
  }
  // DOM 展开状态的观察独立计数，保留 observers / peakObservers 原有的 ResizeObserver 含义。
  window.MutationObserver = class extends original.MutationObserver {
    observe(...args) {
      mutationObservers.add(this)
      peakMutationObservers = Math.max(peakMutationObservers, mutationObservers.size)
      return super.observe(...args)
    }
    disconnect() {
      mutationObservers.delete(this)
      return super.disconnect()
    }
  }
  // 只跟踪本模块实际使用的 window 事件；现有监听与 React 根事件不计入。
  window.addEventListener = function (type, listener, options) {
    listeners.get(type)?.add(listener)
    return original.add.call(this, type, listener, options)
  }
  window.removeEventListener = function (type, listener, options) {
    listeners.get(type)?.delete(listener)
    return original.remove.call(this, type, listener, options)
  }
  return {
    getCounts: () => ({
      urls: urls.size, observers: observers.size, mutationObservers: mutationObservers.size,
      listeners: [...listeners.values()].reduce((total, entries) => total + entries.size, 0),
      listenerDetails: [...listeners].flatMap(([type, entries]) => [...entries].map(listener => `${type}:${listener.name || "anonymous"}`)),
      createdUrls, peakUrls, peakObservers, peakMutationObservers
    }),
    // 必须在验收 finally 调用，避免测试包装继续影响产品页面与后续测量。
    restore() {
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
      window.ResizeObserver = original.ResizeObserver
      window.MutationObserver = original.MutationObserver
      window.addEventListener = original.add
      window.removeEventListener = original.remove
    }
  }
}
