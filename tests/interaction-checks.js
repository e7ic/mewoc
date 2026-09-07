function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function checkImageInteractions(session, check) {
  for (const reason of ["右键", "其他指针", "窗口失焦", "系统取消", "只读", "正文变化"]) {
    await check(`图片拖动边界：${reason}不提交临时尺寸`, () => checkImageCancellation(session.editor, reason))
  }
  await check("组合输入期间不拦截查找快捷键，结束后可正常打开查找", () => {
    const { editor, store } = session
    store.getState().updateView({ searchOpen: false })
    const composing = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "f", isComposing: true })
    editor.view.dom.dispatchEvent(composing)
    assert(!composing.defaultPrevented && !store.getState().searchOpen, "组合输入被快捷键打断")
    const normal = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "f" })
    editor.view.dom.dispatchEvent(normal)
    assert(normal.defaultPrevented && store.getState().searchOpen, "普通查找快捷键失效")
    store.getState().updateView({ searchOpen: false })
  })
  await check("关闭查找后清空旧替换词与大小写状态，不修改正文版本", () => checkSearchPanelReset(session))
}

async function checkSearchPanelReset({ editor, store }) {
  const revision = store.getState().revision
  try {
    store.getState().updateView({ searchOpen: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    editor.commands.setReplaceTerm("上一轮的替换文字")
    editor.commands.setCaseSensitive(true)
    store.getState().updateView({ searchOpen: false })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert(editor.storage.findAndReplace.replaceTerm === "", "面板关闭后还保留旧替换词")
    assert(!editor.storage.findAndReplace.caseSensitive, "新面板默认不区分大小写，但插件还在区分")
    assert(store.getState().revision === revision, "复位查找状态产生了正文修改")
  } finally {
    store.getState().updateView({ searchOpen: false })
    editor.commands.setReplaceTerm("")
    editor.commands.setCaseSensitive(false)
  }
}

function checkImageCancellation(editor, reason) {
  const handle = editor.view.dom.querySelector("[data-resize-handle]")
  const image = editor.view.dom.querySelector("figure img")
  const before = editor.getJSON().content.find(node => node.type === "image").attrs.width
  const capture = handle.setPointerCapture
  const event = (type, options = {}) => new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: 100, buttons: 1, ...options })
  // 合成事件不能取得系统指针捕获；此处只替换捕获入口，验证真实节点视图状态机。
  handle.setPointerCapture = () => undefined
  try {
    handle.dispatchEvent(event("pointerdown", { button: reason === "右键" ? 2 : 0 }))
    handle.dispatchEvent(event("pointermove", { pointerId: reason === "其他指针" ? 2 : 1, clientX: 120 }))
    if (reason === "窗口失焦") window.dispatchEvent(new Event("blur"))
    if (reason === "系统取消") handle.dispatchEvent(event("pointercancel"))
    if (reason === "只读") editor.setEditable(false, false)
    if (reason === "正文变化") editor.commands.insertContentAt(1, "边界")
    handle.dispatchEvent(event("pointerup", { pointerId: reason === "其他指针" ? 2 : 1, buttons: 0 }))
    const width = editor.getJSON().content.find(node => node.type === "image").attrs.width
    assert(width === before, `${reason}仍提交了尺寸：${before}→${width}`)
    assert(image.style.width === `${before}px`, `${reason}后残留临时预览尺寸`)
  } finally {
    handle.dispatchEvent(event("pointercancel"))
    handle.setPointerCapture = capture
    editor.setEditable(true, false)
  }
}
