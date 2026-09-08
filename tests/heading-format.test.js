import test from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { compile } from "sass"
import { Editor } from "@tiptap/core"
import { createExtensions } from "../src/pages/editor/tools/create-extensions.js"
import { createDocument, validateDocument } from "../src/pages/editor/tools/document-schema.js"
import { getSelectionTextStyle } from "../src/pages/editor/tools/text-appearance.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>")
for (const key of ["window", "document", "navigator", "DOMParser", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
}
const style = document.head.appendChild(document.createElement("style"))
style.textContent = compile("src/pages/editor/sass/content.scss").css

const createEditor = (level = 1, marks) => new Editor({
  element: document.body.appendChild(document.createElement("div")), extensions: createExtensions(),
  editorProps: { attributes: { class: "mewoc-content" }, handleScrollToSelection: () => true },
  content: { type: "doc", content: [
    { type: "heading", attrs: { level }, content: [{ type: "text", text: "标题", ...(marks && { marks }) }] },
    { type: "paragraph", content: [{ type: "text", text: "正文" }] }
  ] }
})

for (const [level, size, height] of [[1, "22.5pt", 1.5], [2, "15pt", 1.55], [3, "12.75pt", 1.55]]) {
  test(`标题 ${level} 的实际字号显示及格式刷保留 ${size}、字重、颜色和行距`, () => {
    const editor = createEditor(level)
    try {
      editor.commands.setTextSelection(1)
      assert.equal(getSelectionTextStyle(editor).fontSize, size)
      const before = editor.getJSON()
      assert.equal(editor.commands.copyFormat(), true)
      editor.commands.setTextSelection({ from: 5, to: 7 })
      assert.equal(editor.commands.applyFormat(), true)
      const target = editor.getJSON().content[1]
      const attrs = target.content[0].marks.find(mark => mark.type === "textStyle").attrs
      assert.equal(target.type, "paragraph")
      assert.equal(attrs.fontSize, size)
      assert.equal(attrs.fontWeight, "600")
      assert.equal(attrs.color, level === 1 ? "#242633" : "#363444")
      assert.equal(target.attrs.lineHeight, height)
      assert.equal(getSelectionTextStyle(editor).fontSize, size)
      assert.doesNotThrow(() => validateDocument({ ...createDocument(), content: editor.getJSON() }))
      editor.commands.undo()
      assert.deepEqual(editor.getJSON(), before)
    } finally {
      editor.destroy()
    }
  })
}

test("标题显式字号优先，混合选区按实际字号判断，空标题及清除格式正确回显", () => {
  const editor = createEditor(1, [{ type: "textStyle", attrs: { fontSize: "24pt" } }])
  try {
    editor.commands.setTextSelection(1)
    assert.equal(getSelectionTextStyle(editor).fontSize, "24pt")
    editor.commands.selectAll()
    assert.equal(getSelectionTextStyle(editor).fontSize, "mixed")
    editor.commands.setTextSelection({ from: 1, to: 3 })
    editor.commands.unsetAllMarks()
    assert.equal(getSelectionTextStyle(editor).fontSize, "22.5pt")
    editor.commands.deleteSelection()
    assert.equal(getSelectionTextStyle(editor).fontSize, "22.5pt")
    editor.commands.setParagraph()
    assert.equal(getSelectionTextStyle(editor).fontSize, "12pt")
  } finally {
    editor.destroy()
  }
})

test("正文刷到标题保留标题级别，并覆盖标题默认字号、颜色、字重和行距", () => {
  const editor = createEditor()
  try {
    editor.commands.setTextSelection(5)
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 1, to: 3 })
    editor.commands.applyFormat()
    const heading = editor.getJSON().content[0]
    const attrs = heading.content[0].marks.find(mark => mark.type === "textStyle").attrs
    assert.equal(heading.attrs.level, 1)
    assert.equal(attrs.fontSize, "12pt")
    assert.equal(attrs.fontWeight, "400")
    assert.equal(attrs.color, "#252837")
    assert.equal(heading.attrs.lineHeight, 1.75)
  } finally {
    editor.destroy()
  }
})

test("标题格式可内部复制、文件往返，显式字重不遮住后续加粗与取消", async () => {
  const editor = createEditor(2)
  try {
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 5, to: 7 })
    editor.commands.applyFormat()
    const snapshot = validateDocument({ ...createDocument(), content: editor.getJSON() })
    const file = await createPortableFile(snapshot, new Map())
    const restored = await readPortableFile(new File([JSON.stringify(file)], "标题.mewoc.json"))
    assert.deepEqual(restored.document.content, JSON.parse(JSON.stringify(snapshot.content)))
    editor.commands.setContent(cleanPastedHtml(editor.getHTML()))
    assert.equal(editor.getJSON().content[1].content[0].marks.find(mark => mark.type === "textStyle").attrs.fontWeight, "600")
    assert.equal(editor.getJSON().content[1].attrs.lineHeight, 1.55)
    editor.commands.setTextSelection({ from: 5, to: 7 })
    editor.commands.toggleTextBold()
    assert.equal(editor.getAttributes("textStyle").fontWeight, "400")
    editor.commands.toggleTextBold()
    assert.equal(editor.isActive("bold"), true)
    assert.equal(editor.getAttributes("textStyle").fontWeight, null)
    assert.doesNotThrow(() => validateDocument({ ...createDocument(), content: editor.getJSON() }))
  } finally {
    editor.destroy()
  }
})

test("相同默认外观不制造撤销步骤，显式字重在只读期间不改变", () => {
  const editor = createEditor()
  try {
    editor.commands.setContent("<p>来源</p><p>正文</p>")
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 5, to: 7 })
    const before = editor.getJSON()
    let updates = 0
    editor.on("update", () => { updates += 1 })
    editor.commands.applyFormat()
    assert.deepEqual(editor.getJSON(), before)
    assert.equal(updates, 0)
    editor.commands.setMark("textStyle", { fontWeight: "600" })
    editor.setEditable(false, false)
    const readOnly = editor.getJSON()
    assert.equal(editor.commands.toggleTextBold(), false)
    assert.deepEqual(editor.getJSON(), readOnly)
  } finally {
    editor.destroy()
  }
})
