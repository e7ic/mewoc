import test from "node:test"
import assert from "node:assert/strict"
import { printDocument } from "../src/pages/editor/tools/print-document.js"

function createPrintFixture() {
  let finishFonts
  let printCount = 0
  let removed = false
  const printWindow = new EventTarget()
  printWindow.document = { fonts: { ready: new Promise(resolve => { finishFonts = resolve }) }, images: [] }
  printWindow.focus = () => undefined
  printWindow.print = () => { printCount += 1 }
  const frame = {
    style: {},
    get contentWindow() {
      if (removed) throw new DOMException("The object can not be found here.", "NotFoundError")
      return printWindow
    },
    remove: () => { removed = true }
  }
  // 仅模拟 iframe 资源等待与生命周期，不能作为原生打印排版验收。
  globalThis.document = { createElement: () => frame, body: { append: () => { queueMicrotask(() => frame.onload?.()) } } }
  return { finishFonts, printWindow, getPrintCount: () => printCount, isRemoved: () => removed }
}

test("打印等待资源期间会话结束：立即释放 iframe，迟到资源不再触发打印", async () => {
  const fixture = createPrintFixture()
  const controller = new AbortController()
  const pending = printDocument("<p>打印</p>", controller.signal)
  await Promise.resolve()
  controller.abort()
  await assert.rejects(pending, error => error.name === "AbortError")
  assert.equal(fixture.isRemoved(), true)
  fixture.finishFonts()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(fixture.getPrintCount(), 0)
})

test("打印只在资源就绪后调用，afterprint 释放 iframe", async () => {
  const fixture = createPrintFixture()
  const cleanup = printDocument("<p>打印</p>")
  await Promise.resolve()
  assert.equal(fixture.getPrintCount(), 0)
  fixture.finishFonts()
  await cleanup
  assert.equal(fixture.getPrintCount(), 1)
  fixture.printWindow.dispatchEvent(new Event("afterprint"))
  assert.equal(fixture.isRemoved(), true)
})

test("系统打印窗口停留超过一分钟仍保留输出，关闭后重复清理不访问失效窗口", async context => {
  const timers = new Map()
  let nextTimer = 0
  context.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const id = ++nextTimer
    timers.set(id, { callback, delay })
    return id
  })
  context.mock.method(globalThis, "clearTimeout", id => timers.delete(id))
  const fixture = createPrintFixture()
  const pending = printDocument("<p>等待用户选择打印选项</p>")
  await Promise.resolve()
  fixture.finishFonts()
  const cleanup = await pending
  // 只推进时间，不伪造 afterprint；打印窗口仍可能在等待用户选择位置或纸张。
  for (const [id, timer] of timers) {
    if (timer.delay <= 61000) {
      timers.delete(id)
      timer.callback()
    }
  }
  assert.equal(fixture.isRemoved(), false)
  fixture.printWindow.dispatchEvent(new Event("afterprint"))
  assert.equal(fixture.isRemoved(), true)
  assert.doesNotThrow(cleanup)
})

test("浏览器未发送 afterprint 时由会话清理释放，清理可重复调用", async () => {
  const fixture = createPrintFixture()
  const pending = printDocument("<p>会话负责回收</p>")
  await Promise.resolve()
  fixture.finishFonts()
  const cleanup = await pending
  assert.equal(fixture.isRemoved(), false)
  cleanup()
  assert.equal(fixture.isRemoved(), true)
  assert.doesNotThrow(cleanup)
})
