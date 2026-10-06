/**
 * 把自动保存和显式 flush 合并为单会话串行写入队列。
 * 输入停顿计时与最长等待计时共同安排保存；只在写入提交成功后更新存储版本和已保存编辑序号。
 */
import { SAVE_DELAY, MAX_SAVE_DELAY } from "../constants/editor-constants.js"

/**
 * 每个编辑会话独立持有一个保存队列，定时保存和手动保存共用同一条写入链路。
 * version 是数据库的乐观锁版本；savedRevision 是本会话已确认保存的编辑序号。
 * write(snapshot, version) 必须在存储事务提交后返回新的 storageVersion，失败则抛错。
 * flush 返回布尔结果，调用方据此决定能否切换文档；错误细节通过 onStatus 展示。
 */
export function createSaveCoordinator({ getSnapshot, getRevision, write, onStatus, baseVersion, initialRevision }) {
  // version 是已提交记录的乐观锁，savedRevision 是本会话编辑进度；两者独立，不能互相替代。
  // pending 保存唯一在途请求，disposed 只停止会话回报/调度，不取消已经交给存储层的事务。
  let version = baseVersion
  let savedRevision = initialRevision
  let pending = null
  let disposed = false
  let delayTimer = null
  let maxTimer = null

  // 两种调度计时一起清理，开始真实保存、flush 或销毁时都复用，避免重复触发同一次写入。
  const clearTimers = () => {
    clearTimeout(delayTimer)
    clearTimeout(maxTimer)
    delayTimer = null
    maxTimer = null
  }

  // 没变化直接成功，有在途写入复用其 Promise；新保存先捕获本轮 revision，再异步创建快照并写入。
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
      // 快照生成或存储提交任一失败都保持旧确认版本，报告失败并返回 false，交给用户重试或备份。
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

  // 每次编辑重置停顿保存；最长等待只针对这轮未保存输入设一次，连续打字仍会定期落盘。
  const schedule = () => {
    if (disposed) return
    clearTimeout(delayTimer)
    delayTimer = setTimeout(save, SAVE_DELAY)
    // 停顿计时随输入重置，最长等待计时只启动一次，避免连续输入一直推迟保存。
    if (!maxTimer) maxTimer = setTimeout(save, MAX_SAVE_DELAY)
  }

  // 切换文档前排空所有已出现编辑，包含等待当前写入期间新增的变更；失败立即停止继续写入。
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
    // 文档库修改当前记录前需比对已提交版本；编辑 revision 不能代替存储版本。
    getVersion: () => version,
    dispose() {
      // 已提交给存储层的操作仍可能完成；销毁只停止调度和向旧会话回报状态。
      disposed = true
      clearTimers()
    }
  }
}
