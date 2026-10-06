/**
 * 处理图片设置草稿、比例调整、目标书签和最终属性提交。
 * 弹窗草稿不直接修改正文；目标跟随完整事务链移动，一旦原图删除就不能把旧草稿套给新节点。
 */
import { NodeSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"

// 设置范围与持久文档约束保持一致，imageFields 限定弹窗允许提交的属性，资源身份不在其中。
export const IMAGE_ALIGNMENTS = ["left", "center", "right"]
export const IMAGE_SIZE_MIN = 1
export const IMAGE_SIZE_MAX = 20000
export const IMAGE_TEXT_MAX = 1000
const imageFields = ["width", "height", "align", "lockAspectRatio", "alt", "title"]

export const isImageDimension = value => typeof value === "number" && Number.isFinite(value)
  && value >= IMAGE_SIZE_MIN && value <= IMAGE_SIZE_MAX

// 读取旧尺寸时保留小数；只有用户实际调整的尺寸才取整，不在打开或保存时悄悄改写。
export function getImageSettingsDraft(attrs) {
  const width = isImageDimension(attrs.width) ? attrs.width : 360
  const height = isImageDimension(attrs.height) ? attrs.height : 240
  return {
    width, height, ratio: width / height,
    align: IMAGE_ALIGNMENTS.includes(attrs.align) ? attrs.align : "left",
    lockAspectRatio: attrs.lockAspectRatio !== false,
    alt: attrs.alt || "", title: attrs.title || ""
  }
}

// 只更新用户编辑的一维；锁定比例时依据原比例推导另一维，非法输入继续留在草稿等待修正。
export function changeImageDimension(draft, dimension, value) {
  if (!["width", "height"].includes(dimension)) return draft
  const next = { ...draft, [dimension]: value }
  // 无效输入留在草稿供修正，不拿它重算另一维，也不钳制到一个意外的合法值。
  if (draft.lockAspectRatio && isImageDimension(value) && Number.isFinite(draft.ratio) && draft.ratio > 0) {
    const other = dimension === "width" ? "height" : "width"
    next[other] = Math.round(dimension === "width" ? value / draft.ratio : value * draft.ratio)
  }
  return next
}

// 锁定操作建立新的计算基准，解锁不丢弃已保存比例，方便用户继续修改或重新恢复。
export function setImageAspectRatioLock(draft, lockAspectRatio) {
  return {
    ...draft, lockAspectRatio,
    // 重新锁定以当前合法宽高为基准；一轮连续调整不反复使用舍入后的比例。
    ratio: lockAspectRatio && isImageDimension(draft.width) && isImageDimension(draft.height)
      ? draft.width / draft.height : draft.ratio
  }
}

const isNaturalSize = size => size && Number.isFinite(size.width) && size.width > 0
  && Number.isFinite(size.height) && size.height > 0

// 恢复原图比例只调整高度并保留当前宽度；原图未解码或草稿宽度非法时保持现状。
export function restoreImageAspectRatio(draft, naturalSize) {
  if (!isNaturalSize(naturalSize) || !isImageDimension(draft.width)) return draft
  const ratio = naturalSize.width / naturalSize.height
  return { ...draft, ratio, height: Math.round(draft.width / ratio) }
}

// 提交前校验尺寸、枚举和文本长度，返回错误文本而不钳制数据，避免悄悄改成意外设置。
export function getImageSettingsError(values) {
  if (!values || !isImageDimension(values.width) || !isImageDimension(values.height)) return "图片宽度和高度必须为 1–20000 px 的有效数值"
  if (!IMAGE_ALIGNMENTS.includes(values.align)) return "请选择有效的图片对齐方式"
  if (typeof values.lockAspectRatio !== "boolean") return "请选择有效的比例锁定状态"
  if ([values.alt, values.title].some(value => typeof value !== "string" || value.length > IMAGE_TEXT_MAX)) return "替代文本和图片说明最多各 1000 个字符"
  return ""
}

// 除了编辑器状态，也调用会话权限检查，防止切换文档等上层阻塞期间仍从弹窗写正文。
function canEditImage(editor, canEdit = () => true) {
  return Boolean(editor && !editor.isDestroyed && editor.isEditable && !editor.view.composing && canEdit())
}

// 书签在捕获后立即开始映射，删除标记只增不减，同位置重插同一资源也不能接收旧草稿。
export function captureImageSettingsTarget(editor) {
  if (!canEditImage(editor)) return null
  const selection = editor.state.selection
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image") return null
  let bookmark = selection.getBookmark()
  let position = selection.from
  let deleted = false
  let disposed = false
  const target = {
    assetId: selection.node.attrs.assetId,
    original: getImageSettingsDraft(selection.node.attrs),
    getSelection() {
      return deleted || disposed || editor.isDestroyed ? null : bookmark.resolve(editor.state.doc)
    },
    // 弹窗退出后解除事务监听并永久关闭书签，避免持有过期会话和继续跟踪无用位置。
    dispose() {
      disposed = true
      editor.off("transaction", mapTarget)
    }
  }
  const mapTarget = ({ transaction, appendedTransactions = [] }) => {
    // 表格自动修复等插件会在主事务后追加步骤，按完整事务链依次映射到最终正文。
    for (const current of [transaction, ...appendedTransactions]) {
      const mapped = current.mapping.mapResult(position)
      deleted ||= mapped.deleted
      position = mapped.pos
      bookmark = bookmark.map(current.mapping)
      // 资源身份变化也永久终止旧目标，即使稍后撤销换图又恢复原 assetId，旧文件选择或草稿不能复活。
      const node = current.doc.nodeAt(position)
      deleted ||= node?.type.name !== "image" || node.attrs.assetId !== target.assetId
    }
  }
  editor.on("transaction", mapTarget)
  return target
}

// 恢复选区后仍核对当前节点类型和资源 ID，位置有效并不意味着仍是原先编辑的图片。
function getTargetImage(editor, selection, assetId) {
  if (!selection || !(selection instanceof NodeSelection) || selection.$from.doc !== editor.state.doc) return null
  const node = editor.state.doc.nodeAt(selection.from)
  return node?.type.name === "image" && (assetId === undefined || node.attrs.assetId === assetId) ? node : null
}

// 仅查看已经解码的 NodeView 图片，不创建 URL、不加载第二份资源。
export function getImageNaturalSize(editor, selection) {
  if (!editor || editor.isDestroyed || !getTargetImage(editor, selection)) return null
  const dom = editor.view.nodeDOM(selection.from)
  const image = dom?.querySelector?.("img")
  const size = image?.complete ? { width: image.naturalWidth, height: image.naturalHeight } : null
  return isNaturalSize(size) ? size : null
}

// 计算相对打开时草稿真正改变的字段，再合并到当前节点；他人在弹窗期间的其他属性更新保留。
export function applyImageSettings(editor, target, values, canEdit) {
  if (!target || !canEditImage(editor, canEdit) || getImageSettingsError(values)) return false
  const selection = target.getSelection()
  const node = getTargetImage(editor, selection, target.assetId)
  if (!node) return false
  const changes = Object.fromEntries(imageFields.filter(field => values[field] !== target.original[field])
    .map(field => [field, values[field]]))
  // 保留打开期间其他事务更新的属性；没有变更的草稿字段不会覆盖当前节点。
  const attrs = { ...node.attrs, ...changes }
  if (Object.keys(changes).some(field => node.attrs[field] !== changes[field])) {
    editor.view.dispatch(closeHistory(editor.state.tr).setNodeMarkup(selection.from, undefined, attrs))
    editor.view.dispatch(closeHistory(editor.state.tr))
  }
  return true
}

// 只删除正文中当前选中的图片节点，资源留给会话撤销使用，后续保存再按实际引用清理持久 Blob。
export function removeSelectedImage(editor, canEdit) {
  if (!canEditImage(editor, canEdit)) return false
  const selection = editor.state.selection
  if (!getTargetImage(editor, selection)) return false
  editor.view.dispatch(closeHistory(editor.state.tr).delete(selection.from, selection.to))
  editor.view.dispatch(closeHistory(editor.state.tr))
  return true
}
