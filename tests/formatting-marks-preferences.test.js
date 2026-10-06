/** 验证格式标记只保存浏览器偏好：坏存储可继续使用，跨标签同步不触发正文保存。 */
import test from "node:test"
import assert from "node:assert/strict"
import { createDocument } from "../src/pages/editor/tools/document-schema.js"
import { createEditorStore } from "../src/pages/editor/tools/create-editor-store.js"
import { FORMATTING_MARKS_KEY, readFormattingMarks, saveFormattingMarks, startFormattingMarksSync } from "../src/pages/editor/tools/formatting-marks-preferences.js"

const createBrowser = () => {
  const values = new Map()
  const listeners = new Set()
  const browser = {
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    addEventListener: (name, listener) => { assert.equal(name, "storage"); listeners.add(listener) },
    removeEventListener: (name, listener) => { assert.equal(name, "storage"); listeners.delete(listener) }
  }
  const notify = (key, storageArea = browser.localStorage) => listeners.forEach(listener => listener({ key, storageArea }))
  return { browser, values, listeners, notify }
}

test("格式标记偏好只接受严格布尔值，重新读取沿用上次选择", () => {
  const { browser, values } = createBrowser()
  for (const raw of [null, "false", "1", "true ", "unexpected"]) {
    values.set(FORMATTING_MARKS_KEY, raw)
    assert.equal(readFormattingMarks(browser), false)
  }
  assert.equal(saveFormattingMarks(true, browser), true)
  assert.equal(readFormattingMarks(browser), true)
  assert.equal(saveFormattingMarks(false, browser), true)
  assert.equal(readFormattingMarks(browser), false)
  assert.equal(saveFormattingMarks("true", browser), false)
  assert.equal(values.get(FORMATTING_MARKS_KEY), "false")
})

test("隐私限制和配额失败不会阻止格式标记的本次视图选择", () => {
  const denied = { get localStorage() { throw new Error("SecurityError") } }
  assert.equal(readFormattingMarks(denied), false)
  assert.equal(saveFormattingMarks(true, denied), false)
  assert.equal(readFormattingMarks(undefined), false)
  const full = { localStorage: { getItem: () => "true", setItem: () => { throw new Error("QuotaExceededError") } } }
  assert.equal(readFormattingMarks(full), true)
  assert.equal(saveFormattingMarks(false, full), false)
})

test("格式标记跨标签同步及清除偏好不改变正文保存序号，卸载解除监听", () => {
  const { browser, values, listeners, notify } = createBrowser()
  const store = createEditorStore({ document: createDocument(), storageVersion: 1 })
  const before = store.getState()
  const stop = startFormattingMarksSync(store, browser)
  assert.equal(listeners.size, 1)
  values.set(FORMATTING_MARKS_KEY, "true")
  notify(FORMATTING_MARKS_KEY)
  assert.equal(store.getState().formattingMarks, true)
  assert.equal(store.getState().revision, before.revision)
  assert.equal(store.getState().saveStatus, "saved")
  values.set(FORMATTING_MARKS_KEY, "false")
  notify("mewoc.other")
  notify(FORMATTING_MARKS_KEY, {})
  assert.equal(store.getState().formattingMarks, true)
  values.clear()
  notify(null)
  assert.equal(store.getState().formattingMarks, false)
  stop()
  assert.equal(listeners.size, 0)
})
