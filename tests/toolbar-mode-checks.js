/**
 * 工具栏模式专项复用主验收的真实会话和查询/切换函数，覆盖偏好恢复与新增工具入口。
 * 检查视图切换和只读读取不改变正文，快捷插入使用原选区且保持独立撤销。
 */
import ReactDOM from "react-dom"
import { TOOLBAR_MODE_KEY } from "../src/pages/editor/tools/toolbar-preferences.js"

// 复用真实编辑器会话和界面查询器，独立覆盖两种布局与新增入口。
// 参数中的 check 会为每个场景重新挂载真实 Workspace，模式/标签交互也经可见菜单执行。
export async function runToolbarModeChecks({ check, host, toolbar, tabs, activePanel, toggle, selectText, switchMode, switchTab, mount, assert, waitFor, button, byLabel, dialog, visible }) {
  // 遍历七个分组后比较正文、选区与 revision，再重挂载验证 localStorage 偏好，而不只看按钮文案。
  await check("工具栏：极简分组覆盖七个工具区，模式偏好跨文档重新挂载保留", async ({ editor, store }) => {
    selectText(editor)
    const body = JSON.stringify(editor.getJSON())
    const selection = editor.state.selection.toJSON()
    const revision = store.getState().revision
    await switchMode("compact")
    assert(tabs().every(element => !visible(element)), "极简模式仍占用整行标签栏")
    const group = byLabel(host, "切换工具分组")
    assert(group && visible(toggle()), "极简模式缺少分组或模式切换入口")
    assert(Math.abs(group.getBoundingClientRect().top - toggle().getBoundingClientRect().top) < 12, "极简模式分组与模式按钮没有同行显示")
    for (const name of ["开始", "插入", "表格", "工具", "页面", "视图", "导出"]) await switchTab(name)
    assert(JSON.stringify(editor.getJSON()) === body && JSON.stringify(editor.state.selection.toJSON()) === JSON.stringify(selection) && store.getState().revision === revision, "分组切换改写正文、选区或 revision")
    assert(localStorage.getItem(TOOLBAR_MODE_KEY) === "compact", "模式偏好没有保存")
    ReactDOM.unmountComponentAtNode(host)
    await mount({ keepMode: true })
    assert(toolbar().dataset.toolbarMode === "compact" && byLabel(host, "切换工具分组"), "重新挂载未恢复极简模式")
    await switchMode("ribbon")
    assert(localStorage.getItem(TOOLBAR_MODE_KEY) === "ribbon", "完整模式选择未替换旧偏好")
  })
  // 对日期、字符、表情统一断言原选区替换与单次撤销；日期核对格式而不硬编码当天值。
  await check("工具栏：快捷日期、字符、表情在两种模式插入原文字选区并可单次撤销", async ({ editor }) => {
    for (const mode of ["ribbon", "compact"]) {
      if (toolbar().dataset.toolbarMode !== mode) await switchMode(mode)
      for (const [label, choice, expected] of [["日期时间", "插入ISO 日期", /^\d{4}-\d{2}-\d{2}$/], ["特殊字符", "插入字符：正负号", "±"], ["表情", "插入表情：微笑", "😀"]]) {
        selectText(editor)
        const before = editor.getJSON()
        const { from, to } = editor.state.selection
        const text = editor.state.doc.textContent
        const selected = editor.state.doc.textBetween(from, to)
        await switchTab("插入")
        button(activePanel(), label).click()
        const item = await waitFor(() => button(document, choice), `${label}选项未打开`)
        const value = label === "日期时间" ? item.querySelector("strong").textContent : expected
        if (expected instanceof RegExp) assert(expected.test(value), "ISO 日期格式不正确")
        item.click()
        await waitFor(() => editor.state.doc.textContent === text.replace(selected, value), `${label}未替换原选区`)
        await waitFor(() => !byLabel(document, `插入${label}`), `${label}插入后浮层未关闭`)
        editor.commands.undo()
        assert(JSON.stringify(editor.getJSON()) === JSON.stringify(before), `${label}插入无法单次撤销`)
      }
    }
  })
  // 浮层关闭与可编辑守卫分别验证，组合输入使用显式合成事件，不能据此宣称覆盖物理输入法。
  await check("工具栏：快捷插入浮层随分组、模式和禁写状态关闭，不能误写正文", async ({ editor, store }) => {
    selectText(editor)
    const before = JSON.stringify(editor.getJSON())
    await switchTab("插入")
    button(activePanel(), "特殊字符").click()
    await waitFor(() => byLabel(document, "插入特殊字符"), "字符浮层未打开")
    await switchMode("compact")
    await waitFor(() => !byLabel(document, "插入特殊字符"), "切模式未关闭字符浮层")
    button(activePanel(), "表情").click()
    await waitFor(() => byLabel(document, "插入表情"), "表情浮层未打开")
    await switchTab("工具")
    await waitFor(() => !byLabel(document, "插入表情"), "切分组未关闭表情浮层")
    await switchTab("插入")
    for (const state of [{ readOnly: true }, { readOnly: false, switching: true }]) {
      store.getState().updateView(state)
      await waitFor(() => ["日期时间", "特殊字符", "表情"].every(name => button(activePanel(), name)?.disabled), "禁写状态未禁用快捷插入")
    }
    store.getState().updateView({ readOnly: false, switching: false })
    await waitFor(() => editor.isEditable && !button(activePanel(), "日期时间").disabled, "恢复编辑未启用日期入口")
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "n" }))
    button(activePanel(), "日期时间").click()
    assert(!byLabel(document, "插入日期时间"), "组合输入期间打开了日期浮层")
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }))
    await waitFor(() => !editor.view.composing, "组合输入保护未退出")
    assert(JSON.stringify(editor.getJSON()) === before, "浮层关闭或禁写保护改写了正文")
  })
  // 只读依然允许选择与统计；全选后正文/选区统计应一致，跨模式稳定弹窗也不能产生文档修订。
  await check("工具栏：全选与字数统计在只读下可用，统计弹窗跨模式保持且不改正文", async ({ editor, store }) => {
    const before = JSON.stringify(editor.getJSON())
    const revision = store.getState().revision
    selectText(editor)
    await switchTab("工具")
    button(activePanel(), "字数统计").click()
    const opened = await waitFor(() => dialog("字数统计"), "字数统计未打开")
    assert(Number(opened.querySelector('[data-statistics-scope="selection"][data-statistics-field="characters"]').textContent) === 6, "当前选区字符数不正确")
    await switchMode("compact")
    assert(dialog("字数统计") === opened, "模式切换卸载了统计弹窗")
    button(opened, "关闭").click()
    await waitFor(() => !dialog("字数统计"), "统计弹窗未关闭")
    store.getState().updateView({ readOnly: true })
    await waitFor(() => !editor.isEditable, "未进入只读")
    button(activePanel(), "全选").click()
    await waitFor(() => editor.state.selection.from === 0 && editor.state.selection.to === editor.state.doc.content.size, "只读下全选未选中正文")
    button(activePanel(), "字数统计").click()
    const currentDialog = await waitFor(() => dialog("字数统计"), "只读下未打开统计")
    for (const key of ["characters", "charactersWithoutWhitespace", "paragraphs"]) {
      assert(currentDialog.querySelector(`[data-statistics-scope="document"][data-statistics-field="${key}"]`).textContent === currentDialog.querySelector(`[data-statistics-scope="selection"][data-statistics-field="${key}"]`).textContent, `全选后${key}统计不一致`)
    }
    button(currentDialog, "关闭").click()
    assert(JSON.stringify(editor.getJSON()) === before && store.getState().revision === revision, "全选或统计改写了正文与 revision")
  })
}
