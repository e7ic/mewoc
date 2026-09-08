import { createDocumentHtml } from "../src/pages/editor/tools/file-transfer.js"
import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function checkHeadingFormatFlows(left, check) {
  const { editor } = left
  await checkHeadingWeight(editor, check)
  for (const [level, points] of [[1, "22.5"], [2, "15"], [3, "12.75"]]) {
    await check(`标题 ${level} 刷到正文保持实际字号、字重、颜色；缩放下字号控件显示 ${points}`, async () => {
      editor.commands.setContent(`<h${level}>标题</h${level}><p>正文</p>`)
      const wrapper = editor.view.dom.closest("[data-probe]")
      const source = getAppearance(editor.view.dom.querySelector(`h${level}`))
      try {
        for (const scale of [0.5, 1, 1.5]) {
          wrapper.style.transform = `scale(${scale})`
          editor.commands.setTextSelection(1)
          await nextFrame()
          assert(getSizeLabel(wrapper) === points, `标题字号回显错误：${getSizeLabel(wrapper)}`)
        }
        const before = JSON.stringify(editor.getJSON())
        editor.commands.copyFormat()
        editor.commands.setTextSelection({ from: 5, to: 7 })
        editor.commands.applyFormat()
        await nextFrame()
        assert(getSizeLabel(wrapper) === points, "刷后字号控件未更新")
        assert(JSON.stringify(getAppearance(editor.view.dom.querySelector("p span"))) === JSON.stringify(source), "刷后文字视觉格式不一致")
        assert(editor.getJSON().content[1].type === "paragraph", "正文变成标题")
        left.getSnapshot()
        editor.commands.undo()
        assert(JSON.stringify(editor.getJSON()) === before, "不能一次撤销全部格式")
      } finally {
        wrapper.style.transform = ""
      }
    })
  }
  await check("标题字号切换、混合选区及清除格式后，真实字号控件同步", async () => {
    editor.commands.setContent("<h1>标题</h1><p>正文</p>")
    const wrapper = editor.view.dom.closest("[data-probe]")
    editor.commands.setTextSelection({ from: 1, to: 3 })
    editor.commands.setFontSize("24pt")
    await nextFrame()
    assert(getSizeLabel(wrapper) === "24", "显式字号未覆盖标题默认字号")
    editor.commands.selectAll()
    await nextFrame()
    assert(getSizeLabel(wrapper) === "混合", "混合字号误报为统一字号")
    editor.commands.setTextSelection({ from: 1, to: 3 })
    editor.commands.unsetAllMarks()
    await nextFrame()
    assert(getSizeLabel(wrapper) === "22.5", "清除后没有恢复标题字号")
    editor.commands.setHeading({ level: 3 })
    await nextFrame()
    assert(getSizeLabel(wrapper) === "12.75", "切换标题级别后字号未更新")
  })
  await check("标题格式经过复制、Mewoc 和静态 HTML 后保留字号、字重、颜色及行距", async () => {
    editor.commands.setContent("<h2>标题</h2><p>正文</p>")
    editor.commands.setTextSelection(1)
    editor.commands.copyFormat()
    editor.commands.setTextSelection({ from: 5, to: 7 })
    editor.commands.applyFormat()
    const expected = getAppearance(editor.view.dom.querySelector("p span"))
    editor.commands.setContent(cleanPastedHtml(editor.getHTML()))
    assert(JSON.stringify(getAppearance(editor.view.dom.querySelector("p span"))) === JSON.stringify(expected), "复制后视觉格式改变")
    const snapshot = left.getSnapshot()
    const source = await createPortableFile(snapshot, left.assets)
    const restored = await readPortableFile(new File([JSON.stringify(source)], "标题.mewoc.json"))
    assert(JSON.stringify(restored.document.content) === JSON.stringify(snapshot.content), "文件往返改变格式")
    const html = await createDocumentHtml(snapshot, left.assets)
    const parsed = new DOMParser().parseFromString(html, "text/html")
    const span = parsed.querySelector("p span")
    assert(span.style.fontSize === "15pt" && span.style.fontWeight === "600", "HTML 丢失字号或字重")
    assert(parsed.querySelector("p").style.lineHeight === "1.55", "HTML 丢失标题行距")
  })
}

async function checkHeadingWeight(editor, check) {
  await check("标题手动字号与加粗优先；正文反刷标题保留级别并匹配实际外观", () => {
    for (const [headingSource, boldSource] of [[true, true], [false, false], [false, true]]) {
      editor.commands.setContent(headingSource
        ? '<h1><strong><span style="font-size:24pt">标题</span></strong></h1><p>正文</p>'
        : `${boldSource ? "<p><strong>正文</strong></p>" : "<p>正文</p>"}<h3>标题</h3>`)
      const source = editor.view.dom.firstElementChild
      const expected = getAppearance(source.querySelector("span") || source)
      editor.commands.setTextSelection(1)
      editor.commands.copyFormat()
      editor.commands.setTextSelection({ from: 5, to: 7 })
      editor.commands.applyFormat()
      const target = editor.view.dom.children[1]
      const actual = getAppearance(target.querySelector("span") || target)
      assert(JSON.stringify(actual) === JSON.stringify(expected), `显式格式或反向复制不一致：${JSON.stringify({ headingSource, expected, actual })}`)
      assert(target.tagName === (headingSource ? "P" : "H3"), "改变了目标段落类型")
    }
  })
}

function getAppearance(element) {
  const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()
  const css = getComputedStyle(text?.parentElement || element)
  return { fontSize: css.fontSize, fontWeight: css.fontWeight, color: css.color, lineHeight: css.lineHeight }
}

function getSizeLabel(wrapper) {
  return wrapper.querySelector('[aria-label="字号"]').closest(".ant-select").querySelector(".ant-select-selection-item")?.textContent
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}
