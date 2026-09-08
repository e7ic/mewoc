import { SAVE_DELAY, MAX_SAVE_DELAY } from "../constants/editor-constants.js"

/**
 * 每个编辑会话独立持有一个保存队列，定时保存和手动保存共用同一条写入链路。
 * version 是数据库的乐观锁版本；savedRevision 是本会话已确认保存的编辑序号。
 * write(snapshot, version) 必须在存储事务提交后返回新的 storageVersion，失败则抛错。
 * flush 返回布尔结果，调用方据此决定能否切换文档；错误细节通过 onStatus 展示。
 */
export function createSaveCoordinator({ getSnapshot, getRevision, write, onStatus, baseVersion, initialRevision }) {
  let version = baseVersion
  let savedRevision = initialRevision
  let pending = null
  let disposed = false
  let delayTimer = null
  let maxTimer = null

  const clearTimers = () => {
    clearTimeout(delayTimer)
    clearTimeout(maxTimer)
    delayTimer = null
    maxTimer = null
  }

  const save = () => {
    if (disposed) return Promise.resolve(false)
    // 同时到来的保存请求复用在途 Promise，防止同一基础版本被并发写入。
    if (pending) return pending
    if (getRevision() === savedRevision) return Promise.resolve(true)
    clearTimers()
    const revision = getRevision()
    let succeeded = false
    onStatus({ status: "saving", savedRevision })
    // 快照创建也可能因资源缺失而失败，必须与实际写入采用相同的错误收口。
    pending = Promise.resolve().then(getSnapshot).then(snapshot => write(snapshot, version))
      .then(result => {
        version = result.storageVersion
        // 仅确认本轮捕获的编辑序号，等待写入期间产生的新输入仍需要下一轮保存。
        savedRevision = revision
        succeeded = true
        if (!disposed) onStatus({ status: getRevision() === revision ? "saved" : "dirty", savedRevision })
        return true
      })
      .catch(error => {
        if (!disposed) onStatus({ status: "error", savedRevision, error })
        return false
      })
      .finally(() => {
        pending = null
        if (!disposed && succeeded && getRevision() !== savedRevision) schedule()
      })
    return pending
  }

  const schedule = () => {
    if (disposed) return
    clearTimeout(delayTimer)
    delayTimer = setTimeout(save, SAVE_DELAY)
    // 停顿计时随输入重置，最长等待计时只启动一次，避免连续输入一直推迟保存。
    if (!maxTimer) maxTimer = setTimeout(save, MAX_SAVE_DELAY)
  }

  const flush = async () => {
    clearTimers()
    // 等待当前写入后继续检查新编辑；只等待一次 pending 会漏掉写入期间的修改。
    // 失败立即返回，避免冲突或配额不足时不断重试。
    while (!disposed && getRevision() !== savedRevision) {
      if (!await save()) return false
    }
    return !disposed
  }

  return {
    schedule,
    flush,
    dispose() {
      // 已提交给存储层的操作仍可能完成；销毁只停止调度和向旧会话回报状态。
      disposed = true
      clearTimers()
    }
  }
}
