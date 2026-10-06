/**
 * 表格插入专项复用真实工具栏验收宿主，覆盖网格、自定义尺寸、原目标映射和表后插入规则。
 * 界面打开与确认走真实组件；直接正文事务只模拟浮层期间的外部编辑，合成键盘只验证导航与取消。
 */
import { NodeSelection } from "@tiptap/pm/state"
import { CellSelection, TableMap } from "@tiptap/pm/tables"

// 从当前不可变正文重建所有表格及 TableMap，断言逻辑行列和插入位置时不使用旧缓存坐标。
const tables = editor => {
  const result = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "table") result.push({ node, pos, map: TableMap.get(node) })
  })
  return result
}
// 完整 JSON 比较同时捕捉正文文字、表格结构和属性变更，用于确认预览不写入及单次撤销边界。
const content = editor => JSON.stringify(editor.getJSON())
const key = (element, value) => element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }))

// 与主工具栏验收共享真实 Workspace；用 UI 打开和提交浮层，直接事务只模拟外部正文变化。
// 合成 keydown 用来验证导航和取消；原生按钮 Enter/Space 的默认 click 另由浏览器交互验收。
export async function runTableInsertChecks({ check, toolbar, activePanel, selectText, selectCell, switchMode, switchTab, assert, waitFor, button, byLabel, setInput, visible }) {
  // 只选择可见的插入浮层，避免稳定挂载的其他工具入口或已关闭 portal 干扰查询。
  const popup = () => [...document.querySelectorAll('[role="dialog"][aria-label="插入表格"]')].find(visible)
  const choice = (opened, rows, cols) => opened.querySelector(`[data-table-size="${rows}x${cols}"]`)
  const alert = opened => [...opened.querySelectorAll('[role="alert"]')].find(visible)
  // 等待可操作入口、可见浮层与焦点进入三个条件，覆盖弹层打开完成后的真实键盘目标。
  const open = async label => {
    const trigger = await waitFor(() => button(activePanel(), label), `缺少${label}入口`)
    assert(!trigger.disabled, `${label}入口不可用`)
    trigger.click()
    const opened = await waitFor(popup, "表格插入浮层未打开")
    await waitFor(() => opened.contains(document.activeElement), "表格插入浮层未接收键盘焦点")
    return { opened, trigger }
  }
  // Escape 经面板事件关闭后再等待 portal 消失，确保下一次打开不会复用旧目标。
  const close = async opened => {
    key(opened, "Escape")
    await waitFor(() => !popup(), "Escape 未收起表格插入浮层")
  }
  // 尺寸检查使用 TableMap 的逻辑行列，再逐格核对首行表头开关，兼顾结构与节点类型。
  const assertSize = (current, rows, cols, header = true) => {
    assert(current?.map.height === rows && current.map.width === cols, `新表格不是 ${rows} 行 × ${cols} 列`)
    current.node.forEach((row, _offset, index) => row.forEach(cell => {
      assert(cell.type.name === (header && index === 0 ? "tableHeader" : "tableCell"), "表头行开关没有正确应用")
    }))
  }

  // 同一规则覆盖完整/极简及插入/表格两个入口，预览必须保持正文、原选区和 revision 不变。
  await check("表格插入：两种模式和两个入口支持网格预览、键盘导航、取消及单次撤销", async ({ editor, store }) => {
    for (const mode of ["ribbon", "compact"]) {
      if (toolbar().dataset.toolbarMode !== mode) await switchMode(mode)
      for (const [group, label] of [["插入", "表格"], ["表格", "插入表格"]]) {
        selectText(editor)
        await switchTab(group)
        const before = content(editor)
        const revision = store.getState().revision
        const selection = JSON.stringify(editor.state.selection.toJSON())
        const { opened, trigger } = await open(label)
        assert(opened.querySelectorAll("[data-table-size]").length === 80, "表格网格不是 10 列 × 8 行")
        choice(opened, 5, 7).dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }))
        await waitFor(() => opened.querySelectorAll('[data-table-size][data-active="true"]').length === 35, "鼠标预览没有高亮 5 行 × 7 列")
        choice(opened, 1, 1).focus()
        key(document.activeElement, "ArrowRight")
        key(document.activeElement, "ArrowDown")
        assert(document.activeElement === choice(opened, 2, 2), "方向键没有按行列移动网格焦点")
        await waitFor(() => opened.querySelectorAll('[data-table-size][data-active="true"]').length === 4, "键盘焦点未更新网格预览")
        key(document.activeElement, "End")
        assert(document.activeElement === choice(opened, 8, 10), "End 未到达网格末格")
        key(document.activeElement, "Home")
        assert(document.activeElement === choice(opened, 1, 1), "Home 未到达网格首格")
        assert(content(editor) === before && store.getState().revision === revision && JSON.stringify(editor.state.selection.toJSON()) === selection, "预览或键盘导航提前改写正文、选区或 revision")
        await close(opened)
        assert(document.activeElement === trigger && content(editor) === before, "取消插入没有返回入口焦点或改写了正文")
        const reopened = (await open(label)).opened
        choice(reopened, 2, 4).click()
        await waitFor(() => !popup() && tables(editor).length === 2, "网格选择没有插入表格并关闭浮层")
        assertSize(tables(editor)[0], 2, 4)
        editor.commands.undo()
        assert(content(editor) === before, "网格插入无法单次撤销")
      }
    }
  })

  await check("表格插入：自定义行列校验、超出网格尺寸和关闭表头真实生效", async ({ editor }) => {
    selectText(editor)
    await switchTab("插入")
    const before = content(editor)
    const opened = (await open("表格")).opened
    button(opened, "自定义行列").click()
    await waitFor(() => byLabel(opened, "行数") && byLabel(opened, "列数"), "自定义行列表单未显示")
    for (const [rows, cols] of [[0, 3], [101, 3], [2.5, 3], [3, 21], [100, 20]]) {
      setInput(byLabel(opened, "行数"), rows)
      setInput(byLabel(opened, "列数"), cols)
      button(opened, "确认插入").click()
      await waitFor(() => alert(opened), `非法尺寸 ${rows}×${cols} 缺少错误提示`)
      assert(popup() === opened && content(editor) === before, "非法自定义尺寸插入或关闭了表格浮层")
    }
    setInput(byLabel(opened, "行数"), 12)
    setInput(byLabel(opened, "列数"), 5)
    const header = byLabel(opened, "首行作为表头") || opened.querySelector('input[type="checkbox"]')
    assert(header?.checked, "表头行没有默认开启")
    header.click()
    button(opened, "确认插入").click()
    await waitFor(() => !popup() && tables(editor).length === 2, "合法自定义表格未插入")
    assertSize(tables(editor)[0], 12, 5, false)
    editor.commands.undo()
    assert(content(editor) === before, "自定义表格无法单次撤销")
    const reopened = (await open("表格")).opened
    button(reopened, "自定义行列").click()
    button(reopened, "返回网格").click()
    await waitFor(() => choice(reopened, 8, 10), "自定义表单无法返回网格")
    await close(reopened)
    assert(content(editor) === before, "返回网格或取消修改了正文")
  })

  // 外部编辑让原选区位置移动，然后另移光标；插入与撤销必须保留外部更新而只替换原范围。
  await check("表格插入：前方更新映射原选区，移动光标不会改变插入目标", async ({ editor }) => {
    selectText(editor)
    const selected = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
    await switchTab("插入")
    const opened = (await open("表格")).opened
    editor.commands.insertContentAt(1, "前方更新", { updateSelection: false })
    editor.commands.setTextSelection(editor.state.doc.content.size - 2)
    const before = content(editor)
    const beforeText = editor.state.doc.textContent
    choice(opened, 3, 5).click()
    await waitFor(() => !popup() && tables(editor).length === 2, "映射后的原选区未插入表格")
    const inserted = tables(editor)
    assertSize(inserted[0], 3, 5)
    assert(inserted[1].node.textContent === "第一格第二格第三格第四格", "插入位置跟随了后来光标或破坏了原表")
    assert(editor.state.doc.textContent === beforeText.replace(selected, "") && editor.state.doc.firstChild.textContent.startsWith("前方更新"), "表格没有替换原文字范围或丢失前方更新")
    editor.commands.undo()
    assert(content(editor) === before, "撤销插入吞掉了先前的正文更新")
  })

  await check("表格插入：原目标删除后提示失效，旧浮层不能在新光标处插入", async ({ editor }) => {
    selectText(editor)
    await switchTab("插入")
    const opened = (await open("表格")).opened
    const oldChoice = choice(opened, 2, 3)
    editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.firstChild.nodeSize))
    const before = content(editor)
    const selection = JSON.stringify(editor.state.selection.toJSON())
    await waitFor(() => alert(opened), "原段落删除后没有告知插入目标失效")
    oldChoice.click()
    assert(content(editor) === before && JSON.stringify(editor.state.selection.toJSON()) === selection, "失效浮层误改了新目标或光标")
    await close(opened)
  })

  // 失活/只读和组合输入不是仅按钮禁用，合成 click 也应被事件内守卫拒绝；结构选区单独覆盖。
  await check("表格插入：切模式分组关闭浮层，禁写及结构选区受保护且可恢复", async ({ editor, store }) => {
    selectText(editor)
    const before = content(editor)
    await switchTab("插入")
    await open("表格")
    await switchMode("compact")
    await waitFor(() => !popup(), "切换模式没有关闭表格浮层")
    await open("表格")
    await switchTab("开始")
    await waitFor(() => !popup(), "切换分组没有关闭表格浮层")
    await switchTab("插入")
    for (const state of [{ readOnly: true }, { switching: true }]) {
      await open("表格")
      store.getState().updateView(state)
      await waitFor(() => !popup() && button(activePanel(), "表格")?.disabled, "禁写未关闭表格浮层和禁用入口")
      button(activePanel(), "表格").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      assert(!popup() && content(editor) === before, "合成点击绕过表格禁写保护")
      store.getState().updateView({ readOnly: false, switching: false })
      await waitFor(() => editor.isEditable && !button(activePanel(), "表格").disabled, "恢复编辑未启用表格入口")
    }
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "n" }))
    button(activePanel(), "表格").click()
    assert(!popup(), "组合输入期间打开了表格浮层")
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }))
    await waitFor(() => !editor.view.composing, "组合输入保护未结束")
    const current = tables(editor)[0]
    const cellPos = index => current.pos + 1 + current.map.map[index]
    for (const selection of [CellSelection.create(editor.state.doc, cellPos(0), cellPos(1)), NodeSelection.create(editor.state.doc, current.pos)]) {
      editor.view.dispatch(editor.state.tr.setSelection(selection))
      await waitFor(() => button(activePanel(), "表格").disabled, "多格或整表选区没有禁用表格插入")
    }
    selectText(editor)
    await waitFor(() => !button(activePanel(), "表格").disabled, "恢复文字选区后表格入口仍禁用")
    await close((await open("表格")).opened)
    assert(content(editor) === before, "浮层关闭、选区保护或恢复过程修改了正文")
  })

  // 单元格入口固定插到原表之后，原表节点完整保留且新表应在顶层，防止嵌套表格破坏 schema。
  await check("表格插入：格内入口在原表后新建，保留原表且不产生嵌套", async ({ editor }) => {
    selectCell(editor)
    await switchTab("表格")
    const original = tables(editor)[0]
    const before = content(editor)
    const opened = (await open("插入表格")).opened
    editor.commands.setTextSelection(editor.state.doc.content.size - 2)
    choice(opened, 4, 6).click()
    await waitFor(() => !popup() && tables(editor).length === 2, "格内入口没有新建第二张表格")
    const inserted = tables(editor)
    assert(JSON.stringify(inserted[0].node.toJSON()) === JSON.stringify(original.node.toJSON()), "格内插入破坏了原表内容")
    assert(inserted[1].pos === original.pos + original.node.nodeSize && editor.state.doc.resolve(inserted[1].pos).depth === 0, "格内插入没有紧接原表或产生了嵌套")
    assertSize(inserted[1], 4, 6)
    editor.commands.undo()
    assert(content(editor) === before, "表格后插入无法单次撤销")
  })
}
