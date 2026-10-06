/**
 * 验证纸张、水印和页边距的统一契约，以及真实便携文件、本地复制、历史和模板保存路径。
 * 页面是文档元信息；测试同时证明嵌套草稿隔离与正文撤销互不干扰，旧文档不补写新字段。
 */
import test from "node:test"
import assert from "node:assert/strict"
import "fake-indexeddb/auto"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { PAGE_SIZES, MARGIN_PRESETS, DEFAULT_WATERMARK, getPageDimensions, getPageContentDimensions, getMarginPresetId, validatePageSettings } from "../src/pages/editor/tools/page-settings.js"
import { createDocument, validateDocument, validatePage } from "../src/pages/editor/tools/document-schema.js"
import { createEditorStore } from "../src/pages/editor/tools/create-editor-store.js"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { saveLocalDocument, getLocalDocument, duplicateLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentVersion, getDocumentVersion, getDocumentVersions, restoreDocumentVersion, duplicateDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"
import { createDocumentTemplate, getDocumentTemplate, instantiateDocumentTemplate } from "../src/pages/editor/tools/document-template-repository.js"
import { stripTemplateComments } from "../src/pages/editor/tools/document-templates.js"

const makePage = (size = "A4", orientation = "portrait", watermark = DEFAULT_WATERMARK) => ({
  size, orientation, marginsMm: { top: 20, right: 20, bottom: 20, left: 20 }, watermark: structuredClone(watermark)
})
const pageWithWatermark = patch => makePage("A4", "portrait", { ...DEFAULT_WATERMARK, ...patch })

test("四种纸型与两个方向统一使用毫米尺寸，正文尺寸保留非对称边距", () => {
  const expected = { A3: [297, 420], A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4] }
  assert.deepEqual(Object.keys(PAGE_SIZES), Object.keys(expected))
  for (const [size, [width, height]] of Object.entries(expected)) {
    for (const orientation of ["portrait", "landscape"]) {
      const page = makePage(size, orientation)
      page.marginsMm = { top: 13, right: 17, bottom: 23, left: 29 }
      const original = structuredClone(page)
      const [widthMm, heightMm] = orientation === "portrait" ? [width, height] : [height, width]
      assert.deepEqual(getPageDimensions({ size, orientation }), { widthMm, heightMm })
      assert.deepEqual(getPageContentDimensions(page), { widthMm: widthMm - 46, heightMm: heightMm - 36 })
      assert.equal(validatePage(page), page)
      assert.deepEqual(page, original)
      assert.equal(validateDocument({ ...createDocument(), page }).page, page)
    }
  }
})

// 最大边距随纸型和方向变化，不能沿用 A4 固定阈值；恰好 40 mm 与轻微越界分别核对。
test("不同纸型横竖版都接受 40mm 正文边界，任一方向不足时拒绝", () => {
  for (const size of Object.keys(PAGE_SIZES)) {
    for (const orientation of ["portrait", "landscape"]) {
      const page = makePage(size, orientation)
      const { widthMm, heightMm } = getPageDimensions(page)
      page.marginsMm = { top: 0, right: 0, bottom: heightMm - 40, left: widthMm - 40 }
      assert.deepEqual(getPageContentDimensions(page), { widthMm: 40, heightMm: 40 })
      assert.throws(() => validatePageSettings({ ...page, marginsMm: { ...page.marginsMm, right: 0.01 } }), /页边距过大/)
      assert.throws(() => validatePageSettings({ ...page, marginsMm: { ...page.marginsMm, top: 0.01 } }), /页边距过大/)
    }
  }
})

test("纸型与方向必须是自有的严格枚举，未知字段和非 JSON 对象不能绕过校验", () => {
  const page = makePage()
  for (const size of ["A2", "a4", "__proto__", "constructor", 210, null, { toString: () => "A4" }]) {
    assert.throws(() => validatePageSettings({ ...page, size }), /纸张设置/)
  }
  for (const orientation of ["Portrait", "vertical", "", null, true]) {
    assert.throws(() => validatePageSettings({ ...page, orientation }), /纸张设置/)
  }
  for (const invalid of [null, [], new Date(), Object.create(page), { ...page, background: "url(javascript:alert(1))" },
    JSON.parse('{"size":"A4","orientation":"portrait","marginsMm":{"top":20,"right":20,"bottom":20,"left":20},"__proto__":{"polluted":true}}')]) {
    assert.throws(() => validatePageSettings(invalid))
  }
  assert.equal({}.polluted, undefined)
  const dictionary = Object.assign(Object.create(null), page)
  assert.equal(validatePageSettings(dictionary), dictionary)
  assert.throws(() => validatePageSettings({ ...page, [Symbol("unknown")]: 1 }), /未知字段/)
})

