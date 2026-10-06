# M15 · 工具栏模式与快捷工具

日期：2026-10-02。延续 Umo 在线演示中经典工具栏的分组下拉交互，在 Mewoc 现有功能上调整模式并增加快捷工具；没有引入 Umo 实现，也不宣称覆盖其全部功能。

## 两种模式

- **极简模式**：分组下拉、当前组工具、保存状态和模式切换排为单行。
- **完整模式**：保留「开始、插入、表格、工具、页面、视图、导出」七个标签和双行工具。

右侧「切换工具栏」菜单使用以上名称，默认完整模式。偏好通过 `localStorage` 保存在当前浏览器与访问源，不写入文档或撤销历史；存储不可用时仍可在当前会话切换。窄视口通过左右箭头滚动查看溢出工具。

各组面板持续挂载，切换分组或模式保留设置草稿、原目标书签、导出确认与异步任务；临时菜单和快捷插入弹层关闭。分组及模式菜单支持上下箭头、Home/End、Enter/Space 和 Escape，关闭后返回入口焦点。

## 新增入口

「插入」增加日期时间、特殊字符和表情：

| 工具 | 范围 |
| --- | --- |
| 日期时间 | 中文日期、ISO 日期、斜杠日期、中文日期与星期、时分、时分秒、日期时间，共 7 种格式 |
| 特殊字符 | 标点、数学、单位、箭头四组，每组 8 项，共 32 项 |
| 表情 | 表情、手势、工作与日常三组，每组 8 项，共 24 项 |

日期时间使用打开弹层时的本机日历和时间，插入后是普通文本，不自动更新。字符与表情也作为正文文字保存，不增加图片、外部资源或专用节点；外观取决于系统字体。字符网格支持方向键与 Home/End，Escape 关闭并返回入口。

快捷插入保留打开时的文字光标或选区：光标处插入，已有文字选区则替换选中文字。选区书签跟随根事务和插件追加事务映射；原文字块或范围被删除、同位置替换后拒绝继续插入。图片、整表和多单元格选区没有明确文字插入点，入口禁用。每次成功插入构成一次独立撤销，取消和仅切模式不修改正文。

「工具」增加全选与字数统计。全选只改变正文选区，不增加撤销记录；只读时仍可全选或打开统计。统计随正文和选区更新，空选区只显示正文列；多单元格按实际选中范围统计，不包含范围之间未选中的单元格。

统计项目为字符（含空白）、字符（不含空白）和段落数。字符按 Unicode 码点计算，包含正文文字与显式换行，不人为追加段落分隔符，也不加入图片说明、附件说明或公式源码；组合表情可能占多个码点。段落包括正文、标题、代码块及单元格内对应节点。界面沿用「字数统计」入口名称，结果不作中文或其他语言的分词字数。

## 实现与边界

`QuickInsertControls` 和 `quick-insert.js` 管理文字弹层、目标身份与独立撤销；`DocumentTools` 和 `document-statistics.js` 管理选区操作与统计。统计弹窗关闭时不随每次光标移动遍历全文。

快捷插入在只读、文档切换、输入法组合输入或编辑器销毁期间拒绝写入；提交时重新读取状态，不依赖按钮旧状态。全选与统计不写文档，也在文档切换和组合输入期间拦截新的焦点操作。模式及分组菜单使用 AntD Popover 承载原生菜单按钮，避免垂直 AntD Menu 中无必要的 Overflow 卸载测量；未修改第三方源码或屏蔽 React 警告。新增装饰图标使用 Tabler。

## 验证

Node 全量 **413/413**、浏览器工具栏专项 **15/15**、lint 零警告及生产构建通过。替换垂直 Menu 后，最终验收页在切换及卸载流程中未出现 React 状态更新警告，控制台警告与错误记录为空。

自动化入口：`tests/quick-insert.test.js`、`tests/document-statistics.test.js`、`tests/toolbar-preferences.test.js` 与 `tests/toolbar-mode-checks.js`。浏览器专项覆盖模式偏好、键盘导航、原选区插入与撤销、只读恢复、字符及表情、统计和目标失效；本轮不等同于重新完成所有原生输入法或 Word/WPS 验收。

证据保存在 [m15-toolbar-modes-evidence](m15-toolbar-modes-evidence/)：[浏览器专项](m15-toolbar-modes-evidence/ribbon.json)、[Node 测试](m15-toolbar-modes-evidence/node-tests.txt)、[lint](m15-toolbar-modes-evidence/lint.txt)、[构建](m15-toolbar-modes-evidence/build.txt)及[控制台记录](m15-toolbar-modes-evidence/console-errors.json)。画面记录包括 [Umo 经典模式观察](m15-toolbar-modes-evidence/umo-classic-insert.png)、[完整模式](m15-toolbar-modes-evidence/full-insert.png)、[极简模式](m15-toolbar-modes-evidence/minimal-insert.png)、[字符面板](m15-toolbar-modes-evidence/characters.png)及[统计弹窗](m15-toolbar-modes-evidence/statistics.png)。
