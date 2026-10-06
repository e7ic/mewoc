/**
 * 图片替换使用与图片设置相同的目标书签，但仅更新资源 ID；排版和说明沿用提交时的节点属性。
 * 读取阶段不会登记资源或修改正文，成功提交后新旧 Blob 都留在会话中供撤销/重做使用。
 */
import { NodeSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import { checkAssetCapacity } from "./document-schema.js"
import { readImageFile } from "./image-assets.js"

// 必须同时核对当前文档、真实节点选区和原资源身份，普通位置映射成功不代表原图片仍存在。
export function getImageReplacementTarget(editor, target) {
  if (!editor || editor.isDestroyed || !target) return null
  const selection = target.getSelection()
  if (!(selection instanceof NodeSelection) || selection.$from.doc !== editor.state.doc) return null
  const node = editor.state.doc.nodeAt(selection.from)
  return node?.type.name === "image" && node.attrs.assetId === target.assetId ? { node, position: selection.from } : null
}

/**
 * 容量按替换后的正文引用计算：仅排除原目标这一次引用，其它位置仍引用旧图时照常计费。
 * 原资源即使不再计入正文额度，也仍保存在 assets 中；额度计算绝不能回收撤销需要的 Blob/URL。
 */
export function checkImageReplacementCapacity(editor, assets, target, incomingBytes) {
  const current = getImageReplacementTarget(editor, target)
  if (!current) return false
  if (!assets.has(current.node.attrs.assetId)) throw new Error("部分资源缺失，请重新打开文档后重试")
  const references = []
  editor.state.doc.descendants((node, position) => {
    if (["image", "attachment", "media"].includes(node.type.name) && position !== current.position) {
      references.push({ type: node.type.name, attrs: { assetId: node.attrs.assetId } })
    }
  })
  checkAssetCapacity({ type: "doc", content: references }, assets, incomingBytes)
  return true
}

/**
 * 将成功解码的新图提交到原目标；前后关闭历史分组，使换图与邻近输入各自一步撤销。
 * 调用方须先登记新资源，NodeView 在事务派发时才能立即获得对应 URL。
 */
export function applyImageReplacement(editor, target, assetId, canEdit = () => true) {
  if (!editor || editor.isDestroyed || !editor.isEditable || editor.view.composing || !canEdit()) return false
  const current = getImageReplacementTarget(editor, target)
  if (!current || typeof assetId !== "string" || !assetId || assetId === current.node.attrs.assetId) return false
  editor.view.dispatch(closeHistory(editor.state.tr).setNodeMarkup(current.position, undefined, { ...current.node.attrs, assetId }))
  editor.view.dispatch(closeHistory(editor.state.tr))
  return true
}

/**
 * 读取与最终提交之间用户仍可编辑正文。原目标跟随完整事务链，权限/组合输入中断则永久取消本次任务。
 * readFile 作为依赖入口让测试真实覆盖等待期间的删除、改选区及资源容量变化，不模拟提交实现本身。
 */
export async function replaceDocumentImage({ editor, assets, target, file, canEdit = () => true,
  isActive = () => true, subscribeSession = () => () => {}, readFile = readImageFile }) {
  const permitted = () => isActive() && editor && !editor.isDestroyed && editor.isEditable && !editor.view.composing && canEdit()
  if (!file || !permitted() || !checkImageReplacementCapacity(editor, assets, target, file.size)) return false
  let invalidated = false
  let committing = false
  let asset = null
  let registered = false
  let committed = false
  const inspectPermission = () => {
    if (!committing && (!permitted() || !getImageReplacementTarget(editor, target))) invalidated = true
  }
  const cancel = () => { invalidated = true }
  // 会话状态订阅覆盖「先切只读、随后恢复」；仅在读取结束时检查会错误接受这类旧任务。
  const unsubscribe = subscribeSession(inspectPermission)
  const dom = editor.view.dom
  editor.on("transaction", inspectPermission)
  editor.on("destroy", cancel)
  dom.addEventListener("compositionstart", cancel)
  try {
    asset = await readFile(file)
    if (invalidated || !permitted() || !checkImageReplacementCapacity(editor, assets, target, asset.byteLength)) return false
    // 在提交前登记，且只改资源 ID；换图不会按新图比例覆盖既有宽高、对齐、替代文本或说明。
    assets.set(asset.id, asset)
    registered = true
    committing = true
    committed = applyImageReplacement(editor, target, asset.id, permitted)
    return committed
  } finally {
    unsubscribe()
    editor.off("transaction", inspectPermission)
    editor.off("destroy", cancel)
    dom.removeEventListener("compositionstart", cancel)
    if (asset && !committed) {
      // 派发中发生异常时，若正文已引用新图则继续交给会话管理，避免留下指向已释放 URL 的节点。
      let referenced = false
      if (!editor.isDestroyed) editor.state.doc.descendants(node => {
        if (["image", "attachment", "media"].includes(node.type.name) && node.attrs.assetId === asset.id) referenced = true
      })
      if (!referenced) {
        if (registered) assets.delete(asset.id)
        URL.revokeObjectURL(asset.url)
      }
    }
  }
}
