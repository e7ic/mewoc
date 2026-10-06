/**
 * 基础编辑增强的真实 Workspace 验收：编号设置、上下标和待办清单都通过实际工具栏入口操作。
 * 直接事务只用于准备文档、定位选区和模拟浮层期间的外部编辑；不冒充原生输入法或鼠标拖动验收。
 */
import { TextSelection } from "@tiptap/pm/state"

const content = editor => JSON.stringify(editor.getJSON())
const nodes = (editor, type) => {
  const result = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === type) result.push({ node, pos }) })
  return result
}
const paragraph = (editor, text) => nodes(editor, "paragraph").find(entry => entry.node.textContent === text)
const select = (editor, from, to = from) => {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
  editor.view.focus()
}
const selectParagraph = (editor, text) => select(editor, paragraph(editor, text).pos + 1)
const numberedFixture = "<p>编号前文</p><ol><li><p>列表甲</p></li><li><p>列表乙</p></li></ol><p>列表间隔</p><ol start=\"3\" type=\"A\"><li><p>另一列表</p></li></ol><p>编号后文</p>"

export async function runBasicEditingChecks({ check, toolbar, activePanel, selectText, switchMode, switchTab, assert, waitFor, button, byLabel, setInput, visible }) {
  const popup = () => [...document.querySelectorAll('[role="dialog"][aria-label="编号设置"]')].find(visible)
  const openNumbering = async () => {
    const trigger = await waitFor(() => button(activePanel(), "编号设置"), "缺少编号设置入口")
    await waitFor(() => !trigger.disabled, "有序列表内编号入口未启用")
    trigger.click()
    return waitFor(popup, "编号设置浮层未打开")
  }
  const chooseNumbering = (opened, label, start) => {
    byLabel(opened, label).click()
    setInput(byLabel(opened, "起始编号"), start)
  }
  const setNumberingFixture = async editor => {
    editor.commands.setContent(numberedFixture)
    selectParagraph(editor, "列表甲")
    await switchTab("开始")
  }
  const taskCheckboxes = editor => [...editor.view.dom.querySelectorAll('li[data-type="taskItem"] > label > input[type="checkbox"]')]
  const setTaskFixture = async editor => {
    editor.commands.setContent("<p>任务甲</p><p>任务乙</p><p>任务丙</p>")
    select(editor, 1, editor.state.doc.content.size - 1)
    await switchTab("开始")
  }

  await check("基础编辑：两种模式的上下标互斥，保留选区且分别可撤销", async ({ editor }) => {
    for (const mode of ["ribbon", "compact"]) {
      if (toolbar().dataset.toolbarMode !== mode) await switchMode(mode)
      await switchTab("开始")
      selectText(editor)
      const before = content(editor)
      const selection = JSON.stringify(editor.state.selection.toJSON())
      button(activePanel(), "上标").click()
      await waitFor(() => editor.isActive("superscript") && editor.view.dom.querySelector("sup"), "上标未作用于正文选区")
      assert(!editor.isActive("subscript"), "上标与下标同时激活")
      button(activePanel(), "下标").click()
      await waitFor(() => editor.isActive("subscript") && !editor.isActive("superscript") && editor.view.dom.querySelector("sub"), "下标没有替换原上标")
      assert(JSON.stringify(editor.state.selection.toJSON()) === selection, "上下标操作丢失原文字选区")
      editor.commands.undo()
      assert(editor.isActive("superscript") && !editor.isActive("subscript"), "一次撤销没有恢复上标")
      editor.commands.undo()
      assert(content(editor) === before, "第二次撤销未恢复原文字")
    }
  })

  await check("基础编辑：两种模式可创建待办、勾选，并单独撤销勾选和创建", async ({ editor }) => {
    for (const mode of ["ribbon", "compact"]) {
      if (toolbar().dataset.toolbarMode !== mode) await switchMode(mode)
      await setTaskFixture(editor)
      const before = content(editor)
      button(activePanel(), "待办清单").click()
      await waitFor(() => nodes(editor, "taskItem").length === 3 && taskCheckboxes(editor).length === 3, "待办入口未将三段转为可勾选项目")
      const unchecked = content(editor)
      taskCheckboxes(editor)[1].click()
      await waitFor(() => nodes(editor, "taskItem")[1].node.attrs.checked && taskCheckboxes(editor)[1].checked, "勾选没有同步正文和复选框")
      editor.commands.undo()
      assert(content(editor) === unchecked && !taskCheckboxes(editor)[1].checked, "一次撤销未仅恢复勾选状态")
      editor.commands.undo()
      assert(content(editor) === before && taskCheckboxes(editor).length === 0, "创建待办不能单独撤销")
    }
  })

  await check("基础编辑：待办缩进和减少缩进保留文字及完成状态", async ({ editor }) => {
    await setTaskFixture(editor)
    button(activePanel(), "待办清单").click()
    await waitFor(() => taskCheckboxes(editor).length === 3, "待办未创建")
    taskCheckboxes(editor)[1].click()
    await waitFor(() => nodes(editor, "taskItem")[1].node.attrs.checked, "第二项未勾选")
    selectParagraph(editor, "任务乙")
    const indent = await waitFor(() => !button(activePanel(), "列表增加缩进")?.disabled && button(activePanel(), "列表增加缩进"), "待办第二项无法增加缩进")
    indent.click()
    await waitFor(() => nodes(editor, "taskList").length === 2, "待办没有生成嵌套列表")
    const nested = nodes(editor, "taskItem").find(({ node }) => node.firstChild.textContent === "任务乙")
    assert(nested.node.attrs.checked && editor.state.doc.resolve(nested.pos).depth > 1, "缩进丢失完成状态或没有进入子列表")
    selectParagraph(editor, "任务乙")
    const outdent = await waitFor(() => !button(activePanel(), "列表减少缩进")?.disabled && button(activePanel(), "列表减少缩进"), "嵌套待办无法减少缩进")
    outdent.click()
    await waitFor(() => nodes(editor, "taskList").length === 1, "待办没有返回上一层")
    assert(nodes(editor, "taskItem").length === 3 && nodes(editor, "taskItem")[1].node.attrs.checked, "减少缩进丢失项目或完成状态")
    assert(editor.state.doc.textContent === "任务甲任务乙任务丙", "层级调整改变了任务文字")
  })

  await check("编号设置：两种模式支持五种编号和起始号，浏览器列表属性与正文同步", async ({ editor }) => {
    for (const mode of ["ribbon", "compact"]) {
      if (toolbar().dataset.toolbarMode !== mode) await switchMode(mode)
      await setNumberingFixture(editor)
      for (const [type, label] of [["1", "数字"], ["a", "小写字母"], ["A", "大写字母"], ["i", "小写罗马数字"], ["I", "大写罗马数字"]]) {
        const opened = await openNumbering()
        chooseNumbering(opened, label, 7)
        button(opened, "应用编号").click()
        await waitFor(() => !popup() && nodes(editor, "orderedList")[0].node.attrs.type === type && nodes(editor, "orderedList")[0].node.attrs.start === 7, `${label}或起始号未应用`)
        const list = editor.view.dom.querySelector("ol")
        // 官方 OrderedList 省略默认的 type="1"；无 type 的 ol 仍表示十进制编号。
        assert((list.getAttribute("type") || "1") === type && list.getAttribute("start") === "7", `${label}的浏览器列表属性不正确`)
        const other = nodes(editor, "orderedList")[1].node
        assert(other.attrs.type === "A" && other.attrs.start === 3, "编号设置误改另一列表")
      }
    }
  })

  await check("编号设置：原列表前方更新后保持原目标，应用可单次撤销", async ({ editor }) => {
    await setNumberingFixture(editor)
    const opened = await openNumbering()
    chooseNumbering(opened, "大写罗马数字", 9)
    editor.commands.insertContentAt(1, "新增前文", { updateSelection: false })
    selectParagraph(editor, "另一列表")
    const before = content(editor)
    button(opened, "应用编号").click()
    await waitFor(() => !popup() && nodes(editor, "orderedList")[0].node.attrs.start === 9, "原列表移动后没有应用设置")
    const lists = nodes(editor, "orderedList")
    assert(lists[0].node.attrs.type === "I" && lists[1].node.attrs.type === "A" && lists[1].node.attrs.start === 3, "设置跟随了后来选择的列表")
    assert(editor.state.selection.$from.parent.textContent === "列表甲", "应用未恢复原列表光标")
    editor.commands.undo()
    assert(content(editor) === before, "撤销编号同时撤掉前方更新或修改另一列表")
  })

  await check("编号设置：非法起始号、跨列表选区与已删除目标均不能误写", async ({ editor }) => {
    await setNumberingFixture(editor)
    const opened = await openNumbering()
    const before = content(editor)
    for (const value of ["", 0, -1, 1.5, 1000000000]) {
      setInput(byLabel(opened, "起始编号"), value)
      await waitFor(() => button(opened, "应用编号").disabled && opened.querySelector('[role="alert"]'), "非法起始号没有禁止提交或解释原因")
      button(opened, "应用编号").click()
      assert(content(editor) === before && popup() === opened, "非法起始号写入正文或关闭草稿")
    }
    setInput(byLabel(opened, "起始编号"), 8)
    await waitFor(() => !button(opened, "应用编号").disabled, "合法起始号没有恢复提交")
    const original = nodes(editor, "orderedList")[0]
    editor.view.dispatch(editor.state.tr.delete(original.pos, original.pos + original.node.nodeSize))
    const deleted = content(editor)
    await waitFor(() => button(opened, "应用编号").disabled && opened.textContent.includes("原列表已被删除"), "原列表删除后没有终止旧草稿")
    button(opened, "应用编号").click()
    assert(content(editor) === deleted, "失效草稿误写剩余列表")
    button(opened, "取消").click()
    await waitFor(() => !popup(), "取消未关闭编号浮层")
    await setNumberingFixture(editor)
    selectParagraph(editor, "编号前文")
    await waitFor(() => button(activePanel(), "编号设置").disabled, "列表外没有禁用编号入口")
    select(editor, paragraph(editor, "列表甲").pos + 1, paragraph(editor, "另一列表").pos + 2)
    await waitFor(() => button(activePanel(), "编号设置").disabled, "跨两个列表仍允许编号设置")
  })

  await check("编号设置：切换模式、标签和禁写状态均关闭浮层并保留正文", async ({ editor, store }) => {
    await setNumberingFixture(editor)
    const before = content(editor)
    await openNumbering()
    await switchMode("compact")
    await waitFor(() => !popup(), "切模式没有关闭编号设置")
    await openNumbering()
    await switchTab("插入")
    await waitFor(() => !popup(), "切标签没有关闭编号设置")
    await switchTab("开始")
    for (const state of [{ readOnly: true }, { switching: true }]) {
      await openNumbering()
      store.getState().updateView(state)
      await waitFor(() => !popup() && button(activePanel(), "编号设置").disabled, "禁写没有关闭编号浮层和禁用入口")
      store.getState().updateView({ readOnly: false, switching: false })
      await waitFor(() => editor.isEditable && !button(activePanel(), "编号设置").disabled, "恢复编辑后编号入口仍禁用")
    }
    assert(content(editor) === before, "浮层关闭或只读切换改写了正文")
  })

  await check("基础编辑：只读禁用上下标和待办，合成勾选也不能绕过保护且可恢复", async ({ editor, store }) => {
    await setTaskFixture(editor)
    button(activePanel(), "待办清单").click()
    await waitFor(() => taskCheckboxes(editor).length === 3, "待办未创建")
    selectParagraph(editor, "任务甲")
    const before = content(editor)
    store.getState().updateView({ readOnly: true })
    await waitFor(() => !editor.isEditable && taskCheckboxes(editor).every(checkbox => checkbox.disabled), "只读没有禁用正文待办复选框")
    // 只读期间改选区会重新计算工具状态；恢复编辑必须直接恢复按钮，不能依赖再次移动光标。
    selectParagraph(editor, "任务乙")
    const readOnlySelection = JSON.stringify(editor.state.selection.toJSON())
    for (const name of ["上标", "下标", "待办清单"]) {
      const trigger = button(activePanel(), name)
      assert(trigger.disabled, `只读没有禁用${name}`)
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    }
    const checkbox = taskCheckboxes(editor)[0]
    checkbox.checked = true
    checkbox.dispatchEvent(new Event("change", { bubbles: true }))
    assert(content(editor) === before && !checkbox.checked, "合成勾选绕过只读保护或没有撤回临时勾选")
    store.getState().updateView({ readOnly: false })
    await waitFor(() => editor.isEditable && taskCheckboxes(editor).every(item => !item.disabled), "恢复编辑后待办复选框仍禁用")
    await waitFor(() => ["上标", "下标", "待办清单"].every(name => button(activePanel(), name) && !button(activePanel(), name).disabled), "只读期间改选区后恢复编辑，上下标或待办入口仍缓存禁用状态")
    assert(JSON.stringify(editor.state.selection.toJSON()) === readOnlySelection, "恢复编辑意外移动了只读期间选择的光标")
    taskCheckboxes(editor)[0].click()
    await waitFor(() => nodes(editor, "taskItem")[0].node.attrs.checked, "恢复编辑后无法勾选待办")
    editor.commands.undo()
    assert(content(editor) === before, "恢复后的勾选无法单独撤销")
  })
}
