/** 图表精细设置的剪贴板回归：内部 HTML 保留业务属性，外部未知 CSS 和资源引用按白名单清理。 */
import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { Editor } from "@tiptap/core"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"

// JSDOM 驱动序列化、CSSOM 读取和 schema 重新解析；真实浏览器另验完整样式往返。
const DOM = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: DOM.window[key], configurable: true, writable: true })
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
// 仅开放一个当前会话图片 ID，外部地址不能借图片标记获得加载资格。
const assetId = "precision-clipboard-image"
const hasAsset = (id, kind) => id === assetId && kind === "image"
// 建立真实图片/表格扩展，测试使用固定数据地址以排除网络和解码差异。
const makeEditor = content => new Editor({
  element: document.createElement("div"),
  extensions: createExtensions(id => id === assetId ? "data:image/png;base64,AA==" : ""),
  content
})
// fixture 默认结构合法，场景只覆盖需要验证的合并/列宽/外观字段。
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] })
const cell = (text, attrs = {}, type = "tableCell") => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: [130], ...attrs }, content: [paragraph(text)] })
// 按节点类型收集解析结果，避免 DOM 表象掩盖协议属性丢失。
const nodes = (editor, type) => {
  const values = []
  editor.state.doc.descendants(node => { if (node.type.name === type) values.push(node) })
  return values
}
// 解析结果再经过持久化校验，图片同时提供对应资源元信息。
const assertValid = editor => assert.doesNotThrow(() => validateDocument({
  ...createDocument(), content: editor.getJSON(),
  assets: nodes(editor, "image").length ? [{ id: assetId, fileName: "剪贴板.png", mimeType: "image/png", byteLength: 1 }] : []
}))
// 执行实际 sanitizer 后再创建编辑器，覆盖清理与 parseHTML 的连续链路。
const paste = html => makeEditor(cleanPastedHtml(html, hasAsset))

// 从当前 schema 实际生成 HTML，再经过产品 sanitizer 和 schema 重新解析；比较全部图表属性，
// 防止只检查原始字符串遗漏 colspan/rowspan、colwidth 或 parseHTML 中的精细设置丢失。
test("内部图表 HTML 粘贴保留精细外观、跨行跨列合并、列宽及图片自由比例属性", () => {
  const source = makeEditor({ type: "doc", content: [
    { type: "table", content: [
      { type: "tableRow", attrs: { minHeight: 76 }, content: [
        cell("跨两行两列", { colspan: 2, rowspan: 2, colwidth: [90, 110], backgroundColor: "#ffeedd", verticalAlign: "middle", paddingX: 0, paddingY: 40, borderColor: "#123456", borderWidth: 3, borderStyle: "dashed" }),
        cell("表头", { backgroundColor: "#abcdef", verticalAlign: "bottom", paddingX: 12, paddingY: 4, borderColor: "#654321", borderWidth: 4, borderStyle: "dotted" }, "tableHeader")
      ] },
      { type: "tableRow", content: [cell("第三列", { paddingX: 40, paddingY: 0, borderWidth: 0 })] }
    ] },
    { type: "image", attrs: { assetId, width: 319.5, height: 87.25, align: "center", lockAspectRatio: false, alt: "替代文字", title: "独立说明" } },
    paragraph("图表之后的文字")
  ] })
  let restored
  try {
    restored = paste(source.getHTML())
    assert.deepEqual(restored.getJSON(), source.getJSON())
    assertValid(restored)
    assert.deepEqual(nodes(restored, "tableCell")[0].attrs.colwidth, [90, 110])
    assert.equal(nodes(restored, "tableCell")[0].attrs.rowspan, 2)
    assert.equal(nodes(restored, "tableRow")[0].attrs.minHeight, 76)
  } finally { source.destroy(); restored?.destroy() }
})