test("边距只接受完整四边有限非负数，数字字符串、溢出和活动字段都拒绝", () => {
  const page = makePage()
  for (const invalid of ["20", NaN, Infinity, -Infinity, -0.01, null, undefined, true, Number.MAX_VALUE]) {
    assert.throws(() => validatePageSettings({ ...page, marginsMm: { ...page.marginsMm, top: invalid } }))
  }
  const missing = { ...page.marginsMm }
  delete missing.left
  for (const marginsMm of [null, [], missing, Object.create(page.marginsMm), { ...page.marginsMm, style: "position:fixed" }]) {
    assert.throws(() => validatePageSettings({ ...page, marginsMm }), /页边距/)
  }
  assert.equal(validatePageSettings({ ...page, marginsMm: { top: 0, right: 0, bottom: 0, left: 0 } }).size, "A4")
})

test("水印范围包含端点和小数，文字按 Unicode 码点检查且验证不修改首尾空白", () => {
  for (const opacity of [0.05, 0.12, 0.5]) {
    for (const angle of [-90, -35.5, 0, 90]) {
      const page = pageWithWatermark({ text: "  草稿  ", opacity, angle, color: "#ABCDEF" })
      const original = structuredClone(page)
      assert.equal(validatePageSettings(page), page)
      assert.deepEqual(page, original)
    }
  }
  assert.doesNotThrow(() => validatePageSettings(pageWithWatermark({ text: "😀".repeat(80) })))
  assert.throws(() => validatePageSettings(pageWithWatermark({ text: "😀".repeat(81) })), /1–80/)
})

test("水印文字拒绝空白、多行和控制字符，不把普通文字解释成 HTML", () => {
  for (const text of [null, 42, "", "   ", "字".repeat(81), " ".repeat(100000) + "草稿", "甲\n乙", "甲\r乙", "甲\t乙", "甲\u0000乙", "甲\u0085乙", "甲\u2028乙", "甲\u2029乙"]) {
    assert.throws(() => validatePageSettings(pageWithWatermark({ text })), /水印文字/)
  }
  assert.doesNotThrow(() => validatePageSettings(pageWithWatermark({ text: "<script>仅是文字</script> & 草稿" })))
})

test("水印只允许四个字段、六位颜色和有限透明度角度，非法值不会进入文档", () => {
  const page = makePage()
  const missing = { ...DEFAULT_WATERMARK }
  delete missing.angle
  for (const watermark of [undefined, [], "草稿", missing, Object.create(DEFAULT_WATERMARK), { ...DEFAULT_WATERMARK, image: "javascript:alert(1)" }]) {
    assert.throws(() => validateDocument({ ...createDocument(), page: { ...page, watermark } }), /水印设置/)
  }
  for (const color of ["#fff", "#12345678", "red", "url(https://example.com)", "#12345g", " #123456", "#123456\n", 123456]) {
    assert.throws(() => validatePageSettings(pageWithWatermark({ color })), /水印颜色/)
  }
  for (const opacity of [0, 0.049, 0.501, "0.12", NaN, Infinity, null]) {
    assert.throws(() => validatePageSettings(pageWithWatermark({ opacity })), /透明度/)
  }
  for (const angle of [-90.001, 90.001, "-35", NaN, Infinity, null]) {
    assert.throws(() => validatePageSettings(pageWithWatermark({ angle })), /水印角度/)
  }
})

test("旧文档缺水印与显式 null 都合法，验证和新建互不补写共享默认值", () => {
  const document = createDocument()
  const original = structuredClone(document)
  assert.equal(Object.hasOwn(document.page, "watermark"), false)
  assert.equal(validateDocument(document), document)
  assert.deepEqual(document, original)
  assert.doesNotThrow(() => validateDocument({ ...document, page: { ...document.page, watermark: null } }))
  document.page.marginsMm.left = 30
  assert.equal(createDocument().page.marginsMm.left, 20)
})

