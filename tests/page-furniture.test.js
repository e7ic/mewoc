/**
 * 页眉页脚作为页面元信息，契约、宽度/边距约束与真实持久化路径共同验证。
 * 不通过仅镜像 UI 的快照证明保存；便携文件、历史恢复、模板实例均重新读取落盘数据。
 */
import test from "node:test"
import assert from "node:assert/strict"
import "fake-indexeddb/auto"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { validatePageSettings } from "../src/pages/editor/tools/page-settings.js"
import { DEFAULT_PAGE_FURNITURE, getPageFurnitureFontPt, getPageFurnitureText, isPageFurnitureActive, validatePageFurniture } from "../src/pages/editor/tools/page-furniture.js"
import { createEditorStore } from "../src/pages/editor/tools/create-editor-store.js"
import { getPreviewPage } from "../src/pages/editor/tools/page-preview.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { saveLocalDocument, getLocalDocument, duplicateLocalDocument } from "../src/pages/editor/tools/local-repository.js"
import { createDocumentVersion, getDocumentVersion, restoreDocumentVersion } from "../src/pages/editor/tools/document-history-repository.js"
import { createDocumentTemplate, getDocumentTemplate, instantiateDocumentTemplate } from "../src/pages/editor/tools/document-template-repository.js"

const furniture = patch => ({ ...DEFAULT_PAGE_FURNITURE, ...patch })
const page = patch => ({ ...createDocument().page, ...patch })
const complete = () => page({
  header: furniture({ text: "内部资料", alignment: "left" }),
  footer: furniture({ text: "归档", alignment: "right", pageNumber: "page-total" })
})

test("缺省、null 与空白对象不激活页眉页脚，旧文档保持原有字段形状", () => {
  const old = createDocument()
  const original = structuredClone(old)
  assert.equal(validateDocument(old), old)
  assert.deepEqual(old, original)
  assert.equal(Object.hasOwn(old.page, "header"), false)
  assert.equal(Object.hasOwn(old.page, "footer"), false)
  assert.throws(() => { DEFAULT_PAGE_FURNITURE.text = "修改" }, TypeError)
  assert.equal(isPageFurnitureActive(null), false)
  assert.equal(isPageFurnitureActive(furniture({ text: "  " })), false)
  assert.equal(isPageFurnitureActive(furniture({ pageNumber: "page" })), true)
  assert.doesNotThrow(() => validatePageSettings(page({ marginsMm: { top: 0, right: 20, bottom: 0, left: 20 }, header: null, footer: furniture({ text: "  " }) })))
})

test("完整 JSON 契约拒绝未知字段、枚举、控制字符和非普通对象", () => {
  for (const invalid of [undefined, [], new Date(), "文字", { text: "完整字段不足" }, Object.create(DEFAULT_PAGE_FURNITURE),
    furniture({ unknown: true }), furniture({ [Symbol("活动字段")]: true }), furniture({ alignment: "justify" }), furniture({ pageNumber: "PAGE" })]) {
    assert.throws(() => validatePageFurniture(invalid), /设置|对齐|页码/)
  }
  const accessor = furniture()
  Object.defineProperty(accessor, "text", { get: () => "不要读取", enumerable: true })
  assert.throws(() => validatePageFurniture(accessor), /设置/)
  const hidden = furniture()
  Object.defineProperty(hidden, "text", { value: "隐藏", enumerable: false })
  assert.throws(() => validatePageFurniture(hidden), /设置/)
  for (const text of [null, 20, "甲\n乙", "甲\t乙", "甲\u0000乙", "甲\u0085乙", "甲\u2028乙", "甲\u2029乙", "甲\ud800乙", "甲\udfff乙", "字".repeat(81)]) {
    assert.throws(() => validatePageFurniture(furniture({ text })), /单行文字/)
  }
  const dictionary = Object.assign(Object.create(null), furniture({ text: "<script>只是普通文字</script>" }))
  assert.equal(validatePageFurniture(dictionary), dictionary)
})

test("80 个 Unicode 码点含代理对均允许，验证不修剪原值且页码占位不虚构总页数", () => {
  const source = furniture({ text: "  标题  ", pageNumber: "page-total" })
  const original = structuredClone(source)
  assert.equal(validatePageFurniture(source), source)
  assert.deepEqual(source, original)
  assert.doesNotThrow(() => validatePageFurniture(furniture({ text: "😀".repeat(80) })))
  assert.throws(() => validatePageFurniture(furniture({ text: "😀".repeat(81) })), /80/)
  assert.equal(getPageFurnitureText(source), "标题 · 第 1 / … 页")
  assert.equal(getPageFurnitureText(furniture({ pageNumber: "page" })), "第 1 页")
  assert.equal(getPageFurnitureText(furniture({ text: "正文外" })), "正文外")
  assert.equal(getPageFurnitureText(source, { pageNumber: "99999", pageTotal: "99999" }), "标题 · 第 99999 / 99999 页")
})