// 0 是有效的数值，不能用 truthy 判断替换为默认值；none 是用户明确清除边框的枚举。
test("零内边距与零边框宽度经过清理后保持零，none 边框模式可独立保留", () => {
  const source = makeEditor({ type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [
    cell("零值", { paddingX: 0, paddingY: 0, borderWidth: 0, borderStyle: "solid", borderColor: "#000000", backgroundColor: "#000000" }),
    cell("无边框", { paddingX: 0, paddingY: 0, borderWidth: 0, borderStyle: "none", borderColor: "#000000" })
  ] }] }] })
  let restored
  try {
    // ProseMirror DOMSerializer 写 style.cssText 时，JSDOM 26 会丢弃显式 none；其他字段仍
    // 原样来自 source.getHTML()。只用字面声明补回这项 fixture，真实浏览器另验完整往返。
    const parsed = new DOMParser().parseFromString(source.getHTML(), "text/html")
    const target = parsed.querySelectorAll("td")[1]
    target.setAttribute("style", `${target.getAttribute("style")}; border-style: none`)
    restored = paste(parsed.body.innerHTML)
    const [zero, none] = nodes(restored, "tableCell")
    assert.equal(zero.attrs.paddingX, 0)
    assert.equal(zero.attrs.paddingY, 0)
    assert.equal(zero.attrs.borderWidth, 0)
    assert.equal(zero.attrs.backgroundColor, "#000000")
    assert.equal(none.attrs.borderWidth, 0)
    assert.equal(none.attrs.borderStyle, "none")
    assert.equal(none.attrs.backgroundColor, null)
    assertValid(restored)
  } finally { source.destroy(); restored?.destroy() }
})

test("表格行高合法边界和旧列宽占位零保留，非法高度、合并范围与列宽被过滤", () => {
  const restored = paste('<table><tr style="min-height:1px"><td colspan="2" rowspan="1" colwidth="0,4000">合法</td></tr><tr style="height:1000px"><td colspan="2" colwidth="35,2000">上限</td></tr></table><table><tr style="height:1001px"><td colspan="0" rowspan="-1" colwidth="-1" data-unsafe="true">非法</td></tr></table>')
  try {
    assert.deepEqual(nodes(restored, "tableRow").map(node => node.attrs.minHeight), [1, 1000, null])
    assert.deepEqual(nodes(restored, "tableCell")[0].attrs.colwidth, [0, 4000])
    const invalid = nodes(restored, "tableCell")[2].attrs
    assert.equal(invalid.colspan, 1)
    assert.equal(invalid.rowspan, 1)
    assert.equal(invalid.colwidth, null)
    assertValid(restored)
    const cleaned = cleanPastedHtml('<table><tr><td colspan="2" colwidth="100,200,300">列数不符</td><td colwidth="4001">越界列宽</td></tr></table>')
    assert.doesNotMatch(cleaned, /colwidth=/)
  } finally { restored.destroy() }
})

// CSS 读取后只重新生成业务白名单值；危险 URL、任意定位以及越界外观不进入输出正文。
test("恶意 CSS、事件、外链源与非法精细属性被清理为安全默认，不影响正文", () => {
  const html = `<script>danger()</script><table onclick="danger()" style="position:fixed; background-image:url(https://evil.invalid/a)"><tr style="height:0px"><td colspan="-3" rowspan="1000" colwidth="NaN" onmouseover="danger()" style="background-color:rgba(12,34,56,.5);vertical-align:super;padding-left:41px;padding-top:1.5px;border-color:rgba(1,2,3,.5);border-width:7px;border-style:groove;position:absolute;background-image:url(https://evil.invalid/b)">原文</td></tr></table><img data-mewoc-asset-id="${assetId}" data-mewoc-image-align="justify" data-mewoc-lock-aspect-ratio="TRUE" width="Infinity" height="-1" alt="${"超".repeat(1001)}" title="合法说明" src="https://evil.invalid/image.png" onerror="danger()" style="width:999999px;aspect-ratio:100000;transform:rotate(45deg)"><a href="javascript:danger()">链接文字</a>`
  const cleaned = cleanPastedHtml(html, hasAsset)
  assert.doesNotMatch(cleaned, /script|onclick|onmouseover|onerror|evil\.invalid|javascript:|position:|background-image|transform:|Infinity|justify|TRUE/)
  const restored = makeEditor(cleaned)
  try {
    const attrs = nodes(restored, "tableCell")[0].attrs
    assert.deepEqual({ backgroundColor: attrs.backgroundColor, verticalAlign: attrs.verticalAlign, paddingX: attrs.paddingX, paddingY: attrs.paddingY, borderColor: attrs.borderColor, borderWidth: attrs.borderWidth, borderStyle: attrs.borderStyle }, { backgroundColor: null, verticalAlign: "top", paddingX: 10, paddingY: 8, borderColor: "#d9dbe5", borderWidth: 1, borderStyle: "solid" })
    assert.equal(nodes(restored, "tableRow")[0].attrs.minHeight, null)
    const image = nodes(restored, "image")[0].attrs
    assert.deepEqual({ align: image.align, lock: image.lockAspectRatio, width: image.width, height: image.height, alt: image.alt, title: image.title }, { align: "left", lock: true, width: 360, height: 240, alt: "", title: "合法说明" })
    assert.equal(restored.getText().includes("原文"), true)
    assert.equal(restored.getText().includes("链接文字"), true)
    assertValid(restored)
  } finally { restored.destroy() }
})

