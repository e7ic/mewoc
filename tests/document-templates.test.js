/**
 * 验证内置模板固定身份、合法结构、元信息列表和深克隆隔离。
 * 模板化的批注清理只移除根线程与定位 marks，普通内容、格式、资源和可变属性必须原样保留。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { getBuiltinDocumentTemplates, getBuiltinDocumentTemplate, stripTemplateComments } from "../src/pages/editor/tools/document-templates.js"

test("三份内置模板都有固定身份、合法可编辑结构和纯 metadata", () => {
  const templates = getBuiltinDocumentTemplates()
  assert.deepEqual(templates.map(item => item.name), ["会议纪要", "项目周报", "工作报告"])
  for (const metadata of templates) {
    assert.equal(metadata.builtin, true)
    assert.equal(metadata.storageVersion, 0)
    assert.equal(Object.hasOwn(metadata, "document"), false)
    const template = getBuiltinDocumentTemplate(metadata.id)
    assert.equal(template.document.id, template.id)
    assert.equal(template.document.title, template.name)
    assert.equal(template.document.assets.length, 0)
    assert.equal(validateDocument(template.document), template.document)
    for (const type of ["heading", "paragraph", "bulletList", "table"]) {
      assert.equal(template.document.content.content.some(node => node.type === type), true)
    }
  }
})

// 主动修改返回对象后重新读取，检出浅克隆遗漏的嵌套共享，保护后续新建文档的模板来源。
test("内置读取交付独立克隆，修改正文/列表不会改变模板定义", () => {
  const metadata = getBuiltinDocumentTemplates()
  const id = metadata[0].id
  const original = getBuiltinDocumentTemplate(id)
  metadata[0].name = "意外修改"
  const candidate = getBuiltinDocumentTemplate(id)
  candidate.document.content.content[0].content[0].text = "改动"
  candidate.document.page.marginsMm.left = 30
  assert.deepEqual(getBuiltinDocumentTemplate(id), original)
  assert.equal(getBuiltinDocumentTemplates()[0].name, original.name)
  assert.equal(getBuiltinDocumentTemplate("missing-template"), null)
})

// 把批注放进多层内容验证递归清理，同时对原对象与非批注字段比对，避免 HTML 重解析带来的格式损失。
test("纯 JSON 去批注递归清除锚点与线程，保留文字、其他属性、格式及资源", () => {
  const document = createDocument()
  document.content = {
    type: "doc", attrs: { commentThreads: [{ id: "old-comment" }], future: "保留的属性" },
    content: [{ type: "blockquote", attrs: { future: 7 }, content: [{ type: "paragraph", attrs: { textAlign: "center", leftIndent: 2 }, content: [
      { type: "text", text: "带意见的正文", marks: [{ type: "bold" }, { type: "commentAnchor", attrs: { id: "old-comment" } }, { type: "link", attrs: { href: "https://example.com" } }] }
    ] }] }, { type: "image", attrs: { assetId: "image-1", width: 120 }, marks: [{ type: "commentAnchor", attrs: { id: "old-comment" } }] }]
  }
  document.assets = [{ id: "image-1", kind: "image", byteLength: 8, mimeType: "image/png", fileName: "图片.png" }]
  const original = structuredClone(document)
  const clean = stripTemplateComments(document)
  assert.deepEqual(document, original)
  assert.deepEqual(clean.content.attrs, { future: "保留的属性" })
  const text = clean.content.content[0].content[0].content[0]
  assert.deepEqual(text.marks, [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }])
  assert.equal(text.text, "带意见的正文")
  assert.deepEqual(clean.content.content[0].attrs, { future: 7 })
  assert.deepEqual(clean.content.content[0].content[0].attrs, { textAlign: "center", leftIndent: 2 })
  assert.deepEqual(clean.content.content[1].attrs, document.content.content[1].attrs)
  assert.deepEqual(clean.assets, document.assets)
  assert.deepEqual(clean.page, document.page)
})

test("无批注的文档内容及无 marks 节点完全保留，去批注不共享可变属性", () => {
  const original = getBuiltinDocumentTemplate("builtin-template-report").document
  const clean = stripTemplateComments(original)
  assert.deepEqual(clean, original)
  clean.page.marginsMm.left = 33
  clean.content.content[0].attrs.level = 2
  assert.notEqual(original.page.marginsMm.left, 33)
  assert.equal(original.content.content[0].attrs.level, 1)
})