test("边距预设只匹配完整同值四边，非对称或未知字段显示自定义", () => {
  assert.deepEqual(MARGIN_PRESETS.map(preset => preset.id), ["normal", "narrow", "wide"])
  for (const preset of MARGIN_PRESETS) assert.equal(getMarginPresetId(structuredClone(preset.marginsMm)), preset.id)
  for (const margins of [null, { top: 20 }, { top: 20, right: 20, bottom: 20, left: 21 },
    { top: 20, right: 20, bottom: 20, left: 20, extra: 1 }, { top: "20", right: 20, bottom: 20, left: 20 }]) {
    assert.equal(getMarginPresetId(margins), "custom")
  }
  assert.throws(() => { MARGIN_PRESETS[0].marginsMm.left = 99 }, TypeError)
  assert.throws(() => { DEFAULT_WATERMARK.text = "意外修改" }, TypeError)
})

test("页面会话提交深克隆草稿与来源，验证失败保持页面、序号和保存状态不变", () => {
  const document = { ...createDocument(), page: makePage("A3", "landscape") }
  const store = createEditorStore({ document, storageVersion: 1 })
  document.page.watermark.text = "修改来源"
  document.page.marginsMm.top = 31
  assert.equal(store.getState().page.watermark.text, "草稿")
  assert.equal(store.getState().page.marginsMm.top, 20)
  const draft = makePage("Letter", "portrait", { ...DEFAULT_WATERMARK, text: "内部资料" })
  store.getState().updatePage(draft)
  assert.equal(store.getState().revision, 1)
  assert.equal(store.getState().saveStatus, "dirty")
  draft.watermark.text = "关闭弹窗后继续改草稿"
  draft.marginsMm.left = 88
  assert.equal(store.getState().page.watermark.text, "内部资料")
  assert.equal(store.getState().page.marginsMm.left, 20)
  const before = store.getState()
  assert.throws(() => before.updatePage(pageWithWatermark({ opacity: 2 })), /透明度/)
  assert.equal(store.getState(), before)
})

// 使用真实编辑器撤销，避免仅检查 store 字段就误认为页面未进入正文历史。
test("修改页面不发送正文事务，随后 undo 只撤销文字且保留页面配置", () => {
  const DOM = new JSDOM("<!doctype html><html><body></body></html>")
  for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
  }
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = clearTimeout
  const source = createDocument()
  const store = createEditorStore({ document: source, storageVersion: 1 })
  const editor = new Editor({ element: document.createElement("div"), extensions: createExtensions(), content: source.content })
  try {
    editor.commands.insertContent("需要撤销的正文")
    let transactions = 0
    editor.on("transaction", () => { transactions += 1 })
    const page = makePage("A5", "landscape", { ...DEFAULT_WATERMARK, text: "保留的水印" })
    store.getState().updatePage(page)
    assert.equal(transactions, 0)
    assert.equal(editor.commands.undo(), true)
    assert.equal(editor.getText(), "")
    assert.deepEqual(store.getState().page, page)
  } finally {
    editor.destroy()
    DOM.window.close()
  }
})

test("便携文件保留各纸型和完整水印，旧文件缺字段不迁移且恶意水印拒绝导入", async () => {
  for (const page of [makePage("A3", "landscape"), makePage("A5"), makePage("Letter", "landscape", null), createDocument().page]) {
    const document = { ...createDocument(), page }
    const portable = await createPortableFile(document, new Map())
    const read = await readPortableFile(new File([JSON.stringify(portable)], "页面.mewoc.json"))
    assert.deepEqual(read.document.page, page)
    assert.equal(Object.hasOwn(read.document.page, "watermark"), Object.hasOwn(page, "watermark"))
    assert.notEqual(read.document.id, document.id)
  }
  const document = { ...createDocument(), page: makePage() }
  const portable = await createPortableFile(document, new Map())
  portable.document.page.watermark.opacity = 1
  await assert.rejects(() => readPortableFile(new File([JSON.stringify(portable)], "非法.mewoc.json")), /透明度/)
})