test("激活端至少保留对应 12mm 边距，未激活端和另一端不受误限制", () => {
  const header = furniture({ text: "页眉" })
  const footer = furniture({ pageNumber: "page-total" })
  assert.doesNotThrow(() => validatePageSettings(page({ header, marginsMm: { top: 12, right: 20, bottom: 0, left: 20 } })))
  assert.doesNotThrow(() => validatePageSettings(page({ footer, marginsMm: { top: 0, right: 20, bottom: 12, left: 20 } })))
  assert.throws(() => validatePageSettings(page({ header, marginsMm: { top: 11.99, right: 20, bottom: 20, left: 20 } })), /页眉.*12/)
  assert.throws(() => validatePageSettings(page({ footer, marginsMm: { top: 20, right: 20, bottom: 11.99, left: 20 } })), /页脚.*12/)
})

test("按真正纸型方向和正文宽度估算 6–9pt，宽 ASCII 与最长页码同样预算且 Word 半磅一致", () => {
  const long = furniture({ text: "W".repeat(60) })
  assert.equal(getPageFurnitureFontPt(page(), furniture({ text: "短标题" })), 9)
  const fitting = getPageFurnitureFontPt(page(), long)
  assert.equal(fitting, 7.5)
  assert.equal(fitting * 2, Math.round(fitting * 2))
  assert.throws(() => validatePageSettings(page({ size: "A5", header: long })), /缩短文字|增加正文宽度/)
  assert.doesNotThrow(() => validatePageSettings(page({ size: "A5", orientation: "landscape", header: long })))
  assert.throws(() => validatePageSettings(page({ header: furniture({ text: "字".repeat(80), pageNumber: "page-total" }) })), /缩短文字/)
  assert.doesNotThrow(() => validatePageSettings(page({ size: "A3", header: furniture({ text: "字".repeat(80), pageNumber: "page-total" }) })))
  const narrow = page({ marginsMm: { top: 20, right: 85, bottom: 20, left: 85 }, footer: furniture({ pageNumber: "page-total" }) })
  assert.doesNotThrow(() => validatePageSettings(narrow))
  assert.equal(getPageFurnitureFontPt(narrow, narrow.footer), 6)
  for (const text of ["‱".repeat(44)]) {
    assert.throws(() => validatePageSettings(page({ header: furniture({ text }) })), /缩短文字/)
    assert.doesNotThrow(() => validatePageSettings(page({ size: "A3", header: furniture({ text }) })))
  }
  // ﷻ/ﷺ 等兼容合字可能展开成完整词组，不能仍仅按两个普通字宽放行。
  assert.throws(() => validatePageSettings(page({ size: "A3", header: furniture({ text: "ﷺ".repeat(44) }) })), /缩短文字/)
  assert.doesNotThrow(() => validatePageSettings(page({ header: furniture({ text: "ﷺ" }) })))
})

test("页面 store 深克隆页眉页脚，非法宽度修改不产生修订", () => {
  const source = { ...createDocument(), page: complete() }
  const store = createEditorStore({ document: source, storageVersion: 1 })
  source.page.header.text = "外部改动"
  assert.equal(store.getState().page.header.text, "内部资料")
  const next = complete()
  next.header.text = "新页眉"
  store.getState().updatePage(next)
  next.footer.text = "已关闭的草稿"
  assert.equal(store.getState().page.footer.text, "归档")
  assert.equal(store.getState().revision, 1)
  const before = store.getState()
  assert.throws(() => before.updatePage({ ...complete(), header: furniture({ text: "字".repeat(80), pageNumber: "page-total" }) }), /缩短文字/)
  assert.equal(store.getState(), before)
})

test("便携导入、本地副本重新落盘保留页眉页脚，旧文件不补字段", async () => {
  for (const value of [complete(), page(), page({ header: null, footer: furniture() })]) {
    const source = { ...createDocument(), page: value }
    const portable = await createPortableFile(source, new Map())
    const read = await readPortableFile(new File([JSON.stringify(portable)], "页眉页脚.mewoc.json"))
    assert.deepEqual(read.document.page, value)
    await saveLocalDocument(source, new Map(), 0)
    const duplicate = await duplicateLocalDocument(source.id, 1)
    assert.deepEqual((await getLocalDocument(duplicate.id)).document.page, value)
    if (read.document.page.header) read.document.page.header.text = "修改读取对象"
    assert.deepEqual((await getLocalDocument(source.id)).document.page, value)
  }
})

test("历史恢复与模板实例完整保存装饰元信息，预览描述只使用快照而不混入正文", async () => {
  const source = { ...createDocument(), page: complete() }
  await saveLocalDocument(source, new Map(), 0)
  const history = await createDocumentVersion(source.id, 1, "页眉页脚检查点")
  const template = await createDocumentTemplate(source.id, 1, "页眉页脚模板")
  await saveLocalDocument({ ...source, page: page({ header: null, footer: null }) }, new Map(), 1)
  const restored = await restoreDocumentVersion(source.id, history.id, 2)
  const instance = await instantiateDocumentTemplate(template.id, 1)
  for (const record of [restored, instance]) assert.deepEqual(record.document.page, source.page)
  instance.document.page.footer.text = "修改实例快照"
  assert.deepEqual((await getDocumentTemplate(template.id)).template.document.page, source.page)
  assert.deepEqual((await getDocumentVersion(source.id, history.id)).version.document.page, source.page)
  assert.match(getPreviewPage(source.page).description, /页眉：内部资料.*页脚：归档 · 第 1 \/ … 页/)
  assert.equal(JSON.stringify(source.content).includes("内部资料"), false)
})
