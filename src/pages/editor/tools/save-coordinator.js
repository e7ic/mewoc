import { SAVE_DELAY, MAX_SAVE_DELAY } from "../constants/editor-constants.js"

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
    if (!maxTimer) maxTimer = setTimeout(save, MAX_SAVE_DELAY)
  }

  const flush = async () => {
    clearTimers()
    while (!disposed && getRevision() !== savedRevision) {
      if (!await save()) return false
    }
    return !disposed
  }

  return {
    schedule,
    flush,
    dispose() {
      disposed = true
      clearTimers()
    }
  }
}