test("本地保存与复制完整保留页面，读取或副本的嵌套修改不影响已落盘来源", async () => {
  const document = { ...createDocument(), page: makePage("Letter", "landscape") }
  await saveLocalDocument(document, new Map(), 0)
  const expected = structuredClone(document.page)
  const read = await getLocalDocument(document.id)
  assert.deepEqual(read.document.page, expected)
  read.document.page.watermark.text = "只修改返回对象"
  const copy = await duplicateLocalDocument(document.id, 1)
  assert.deepEqual(copy.document.page, expected)
  copy.document.page.watermark.color = "#000000"
  copy.document.page.marginsMm.bottom = 35
  assert.deepEqual((await getLocalDocument(document.id)).document.page, expected)
  assert.deepEqual((await getLocalDocument(copy.id)).document.page, expected)
})

test("历史恢复、恢复前备份与历史副本保留各自纸型、边距、水印并隔离嵌套对象", async () => {
  const document = { ...createDocument(), page: makePage("A3", "landscape", { ...DEFAULT_WATERMARK, text: "原版" }) }
  const originalPage = structuredClone(document.page)
  await saveLocalDocument(document, new Map(), 0)
  const version = await createDocumentVersion(document.id, 1, "页面原版")
  version.document.page.watermark.text = "不能改变历史"
  assert.deepEqual((await getDocumentVersion(document.id, version.id)).version.document.page, originalPage)
  const updatedPage = makePage("A5", "portrait", { ...DEFAULT_WATERMARK, text: "恢复前", color: "#112233", opacity: 0.45, angle: 90 })
  updatedPage.marginsMm.left = 12.7
  await saveLocalDocument({ ...document, page: updatedPage }, new Map(), 1)
  const restored = await restoreDocumentVersion(document.id, version.id, 2)
  assert.deepEqual(restored.document.page, originalPage)
  const backup = (await getDocumentVersions(document.id)).find(item => item.reason === "before-restore")
  assert.deepEqual((await getDocumentVersion(document.id, backup.id)).version.document.page, updatedPage)
  const copy = await duplicateDocumentVersion(document.id, version.id, 3)
  assert.deepEqual(copy.document.page, originalPage)
  restored.document.page.watermark.text = "只是返回对象"
  copy.document.page.marginsMm.right = 33
  assert.deepEqual((await getLocalDocument(document.id)).document.page, originalPage)
  assert.deepEqual((await getLocalDocument(copy.id)).document.page, originalPage)
})

test("恢复旧历史时仍缺 watermark，恢复前的新水印完整保留在自动备份", async () => {
  const document = createDocument()
  await saveLocalDocument(document, new Map(), 0)
  const old = await createDocumentVersion(document.id, 1, "旧版")
  const page = makePage("Letter", "portrait")
  await saveLocalDocument({ ...document, page }, new Map(), 1)
  const restored = await restoreDocumentVersion(document.id, old.id, 2)
  assert.deepEqual(restored.document.page, document.page)
  assert.equal(Object.hasOwn(restored.document.page, "watermark"), false)
  const backup = (await getDocumentVersions(document.id)).find(item => item.reason === "before-restore")
  assert.deepEqual((await getDocumentVersion(document.id, backup.id)).version.document.page, page)
})

test("用户模板、实例和去批注副本完整深克隆页面，不改来源或模板快照", async () => {
  const document = { ...createDocument(), page: makePage("Letter", "landscape", { ...DEFAULT_WATERMARK, text: "模板资料" }) }
  document.page.marginsMm = { top: 12.7, right: 25.4, bottom: 13, left: 21 }
  const page = structuredClone(document.page)
  const cleaned = stripTemplateComments(document)
  cleaned.page.watermark.text = "局部草稿"
  assert.deepEqual(document.page, page)
  await saveLocalDocument(document, new Map(), 0)
  const metadata = await createDocumentTemplate(document.id, 1, "页面模板")
  const read = await getDocumentTemplate(metadata.id)
  assert.deepEqual(read.template.document.page, page)
  read.template.document.page.watermark.text = "不影响模板存储"
  const instance = await instantiateDocumentTemplate(metadata.id, 1)
  assert.deepEqual(instance.document.page, page)
  instance.document.page.marginsMm.top = 30
  instance.document.page.watermark.opacity = 0.3
  assert.deepEqual((await getDocumentTemplate(metadata.id)).template.document.page, page)
  assert.deepEqual((await getLocalDocument(instance.id)).document.page, page)
  assert.deepEqual((await getLocalDocument(document.id)).document.page, page)
})
