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
  const frame = { style: {}, contentWindow: printWindow, remove: () => { removed = true } }
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
