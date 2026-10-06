/**
 * 验证保存协调器对编辑 revision 和持久 storageVersion 的独立确认规则。
 * 受控写入 Promise 制造保存中继续输入、失败重试和会话结束竞态，确认写入串行且 UI 不接收旧响应。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createSaveCoordinator } from "../src/pages/editor/tools/save-coordinator.js"

// 手动完成第一笔写入前增加编辑序号，第二笔必须基于第一笔提交版本而不是并发复用旧锁。
test("保存期间继续输入时，旧响应不会确认新版本；后续写入串行", async () => {
  let revision = 1
  const writes = []
  const statuses = []
  const coordinator = createSaveCoordinator({
    getSnapshot: () => ({ revision }),
    getRevision: () => revision,
    write: (snapshot, baseVersion) => new Promise(resolve => writes.push({ snapshot, baseVersion, resolve })),
    onStatus: status => statuses.push(status),
    baseVersion: 0,
    initialRevision: 0
  })
  const flushing = coordinator.flush()
  await new Promise(resolve => setImmediate(resolve))
  revision = 2
  coordinator.schedule()
  // 第一笔成功只能确认它捕获的 revision 1；后续 dirty 状态与第二笔快照共同证明新输入尚未被误标已保存。
  writes[0].resolve({ storageVersion: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes.length, 2)
  assert.equal(writes[0].snapshot.revision, 1)
  assert.equal(writes[1].snapshot.revision, 2)
  assert.equal(writes[1].baseVersion, 1)
  assert.ok(statuses.some(status => status.status === "dirty" && status.savedRevision === 1))
  writes[1].resolve({ storageVersion: 2 })
  assert.equal(await flushing, true)
  assert.equal(statuses.at(-1).savedRevision, 2)
  coordinator.dispose()
})

// 存储失败没有提交新版本，下一次重试仍必须用旧锁，同时 savedRevision 不能前进。
test("失败不显示已保存，重试使用原始存储版本", async () => {
  let fail = true
  let status
  const versions = []
  const coordinator = createSaveCoordinator({
    getSnapshot: () => ({ title: "仍在编辑" }),
    getRevision: () => 1,
    write: async (_, version) => {
      versions.push(version)
      if (fail) throw new Error("磁盘已满")
      return { storageVersion: version + 1 }
    },
    onStatus: next => { status = next },
    baseVersion: 4,
    initialRevision: 0
  })
  assert.equal(await coordinator.flush(), false)
  assert.equal(status.status, "error")
  assert.equal(status.savedRevision, 0)
  fail = false
  assert.equal(await coordinator.flush(), true)
  assert.deepEqual(versions, [4, 4])
  coordinator.dispose()
})

// 销毁不取消已交给存储的 Promise，只停止回报；主动放行迟到成功，确保不会写回旧会话状态。
test("会话结束后，迟到响应不再更新 UI", async () => {
  let finish
  const statuses = []
  const coordinator = createSaveCoordinator({
    getSnapshot: () => ({}),
    getRevision: () => 1,
    write: () => new Promise(resolve => { finish = resolve }),
    onStatus: status => statuses.push(status),
    baseVersion: 0,
    initialRevision: 0
  })
  const saving = coordinator.flush()
  await new Promise(resolve => setImmediate(resolve))
  coordinator.dispose()
  finish({ storageVersion: 1 })
  assert.equal(await saving, false)
  assert.deepEqual(statuses.map(status => status.status), ["saving"])
})