test("图片各对齐模式、锁定真假和 1–20000 尺寸边界在内部粘贴中保留", () => {
  for (const align of ["left", "center", "right"]) {
    for (const lockAspectRatio of [true, false]) {
      const source = makeEditor({ type: "doc", content: [{ type: "image", attrs: { assetId, width: 20000, height: 1, align, lockAspectRatio } }, paragraph("后续段落")] })
      let restored
      try {
        restored = paste(source.getHTML())
        assert.deepEqual(nodes(restored, "image")[0].attrs, nodes(source, "image")[0].attrs)
        assertValid(restored)
      } finally { source.destroy(); restored?.destroy() }
    }
  }
})

// 新表格 CSS 不得吞掉既有文字 mark、段落缩进/行距及安全链接；table 内外格式都要核验。
test("新增图表清理保留原有粗体、文字样式、段落缩进行距和安全链接", () => {
  const html = '<p style="text-align:center;line-height:2;text-indent:2em;margin-left:4em"><strong><span style="color:#123456;background-color:#ffeeaa;font-size:18pt;font-weight:600">正文格式</span></strong><a href="https://example.com/">安全链接</a></p><table><tr><td style="background-color:#ddccbb;padding:4px 12px;border:2px dashed #123456;vertical-align:middle"><p style="line-height:1.5;margin-left:2em"><em>表内格式</em></p></td></tr></table>'
  const restored = paste(html)
  try {
    const content = restored.getJSON().content
    assert.equal(content[0].attrs.textAlign, "center")
    assert.equal(content[0].attrs.lineHeight, 2)
    assert.equal(content[0].attrs.firstLineIndent, 2)
    assert.equal(content[0].attrs.leftIndent, 4)
    const text = content[0].content[0]
    assert.equal(text.marks.some(mark => mark.type === "bold"), true)
    const attrs = text.marks.find(mark => mark.type === "textStyle").attrs
    assert.equal(attrs.color, "#123456")
    assert.equal(attrs.backgroundColor, "#ffeeaa")
    assert.equal(attrs.fontSize, "18pt")
    assert.equal(attrs.fontWeight, "600")
    assert.equal(content[0].content[1].marks.some(mark => mark.type === "link" && mark.attrs.href === "https://example.com/"), true)
    const tableCell = nodes(restored, "tableCell")[0]
    assert.equal(tableCell.attrs.backgroundColor, "#ddccbb")
    assert.equal(tableCell.attrs.paddingX, 12)
    assert.equal(tableCell.attrs.paddingY, 4)
    assert.equal(tableCell.child(0).attrs.lineHeight, 1.5)
    assert.equal(tableCell.child(0).attrs.leftIndent, 2)
    assert.equal(tableCell.child(0).child(0).marks.some(mark => mark.type.name === "italic"), true)
    assertValid(restored)
  } finally { restored.destroy() }
})
