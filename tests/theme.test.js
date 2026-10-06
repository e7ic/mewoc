/**
 * 验证主题偏好、生效主题、系统事件、跨标签页存储事件和监听清理的分离。
 * 存储失败不阻断本页主题选择，重试清除错误；其他键或 sessionStorage 不得误影响当前主题。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createThemeStore, getEffectiveTheme, startThemeSync, THEME_KEY } from "../src/pages/editor/tools/create-theme-store.js"

// 用可观察监听集合模拟 localStorage 与 matchMedia，事件触发和底层值变化分别受控，可核对卸载是否完全清理。
const createBrowser = (preference = null, dark = false) => {
  const values = new Map(preference === null ? [] : [[THEME_KEY, preference]])
  const mediaListeners = new Set()
  const storageListeners = new Set()
  const media = {
    matches: dark,
    addEventListener: (name, listener) => mediaListeners.add(listener),
    removeEventListener: (name, listener) => mediaListeners.delete(listener)
  }
  const browser = {
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    matchMedia: () => media,
    addEventListener: (name, listener) => storageListeners.add(listener),
    removeEventListener: (name, listener) => storageListeners.delete(listener)
  }
  return {
    browser, values, mediaListeners, storageListeners,
    // 先更新系统查询结果再通知监听，模拟用户切换系统颜色后重新挂载也能读到最新值。
    changeSystem: matches => {
      media.matches = matches
      mediaListeners.forEach(listener => listener({ matches }))
    },
    // 模拟写入、删除和 clear 的 storage 事件，并允许替换 storageArea，验证同名 sessionStorage 事件被忽略。
    changeStorage: (key, value, area = browser.localStorage) => {
      if (key === null) values.clear()
      else if (value === null) values.delete(key)
      else values.set(key, value)
      storageListeners.forEach(listener => listener({ key, storageArea: area }))
    }
  }
}

test("无偏好和非法偏好跟随系统，合法选择保存并可重新读取", () => {
  for (const preference of [null, "unexpected", "system"]) {
    const { browser } = createBrowser(preference, true)
    const store = createThemeStore(browser)
    assert.equal(getEffectiveTheme(store.getState()), "dark")
    assert.equal(store.getState().preference, "system")
  }
  const { browser, values } = createBrowser()
  const store = createThemeStore(browser)
  assert.equal(store.getState().setTheme("dark"), true)
  assert.equal(values.get(THEME_KEY), "dark")
  assert.equal(createThemeStore(browser).getState().preference, "dark")
  assert.equal(store.getState().setTheme("invalid"), false)
  assert.equal(values.get(THEME_KEY), "dark")
})

test("系统变化只影响跟随系统，返回跟随系统立即使用当前值", () => {
  const fixture = createBrowser()
  const store = createThemeStore(fixture.browser)
  const cleanup = startThemeSync(store, fixture.browser)
  try {
    fixture.changeSystem(true)
    assert.equal(getEffectiveTheme(store.getState()), "dark")
    store.getState().setTheme("light")
    fixture.changeSystem(false)
    fixture.changeSystem(true)
    assert.equal(getEffectiveTheme(store.getState()), "light")
    store.getState().setTheme("system")
    assert.equal(getEffectiveTheme(store.getState()), "dark")
  } finally {
    cleanup()
  }
})

test("跨页设置、删除和清空同步，其他键及 sessionStorage 不影响主题", () => {
  const fixture = createBrowser("dark")
  const store = createThemeStore(fixture.browser)
  const cleanup = startThemeSync(store, fixture.browser)
  try {
    fixture.changeStorage("other", "light")
    assert.equal(store.getState().preference, "dark")
    fixture.changeStorage(THEME_KEY, "light", {})
    assert.equal(store.getState().preference, "dark")
    fixture.changeStorage(THEME_KEY, "light")
    assert.equal(store.getState().preference, "light")
    fixture.changeStorage(THEME_KEY, null)
    assert.equal(store.getState().preference, "system")
    fixture.changeStorage(THEME_KEY, "dark")
    fixture.changeStorage(null)
    assert.equal(store.getState().preference, "system")
    assert.equal(getEffectiveTheme(store.getState()), "light")
  } finally {
    cleanup()
  }
})

// 分别制造读和写故障，检查当前生效主题与持久错误回显，避免把存储失败误处理成无法使用主题。
test("存储读写异常不阻断本页主题，重试成功清除错误", () => {
  const { browser } = createBrowser()
  const storage = browser.localStorage
  Object.defineProperty(browser, "localStorage", { configurable: true, get: () => { throw new Error("blocked") } })
  const store = createThemeStore(browser)
  assert.equal(store.getState().preference, "system")
  assert.match(store.getState().error, /读取/)
  assert.equal(store.getState().setTheme("dark"), true)
  assert.equal(getEffectiveTheme(store.getState()), "dark")
  assert.match(store.getState().error, /未能保存/)
  Object.defineProperty(browser, "localStorage", { value: storage, configurable: true })
  store.getState().setTheme("dark")
  assert.equal(store.getState().error, "")
  assert.equal(storage.getItem(THEME_KEY), "dark")
})

// 卸载后检查集合为空，再在无监听期间改变系统并挂载，覆盖初始同步的遗漏窗口。
test("卸载移除全部监听，重新挂载读取最新系统状态", () => {
  const fixture = createBrowser()
  const store = createThemeStore(fixture.browser)
  const cleanup = startThemeSync(store, fixture.browser)
  assert.equal(fixture.mediaListeners.size, 1)
  assert.equal(fixture.storageListeners.size, 1)
  cleanup()
  assert.equal(fixture.mediaListeners.size, 0)
  assert.equal(fixture.storageListeners.size, 0)
  fixture.changeSystem(true)
  assert.equal(getEffectiveTheme(store.getState()), "light")
  const nextCleanup = startThemeSync(store, fixture.browser)
  assert.equal(getEffectiveTheme(store.getState()), "dark")
  nextCleanup()
  assert.equal(fixture.mediaListeners.size + fixture.storageListeners.size, 0)
})
