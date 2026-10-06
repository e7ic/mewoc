/**
 * 验证工具栏布局偏好的白名单、持久恢复及存储受限时的容错。
 * 读取失败回退完整模式，写入失败返回 false，非法选择不得覆盖已有合法偏好。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readToolbarMode, saveToolbarMode, TOOLBAR_MODE_KEY } from "../src/pages/editor/tools/toolbar-preferences.js"

// 先放入旧的未知模式再保存合法模式，最后尝试非法写入，确认回退和写保护不会污染已保存偏好。
test("工具栏偏好只接受已知模式，重开时恢复选择", () => {
  const values = new Map([[TOOLBAR_MODE_KEY, "obsolete-mode"]])
  const browser = { localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } }
  assert.equal(readToolbarMode(browser), "ribbon")
  assert.equal(saveToolbarMode("compact", browser), true)
  assert.equal(readToolbarMode(browser), "compact")
  assert.equal(saveToolbarMode("invalid", browser), false)
  assert.equal(readToolbarMode(browser), "compact")
})

// 分别模拟 getter 直接抛错和 setItem 写入失败，覆盖隐私/权限限制与配额问题两种进入点。
test("浏览器存储访问或写入受限时，工具栏初始化与模式切换不抛异常", () => {
  const browser = { get localStorage() { throw new Error("SecurityError") } }
  assert.equal(readToolbarMode(browser), "ribbon")
  assert.equal(saveToolbarMode("compact", browser), false)
  const fullStorage = { localStorage: { getItem: () => "compact", setItem: () => { throw new Error("QuotaExceededError") } } }
  assert.equal(readToolbarMode(fullStorage), "compact")
  assert.equal(saveToolbarMode("ribbon", fullStorage), false)
})
