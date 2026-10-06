# M16 · 表格插入

日期：2026-10-02。将固定插入 3×3 表格的快捷入口改为行列选择器，沿用 Umo 的网格选择交互思路，使用 Mewoc 的主题与 Tabler 图标；本轮不涉及 Umo 界面的逐像素复刻。

## 入口与尺寸

「插入 → 表格」和「表格 → 插入表格」共用选择器，完整模式与极简模式均可使用。

- 网格提供 **10 列 × 8 行**，鼠标经过或键盘焦点只更新矩形高亮及行列预览，确认前不修改正文。
- 「自定义行列」接受整数，最多 **100 行、20 列，且合计不超过 1000 格**。非法值显示具体原因并禁用确认；可返回网格。
- 「首行作为表头」默认开启，网格和自定义插入均可关闭。
- 方向键移动焦点，Home/End 到网格首末格，Enter/Space 插入；自定义表单支持 Enter 提交。Escape 关闭浮层并返回入口焦点。

浮层随可用视口调整宽度；矮窗口通过面板内部滚动保留表头选项、自定义入口及确认操作。

## 插入位置与保护

打开浮层时捕获正文光标或文字选区。普通文字选区确认后由新表格替换；之后移动编辑器光标不会改变原目标。目标随正文根事务及插件追加事务映射，前方插入或段落属性变化仍可正确定位；原范围、段落或所在表格被删除、同位置替换后提示失效，旧浮层不能改写新位置。

光标位于表格内时，新表格插在原表之后，保留原表内容。若导入内容已经包含嵌套表格，则插在最外层表格之后，不继续产生嵌套。节点选区、多单元格选区、全选以及跨越表格边界的文字范围不支持插入，应先定位正文或单个单元格内的文字光标。

只读、文档切换、输入法组合输入和编辑器销毁状态阻止新的插入操作，提交时再次检查当前状态；恢复编辑后无需额外移动光标即可使用。切换分组、模式或进入只读/切换状态会关闭浮层。预览、取消及尺寸校验不写正文；每次成功插入与前后输入分开计入撤销历史，可一次撤销。

实现集中在 `TableInsertAction.jsx`、`table-insert.js` 与 `table-insert.module.scss`；两个工具栏入口复用同一组件和目标映射逻辑，没有新增文档节点类型。

## 验证与证据

Node 全量 **424/424**、浏览器工具栏专项 **21/21**、lint 与生产构建通过。浏览器新增 6 项覆盖两模式和两入口、预览与键盘导航、12×5 无表头自定义插入、非法尺寸、原目标映射与失效、禁写恢复、格内后插和撤销；最终验收页控制台警告与错误记录为空。

实际浏览器键盘操作另验证：Enter 插入 2×2、Space 插入 3×4、自定义表单 Enter 插入 4×6 且关闭表头，均成功撤销恢复。自动化中的输入法保护使用合成组合事件，未将本轮结果扩展为重新完成所有真实输入法验收。

测试入口为 `tests/table-insert.test.js`、`tests/table-insert-checks.js`，后者接入 `tests/toolbar-ribbon-checks.jsx`。本轮保留既有工具栏、设置草稿和导出会话回归。

证据目录：[m16-table-insert-evidence](m16-table-insert-evidence/)。

- [浏览器专项](m16-table-insert-evidence/ribbon.json)、[Node 测试](m16-table-insert-evidence/node-tests.txt)、[lint](m16-table-insert-evidence/lint.txt)、[生产构建](m16-table-insert-evidence/build.txt)、[控制台记录](m16-table-insert-evidence/console-errors.json)。
- 界面记录：[完整模式深色网格](m16-table-insert-evidence/full-grid-dark.png)、[自定义行列](m16-table-insert-evidence/custom-size.png)、[窄窗口网格](m16-table-insert-evidence/grid-narrow.png)。

### 焦点描边补修

用户反馈自定义行数输入框左侧紫色描边被裁切。原因是滚动面板没有内侧留白，输入框 `outline: 2px` 加 `outline-offset: 1px` 超出裁切区。面板增加 6px 内边距，以 `content-box` 和负 margin 保持原内容宽度及弹层间距，同时保留矮窗口滚动。

实际浏览器复核行数、列数、网格边缘及滚动后的底部操作，左右输入框到裁切边界均有 6px 空间；920×600 下滚动和键盘访问正常。此次仅调整样式，完成视觉复核、生产构建及 diff 检查，未重复全量功能测试。[行数局部](m16-table-insert-evidence/focus-row-detail.png)、[列数](m16-table-insert-evidence/focus-column-dark.png)、[滚动面板](m16-table-insert-evidence/focus-scroll-dark.png)、[构建结果](m16-table-insert-evidence/focus-fix-build.txt)。
