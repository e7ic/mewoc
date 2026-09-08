import { createPortableFile, readPortableFile } from "../src/pages/editor/tools/portable-file.js"
import { createDocumentHtml } from "../src/pages/editor/tools/file-transfer.js"
import { createDocumentMarkdown } from "../src/pages/editor/tools/markdown-file.js"
import { getDocuments, getDocumentAssets } from "../src/pages/editor/tools/local-repository.js"
import { removeAttachment } from "../src/pages/editor/tools/attachment-commands.js"
import { cleanPastedHtml } from "../src/pages/editor/hooks/use-editor-input.js"
import { checkAttachmentRestoration } from "./attachment-restore-checks.jsx"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function checkAttachmentFlows(left, check) {
  const { editor, assets, store } = left
  await check("附件原始字节进入正文卡片，下载地址按二进制提供原文件", async () => {
    editor.commands.setContent("<p>附件验收</p>")
    editor.commands.setTextSelection(5)
    const file = new File([new Uint8Array([0, 255, 128, 1]), "附件内容"], "附件验收.bin")
    assert(await left.insertAttachment(file), "未能插入附件")
    const link = editor.view.dom.querySelector("[data-attachment-download]")
    const response = await fetch(link.href)
    assert(response.headers.get("content-type") === "application/octet-stream", "下载类型不正确")
    assert(equalBytes(await response.arrayBuffer(), await file.arrayBuffer()), "下载字节改变")
    assert(link.download === file.name, "下载文件名错误")
    assert(editor.getText().includes(file.name), "纯文本缺少附件说明")
    assert(left.getSnapshot().assets[0].kind === "attachment", "快照未保留资源种类")
  })
  await check("附件随 Mewoc 导出导入并从 IndexedDB 恢复，资源字节保持一致", async () => {
    const snapshot = left.getSnapshot()
    const source = await createPortableFile(snapshot, assets)
    const restored = await readPortableFile(new File([JSON.stringify(source)], "附件.mewoc.json"))
    const id = snapshot.assets[0].id
    assert(restored.document.id !== snapshot.id, "导入没有创建独立文档")
    assert(equalBytes(await restored.assets.get(id).blob.arrayBuffer(), await assets.get(id).blob.arrayBuffer()), "文件往返改变附件")
    assert(await left.saveDocument(), store.getState().saveError)
    const saved = (await getDocuments()).find(record => record.id === snapshot.id)
    const loaded = await getDocumentAssets(saved.document)
    assert(equalBytes(await loaded.get(id).blob.arrayBuffer(), await assets.get(id).blob.arrayBuffer()), "本地恢复改变附件")
  })
  await check("HTML 内嵌附件下载且转义文件名，打印规则隐藏下载入口", async () => {
    const html = await createDocumentHtml(left.getSnapshot(), assets)
    const parsed = new DOMParser().parseFromString(html, "text/html")
    const link = parsed.querySelector("[data-attachment-download]")
    assert(link?.href.startsWith("data:application/octet-stream;base64,"), "HTML 没有包含独立附件内容")
    assert(!html.includes("blob:"), "HTML 泄漏临时 URL")
    const id = left.getSnapshot().assets[0].id
    assert(equalBytes(await (await fetch(link.href)).arrayBuffer(), await assets.get(id).blob.arrayBuffer()), "HTML 附件字节改变")
    assert(/@media print/.test(html) && /\[data-attachment-download\]\s*\{\s*display:\s*none/.test(html), "缺少打印隐藏规则")
  })
  await check("附件内部复制保留唯一资源引用，外部粘贴退为文件说明", () => {
    const snapshot = left.getSnapshot()
    const html = editor.getHTML()
    editor.commands.setContent(cleanPastedHtml(`${html}${html}`, (id, kind) => assets.get(id)?.kind === kind))
    assert(editor.view.dom.querySelectorAll('[data-type="attachment"]').length === 2, "内部复制缺失附件")
    assert(left.getSnapshot().assets.length === 1, "重复引用重复计入资源")
    const external = cleanPastedHtml(html)
    assert(!external.includes("data-mewoc-asset-id") && external.includes(snapshot.assets[0].fileName), "外部附件没有退为文字")
  })
  await check("删除最后一个附件引用后回收磁盘资源，撤销后重新保存恢复", () => checkAttachmentUndo(left))
  await check("只读仍可下载和导出附件，插入与删除均不改变正文", async () => {
    const before = JSON.stringify(editor.getJSON())
    store.getState().updateView({ readOnly: true })
    editor.setEditable(false, false)
    try {
      assert(!await left.insertAttachment(new File(["readonly"], "只读.txt")), "只读仍插入附件")
      assert(!removeAttachment(editor), "只读仍删除附件")
      const link = editor.view.dom.querySelector("[data-attachment-download]")
      assert((await fetch(link.href)).ok, "只读不能读取附件下载")
      assert((await createPortableFile(left.getSnapshot(), assets)).document.assets.length === 1, "只读导出失败")
      assert(JSON.stringify(editor.getJSON()) === before, "只读正文改变")
    } finally {
      store.getState().updateView({ readOnly: false })
      editor.setEditable(true, false)
    }
  })
  await check("附件 Markdown 输出包含文件名和转换说明，不提供失效的资源链接", async () => {
    const result = await createDocumentMarkdown(left.getSnapshot())
    assert(result.source.includes("附件验收.bin"), "文件名丢失")
    assert(result.warnings.some(warning => warning.includes("附件")), "缺少附件转换说明")
    assert(!result.source.includes("blob:") && !result.source.includes("data:"), "包含临时或内嵌资源链接")
  })
  await checkAttachmentRestoration(left, check)
}

async function checkAttachmentUndo(left) {
  const { editor } = left
  const snapshot = left.getSnapshot()
  const positions = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "attachment") positions.push(pos) })
  editor.commands.setNodeSelection(positions[0])
  assert(removeAttachment(editor), "未删除首个引用")
  assert(left.getSnapshot().assets.length === 1, "尚有引用却删除资源")
  let position
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "attachment") position = pos })
  editor.commands.setNodeSelection(position)
  assert(removeAttachment(editor), "未删除末个引用")
  assert(await left.saveDocument(), "删除保存失败")
  let missing = false
  try {
    await getDocumentAssets(snapshot)
  } catch (error) {
    missing = error.message.includes("资源缺失")
  }
  assert(missing, "磁盘资源没有回收")
  editor.commands.undo()
  assert(left.getSnapshot().assets.length === 1 && await left.saveDocument(), "撤销保存失败")
  const restored = await getDocumentAssets(left.getSnapshot())
  assert(restored.get(snapshot.assets[0].id).blob.size === snapshot.assets[0].byteLength, "撤销后附件未恢复")
}

function equalBytes(first, second) {
  const bytes = new Uint8Array(second)
  return first.byteLength === second.byteLength && new Uint8Array(first).every((byte, index) => byte === bytes[index])
}
