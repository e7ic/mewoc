/**
 * 管理批注锚点跨复制、粘贴、拖动与清除格式时的去留。
 * 批注线程属于原文档；同编辑器移动可保留定位，复制出来的新内容必须解除与原线程的关联。
 */
import { Fragment, Slice } from "@tiptap/pm/model"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { dropPoint } from "@tiptap/pm/transform"

/**
 * 批注 ID 只在原文档中有意义。复制/粘贴保留全部正文结构和其他格式，
 * 但移除锚点；不能让同一线程被粘贴到无关段落或另一份文档。
 */
export function stripCommentAnchors(slice) {
  // 递归重建不可变 Fragment，保留节点、其他 marks 和切片开放深度，仅过滤批注定位标记。
  const visit = fragment => {
    const children = []
    fragment.forEach(node => {
      const content = node.content.size ? node.copy(visit(node.content)) : node
      children.push(content.mark(node.marks.filter(mark => mark.type.name !== "commentAnchor")))
    })
    return Fragment.from(children)
  }
  return new Slice(visit(slice.content), slice.openStart, slice.openEnd)
}

// 检测拖入内容是否需要本模块接管；找到首个锚点后停止向下扫描，普通内容交给原生流程。
function hasCommentAnchors(slice) {
  let found = false
  slice.content.descendants(node => {
    if (node.marks.some(mark => mark.type.name === "commentAnchor")) found = true
    return !found
  })
  return found
}

/**
 * ProseMirror 的拖动也调用复制/粘贴钩子，不能在这里一律剥离锚点。
 * 同编辑器移动由原生事务搬移锚点；拖动复制在最终 moved 标志确定后才剥离，
 * 避免用户途中按下/松开复制修饰键时，根据起拖状态误判成移动。
 */
export function createCommentClipboardHandlers(canEdit = view => view.editable && !view.composing, { hasLocalCopyFeatures = () => false, prepareLocalCopy = slice => slice } = {}) {
  // 这两个标志只覆盖原生拖动事件的同步处理窗口，微任务后恢复，以免影响下一次普通复制。
  let serializingDrag = false
  let receivingDrag = false
  return {
    handleDOMEvents: {
      dragstart: () => {
        serializingDrag = true
        // 原生事件处理器紧接着同步执行，微任务后普通复制又恢复为剥离锚点。
        queueMicrotask(() => { serializingDrag = false })
        return false
      },
      drop: view => {
        receivingDrag = !!view.dragging
        queueMicrotask(() => { receivingDrag = false })
        return false
      }
    },
    transformCopied: slice => serializingDrag ? slice : stripCommentAnchors(slice),
    transformPasted: (slice, view) => receivingDrag && view.dragging ? slice : stripCommentAnchors(slice),
    handleDrop: (view, event, slice, moved) => {
      if (!view.dragging || !hasCommentAnchors(slice) && !hasLocalCopyFeatures(slice)) return false
      if (view.isDestroyed || !canEdit(view)) return true
      if (moved) return false
      // 含批注或导航的本地副本共用插入事务；其余图片、表格和外部拖入继续使用原生流程。
      const target = view.posAtCoords({ left: event.clientX, top: event.clientY })
      if (!target) return true
      const copied = stripCommentAnchors(prepareLocalCopy(slice, view))
      const insertPos = dropPoint(view.state.doc, target.pos, copied) ?? target.pos
      const transaction = view.state.tr
      // 完整单节点用节点替换插入，开放切片用范围替换；两种入口分别保留块结构与跨段片段语义。
      const isNode = copied.openStart === 0 && copied.openEnd === 0 && copied.content.childCount === 1
      if (isNode) transaction.replaceRangeWith(insertPos, insertPos, copied.content.firstChild)
      else transaction.replaceRange(insertPos, insertPos, copied)
      if (!transaction.docChanged) return true
      const $from = transaction.doc.resolve(insertPos)
      // 复制后选中实际插入内容：可选原子节点恢复节点选区，其余根据最后一步映射恢复文字范围。
      if (isNode && NodeSelection.isSelectable(copied.content.firstChild)
        && $from.nodeAfter?.sameMarkup(copied.content.firstChild)) {
        transaction.setSelection(NodeSelection.create(transaction.doc, insertPos))
      } else {
        let end = transaction.mapping.map(insertPos)
        transaction.mapping.maps.at(-1).forEach((_from, _to, _newFrom, newTo) => { end = newTo })
        transaction.setSelection(TextSelection.between($from, transaction.doc.resolve(end)))
      }
      view.focus()
      view.dispatch(transaction.setMeta("uiEvent", "drop"))
      return true
    }
  }
}

// 清除文字格式不会删除审阅定位。批注删除由面板单独操作并进入正文撤销历史。
export function clearTextFormatting(editor) {
  if (!editor?.isEditable || editor.isDestroyed || editor.view.composing) return false
  return editor.chain().focus().command(({ tr, state }) => {
    for (const type of Object.values(state.schema.marks)) {
      if (type.name !== "commentAnchor") tr.removeMark(tr.selection.from, tr.selection.to, type)
    }
    // 空光标的待输入 marks 也需清理，否则下一次打字会继续继承用户刚清除的文字格式。
    const marks = state.storedMarks || state.selection.$from.marks()
    tr.setStoredMarks(marks.filter(mark => mark.type.name === "commentAnchor"))
    return true
  }).run()
}
