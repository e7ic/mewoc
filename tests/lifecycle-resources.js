export function observeSessionResources() {
  const urls = new Set()
  const observers = new Set()
  const listeners = new Map(["beforeunload", "mousemove", "mouseup", "blur"].map(type => [type, new Set()]))
  const original = {
    create: URL.createObjectURL, revoke: URL.revokeObjectURL, ResizeObserver: window.ResizeObserver,
    add: window.addEventListener, remove: window.removeEventListener
  }
  let createdUrls = 0
  let peakUrls = 0
  let peakObservers = 0
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
      urls: urls.size, observers: observers.size,
      listeners: [...listeners.values()].reduce((total, entries) => total + entries.size, 0),
      listenerDetails: [...listeners].flatMap(([type, entries]) => [...entries].map(listener => `${type}:${listener.name || "anonymous"}`)),
      createdUrls, peakUrls, peakObservers
    }),
    restore() {
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
      window.ResizeObserver = original.ResizeObserver
      window.addEventListener = original.add
      window.removeEventListener = original.remove
    }
  }
}
