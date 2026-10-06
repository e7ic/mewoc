# 工具栏设计与交互验收

final result: passed

本轮是现有 Mewoc 的工具栏和上下文交互对齐，保留现有产品、编辑能力和文件管理。不是 Umo 全功能复刻。

## 视觉事实与归一化

- 开始参考：用户截图 `/var/folders/dw/wkn4npd92kxc_rghvny5bztw0000gn/T/codex-clipboard-1db7a45b-90df-4a38-bb92-066c6c597980.png`，2288×270。按截图约 2× 密度归一为 [reference-home-1x.png](docs/m14-toolbar-evidence/reference-home-1x.png)，1144×135；源图下方含约 17px 画布。
- 表格参考：用户截图 `/var/folders/dw/wkn4npd92kxc_rghvny5bztw0000gn/T/codex-clipboard-f83335f9-d9dc-4aa5-80a4-4c7b8d541a6e.png`，2308×1066。按 2× 密度归一为 [reference-table-1x.png](docs/m14-toolbar-evidence/reference-table-1x.png)，1154×533。
- 开始实现：[06-home-final-toolbar.jpg](docs/m14-toolbar-evidence/06-home-final-toolbar.jpg)，1144×119；CSS 视口 1144×800、devicePixelRatio=1。截取工具栏，排除 Mewoc 独立标题栏；H3 选中，浅色。
- 表格实现：[12-table-final-toolbar.jpg](docs/m14-toolbar-evidence/12-table-final-toolbar.jpg)，1154×119；CSS 视口 1154×800、devicePixelRatio=1。[13-table-final-full.jpg](docs/m14-toolbar-evidence/13-table-final-full.jpg) 保留完整页面上下文。表格单格选中，合并/拆分禁用，浅色。
- 用户源图密度没有元数据确认，2× 是依据截图分辨率和控件常见尺寸的归一化假设。开始与表格分别在对应 CSS 宽度比对，没有把整个应用的标题/大纲/测试正文当作工具栏差异。
- 最新完整预览：[17-final-preview.jpg](docs/m14-toolbar-evidence/17-final-preview.jpg)，1144×800。正文为本轮在隔离端口创建的验收文档，未改 4177 的用户文档。

## 对比过程与修正

1. 将归一化开始参考与 [02-home-toolbar.jpg](docs/m14-toolbar-evidence/02-home-toolbar.jpg) 放入同一次双图比较：发现 P2 分组过窄，样式卡片从参考约 x755 提前到 x660，视觉节奏不一致。历史组收窄 10px，字体/段落组宽分别调为 350/280px，卡片移至约 x749。
2. 同次比较参考与 [03-home-toolbar-revised.jpg](docs/m14-toolbar-evidence/03-home-toolbar-revised.jpg)：发现 P2 行距文字截断、工具栏高 123px。行距选择器扩至 94px、上下 padding 从 9px 改为 7px。再将参考和最终 `06-home-final-toolbar.jpg` 放在同一输入复核，文字完整，最终工具栏 119px，无剩余 P0/P1/P2。
3. 表格参考、[07-table-initial.jpg](docs/m14-toolbar-evidence/07-table-initial.jpg)、[08-table-align.jpg](docs/m14-toolbar-evidence/08-table-align.jpg) 一同查看：发现表头选中态沿用紫色，与本轮蓝色/中性灰反馈不统一。表头按钮改为中性灰，组合对齐选中边框改蓝色；参考、最终 `12-table-final-toolbar.jpg` 和 `13-table-final-full.jpg` 再次同输入比较后通过。
4. 额外检查 [14-dark.jpg](docs/m14-toolbar-evidence/14-dark.jpg)、[15-narrow-overflow.jpg](docs/m14-toolbar-evidence/15-narrow-overflow.jpg)、[16-compact-final.jpg](docs/m14-toolbar-evidence/16-compact-final.jpg)：深色可读；900px 桌面窗口保留全部标签及左右滚动按钮；单行模式实际减少高度，全部功能可横向访问。验收后已恢复临时视口覆盖和浅色主题。

## 五项表面检查

- **字体与排版**：沿用系统中文字体栈、13px 导航、12px 工具文字、18px 主要图标；字体和行距完整显示。样式卡片保留六级标题的真实字号层次。源字体未提供，未声称字形或抗锯齿逐像素相同。
- **间距与布局**：七标签、双行分组、分隔线和末尾样式卡片符合参考层级。正文工具高 119px，与归一化源工具区约 118px 接近。表格为两行可滚动分组；额外保留 Mewoc 的完整表格设置入口。
- **颜色与状态**：导航和样式卡片采用 #3480f9，工具激活以中性背景呈现。禁用、hover、keyboard focus、保存状态分别可辨。深色沿用主题变量，白色纸张不受工具栏主题影响。
- **资产与清晰度**：M14 原验收使用 Ant Design 图标；2026-10-02 按用户后续要求迁移至 Tabler Outline，详见 [迁移记录](docs/tabler-icons.md)。未增加位图、描摹 SVG 或占位图，原产品品牌保留。图标轮廓遵循所选图标库，不声称与 Umo 的定制图标逐像素相同。
- **文案与内容**：导航顺序与参考一致。字号、字体、保存状态回显真实文档值，未硬编码“默认”或“30 秒钟前保存”。表格按钮沿用“上方插入行”等本地文案，title 解释表头操作。没有添加尚不支持的任务列表、上下标或表格修复假按钮。

## 交互证据与边界

实际操作 `https://www.umodoc.com/demo`：点击单元格自动切表格、单格合并/拆分禁用；打开 3×4 对齐浮层，选择中间居中后读取 vertical-align=middle、text-align=center；退出表格回开始；展开工具栏模式菜单并切经典模式。证据为 `umo-table.jpg`、`umo-table-align.jpg`、`umo-classic.jpg`、`umo-text-selection.jpg`。

M14 补齐相同上下文和原目标保持语义，并保留其单一导出会话和草稿。当时单行模式保留七标签；下方 M15 已将它替换为经典分组下拉。完整表格设置替代源图中的修复入口；隐藏整个工具栏仍不在本轮范围内。

工具栏专项 11/11、全浏览器回归 149/149、Node 394/394、lint 和构建通过。人工操作确认字号步进/一次撤销、表格组合对齐/底色、保存重开、深色和窄宽滚动。最终人工页面、工具栏/段落/模板专项控制台 error 均为空，见 [console-errors.json](docs/m14-toolbar-evidence/console-errors.json)。没有在本轮重新声称完成原生输入法、物理拖动或 Word/WPS 本体验证。

## 结论与后续微调

无未解决 P0/P1/P2。P3：图标库轮廓和本地按钮文案与 Umo 存在适配差异；保留 Mewoc 顶部文件管理、正文和侧栏布局。

## 2026-10-02 · Tabler 迁移补验

按用户选定的 Tabler Outline 替换应用图标，保留 M14 布局与交互。1144×800 下核对开始工具栏、深色主题及单行模式；另核对表格工具栏、文档库弹窗和颜色面板。18px 主工具图标与 16px 表格图标继承 currentColor，选中和禁用状态、提示及焦点行为保持。HEX/RGB/HSB 面板通过公开组合接口替换内部旧图标，没有隐藏旧 SVG 或修改第三方源码。截图及结果在 [tabler-icons-evidence](docs/tabler-icons-evidence/)，当前补验结果 passed。

- [x] 同宽归一化开始/表格对照及修正后复核
- [x] 窄宽、精简、深色和选中/禁用状态
- [x] 真实交互、原目标映射、跨标签草稿与导出生命周期
- [x] 浏览器回归、Node、lint、构建与证据记录

## 2026-10-02 · M15 极简模式与完整模式

final result: passed

依据用户新增经典工具栏截图与 Umo 在线演示，将经典单行交互命名为「极简模式」，双行七标签命名为「完整模式」。两种模式共用现有功能入口；新增日期时间、特殊字符、表情、全选和字数统计。详细语义及边界见 [M15 记录](docs/m15-toolbar-modes.md)。

### 同宽对照

- 实际参考：Umo 演示的经典模式 / 插入组 / 浅色，1280×720 浏览器视口，设置侧栏占 360px，编辑器工具栏宽 920px、高 46.883px。裁切得到 [umo-classic-insert-920.png](docs/m15-toolbar-modes-evidence/umo-classic-insert-920.png)，920×47，未缩放。
- 实际实现：Mewoc 极简模式 / 插入组 / 浅色，CSS 视口 920×720，工具栏宽 920px、高 49px。裁切得到 [minimal-insert-920.png](docs/m15-toolbar-modes-evidence/minimal-insert-920.png)，920×49，未缩放；[完整上下文](docs/m15-toolbar-modes-evidence/minimal-narrow.png)保留独立文件管理栏、正文和大纲。
- 将这两个裁切图放入同一次双图输入比较：左侧分组入口、单行工具、溢出箭头及右侧保存/模式区域层次一致。Mewoc 保留现有能力和文件管理，不添加尚未实现的视频、音频、文本框或折叠详情入口。右侧展示当前模式文字，代替泛化的「切换工具栏」。20px 插入图标沿用用户前一轮要求的放大尺寸；比参考略高 2px 为有意适配。
- 另将 [完整模式](docs/m15-toolbar-modes-evidence/full-insert.png)和[极简模式](docs/m15-toolbar-modes-evidence/minimal-insert.png)同输入复核：双行约 119px，极简单行 49px；两者使用相同的按钮、实际保存状态和稳定挂载面板。

### 表面与交互复核

- 字体、间距：沿用现有系统字体、12px 工具文字；极简图标与文字水平排列，完整模式图标与文字上下排列。窄宽工具不折行，左右滚动后「表情」按钮实际可达。
- 色彩、状态：浅色与 [深色菜单](docs/m15-toolbar-modes-evidence/dark-menu.png)均可读；当前组/模式有勾选与底色，键盘焦点可辨。沿用 Tabler Outline 和主题变量。
- 浮层：[字符网格](docs/m15-toolbar-modes-evidence/characters.png)、[窄宽表情面板](docs/m15-toolbar-modes-evidence/emoji-narrow.png)及[统计弹窗](docs/m15-toolbar-modes-evidence/statistics.png)没有文字覆盖、视口裁切或空白按钮。日期行允许预览换行，长星期日期完整显示。
- 菜单实际键盘操作确认：打开后聚焦当前项，Home/End 与上下方向键可导航，Enter 选择，Escape 关闭并恢复入口焦点。字符网格跨分类方向键导航和 Escape 返回入口已补验。
- 修正 P2：只读切回编辑后，快捷插入按钮一度使用缓存的禁写值；将选区结构和实时编辑权限分离，补充只读恢复回归后通过。菜单换用 Popover + 原生按钮，消除 Menu 内部 Overflow 在测试文档卸载时更新已卸载组件的警告。

最终 Node **413/413**、工具栏浏览器专项 **15/15**、lint、构建通过；最后独立验收页的 [控制台警告和错误](docs/m15-toolbar-modes-evidence/console-errors.json)为空。验证包括原选区插入、一次撤销、模式偏好恢复、临时浮层关闭、跨模式设置草稿与导出任务保留。此次没有重新执行原生输入法或 Word/WPS 本体验收。临时视口与主题已恢复，4177 用户正文未参与测试修改。

无未解决 P0/P1/P2。P3 / 有意差异：品牌、字体轮廓、Tabler 图标、工具顺序和已支持功能集合沿用 Mewoc；没有声称与 Umo 全功能或逐像素等同。

## 2026-10-02 · M16 表格行列选择器

final result: passed

将用户指出的固定「表格 3 × 3」替换为「表格」下拉，表格分组内的「插入表格」复用同一选择器。10 列 × 8 行网格按悬停或焦点显示矩形预览，点击后才插入；自定义行列数与首行表头开关已接入真实编辑命令。保留前轮工具栏间距、Tabler 图标与两种模式，未尝试把全部 Umo 界面复制进应用。

已查看实际 [完整模式 / 深色网格](docs/m16-table-insert-evidence/full-grid-dark.png)、[完整模式 / 浅色网格](docs/m16-table-insert-evidence/full-grid-light.png)和[极简模式 / 自定义尺寸](docs/m16-table-insert-evidence/custom-size.png)：3 行 × 4 列的矩形高亮与尺寸标题一致，文字、网格、表头开关及确认操作清晰。鼠标移过或方向键导航不更改正文；Enter、Space 与数字输入中的 Enter 均实际插入了对应尺寸，单次撤销恢复原内容。

920×600 矮窗口复核发现面板外边缘会越过底部约 8px，已缩小最大高度并保留面板内滚动。[最终矮窗口截图](docs/m16-table-insert-evidence/grid-narrow.png)中 Tab 能滚动到完整可见的「自定义行列」按钮，面板底部为 572px，浮层内边距也保留在视口内。临时视口和测试主题已恢复。

Node 424/424、浏览器工具栏 21/21、lint 与构建通过；最终验收页和人工预览控制台均无警告或错误。覆盖两模式、两入口、网格预览、原目标映射、失效与禁写保护、自定义尺寸、表头关闭和表格后插。没有在主端口 4177 修改用户正文。无未解决 P0/P1/P2。

### M16 焦点描边补修

用户截图进一步指出 P2：自定义行数框的外扩焦点描边被无内边距的滚动面板裁掉。为滚动裁切区增加 6px 内侧留白，以 content-box 和负 margin 保持原外部占位；不移除滚动能力。实测左右字段距裁切边界均为 6px，大于 3px 的描边外扩；[行数修复局部](docs/m16-table-insert-evidence/focus-row-detail.png)和[列数截图](docs/m16-table-insert-evidence/focus-column-dark.png)已核对。920×600 下网格边缘及[滚动后的底部操作](docs/m16-table-insert-evidence/focus-scroll-dark.png)仍可见、可通过键盘到达。生产构建和 diff 检查通过。本次为样式补修，未重复上一段的全量功能测试。补修后 final result: passed。

## 2026-10-02 · 图标与文字对齐

用户指出「视图 → 只读预览」图标偏高。该按钮原先使用行内 SVG 与文字基线排版，现将图标与标签分开，用 inline-flex 垂直居中、6px 间距和 20px 图标；「返回编辑」复用同一布局。见[完整模式](docs/icon-alignment-evidence/view-dark.png)与[极简模式](docs/icon-alignment-evidence/view-compact-dark.png)。

全项目检查同时发现 AntD 按钮图标包装层与分页按钮存在基线偏移：文档库「刷新」「历史版本」图标中心比标签高 2.125px，分页箭头比按钮中心高 2px。分别居中 `.ant-btn-icon` 与上一页/下一页按钮后，实测偏移均为 0px；全选、字数统计、添加批注和模板弹窗也已复核。文件栏、侧栏标题、状态栏、表格工具、模式菜单和导出工具已有居中布局，未扩大修改范围。极简模式 11 个插入入口的图标/标签中心偏移均为 0px。

本次仅修改样式和只读按钮标签结构；深浅主题、模式切换、预览往返和文档库分页均实际操作，lint、生产构建和 diff 检查通过。未修改 4177 的用户正文。

已有工具栏浏览器专项最终 **21/21** 通过，见[验收结果](docs/icon-alignment-evidence/toolbar-results.json)。首轮出现一次特殊字符撤销失败，独立运行未复现；过程中开发服务器还因附件 hook / Provider 热更新而刷新了验收页，控制台保留该历史记录，见[开发控制台记录](docs/icon-alignment-evidence/console-errors.json)。未因此调整撤销逻辑或放宽测试断言。


## 2026-10-03 · M17 基础编辑增强

final result: passed

在既有完整/极简工具栏接入上下标、待办和有序列表的编号下拉。沿用 Tabler 图标尺寸、按钮居中及主题变量。新编号浮层以五种带预览的单选项、起始号和应用/取消组成，原目标保留与禁用状态由真实文档结构控制。

实际核对[浅色面板](docs/m17-basic-editing-evidence/numbering-light.png)、[深色面板](docs/m17-basic-editing-evidence/numbering-dark.png)和[保存重开后的正文](docs/m17-basic-editing-evidence/final-editor.png)，上下标基线、罗马数字及任务层级/勾选清楚可辨。920×600 下[浮层及焦点描边](docs/m17-basic-editing-evidence/numbering-narrow-dark.png)完整可见，输入框左右留白 6px，面板底部 505.7px；已恢复临时视口和测试主题。

Node 461/461、工具栏 29/29、常规编辑 62/62、批注 9/9、lint 与构建通过。首轮批注深比较崩溃和待办尾段历史边界已修复，失败证据保留，严格断言重跑通过。最终验收页及手动预览控制台均无警告/错误。详见 [M17 记录](docs/m17-basic-editing.md)。本轮没有重新声明完成真实输入法或 Word/WPS 验证。

## 2026-10-04 · M18 图片替换与格式标记

选中图片后「插入」显示带 Tabler 图标的「替换图片」，与图片设置和删除并排；读取期间共用忙碌状态。实际核对[图片入口](docs/m18-view-and-image-evidence/image-toolbar-light.png)，图标与文字居中，溢出时可使用左右滚动入口。

「视图 → 格式标记」通过颜色和背景回显启用状态。[浅色](docs/m18-view-and-image-evidence/formatting-light.png)、[深色](docs/m18-view-and-image-evidence/formatting-dark.png)均能辨认 ¶、↵ 和空格点；白纸、原文和段落聚焦反馈保持。实测[920×600 极简模式](docs/m18-view-and-image-evidence/formatting-narrow-dark.png)，格式标记入口完整可见，后续工具由溢出箭头访问。首空段提示已固定在与 ¶ 同一行，并留出符号间距，见[空文档](docs/m18-view-and-image-evidence/empty-marks.png)。

Node 483/483、浏览器 114/114、lint 和构建通过。浏览器按 75%、100%、125% 测量标记启闭后的段落尺寸、正文高度及文字坐标，相同；只读隐藏、开关重开恢复、实际文件字节保存和导出隔离通过。首轮旧 DOM 断言误认光标辅助节点的记录保留，修正后在标记启用和关闭两种状态下常规回归均为 62/62。已恢复临时视口、主题及模式。详见 [M18 记录](docs/m18-view-and-image.md)。

## 2026-10-04 · M19 文本框与折叠详情

final result: passed

参考已实际查看的 [Umo 插入交互](docs/m19-rich-blocks-evidence/umo-reference.png)，接入即时插入的文本框与详情容器。完整／极简模式使用同一入口、原目标书签和设置草稿，沿用 Tabler Outline；完整模式图标与文字上下排列，极简模式水平排列，容器设置与退出／移除按钮居中对齐。没有添加浮动定位、旋转或文字环绕，也不将该文本框作为 Word 浮动布局的完整还原能力。

实际核对[浅色完整模式](docs/m19-rich-blocks-evidence/editor-light.png)、[深色完整模式](docs/m19-rich-blocks-evidence/editor-dark.png)与[深色极简模式](docs/m19-rich-blocks-evidence/compact-dark.png)：工具入口、详情箭头及标题清晰可辨，文本框背景和边框遵循已保存属性；界面主题保持白纸正文。设置表单提供明确单位与范围，非法值就近报错；退出继续正文，移除保留详情标题和内部富文本。

### 焦点描边 P2 补修

920×600 深色极简模式下首次发现内边距数字框右侧紧贴弹窗滚动裁切边界，2px 焦点描边加 2px offset 被裁，见[首轮截图](docs/m19-rich-blocks-evidence/settings-first-narrow-dark.png)。为 `ant-modal-body` 滚动区域增加 6px 内侧留白，通过 content-box 和 -6px margin 保持原表单占位，保留最大高度及局部滚动。

补修后的原生复核确认[内边距输入](docs/m19-rich-blocks-evidence/settings-narrow-dark.png)、[边框宽度输入](docs/m19-rich-blocks-evidence/settings-border-focus-dark.png)和[详情标题](docs/m19-rich-blocks-evidence/details-settings-narrow-dark.png)两侧焦点描边完整。详情标题距左右裁切边界均为 6px，大于 4px 外扩；文本框弹窗底部 417.7px、详情弹窗底部 266.8px，均在 600px 视口内。[视口检查记录](docs/m19-rich-blocks-evidence/viewport-checks.json)保留测量结果，修复后 lint 和最终构建通过。

### 交互、下载与回归

专项覆盖原光标分段插入、完整段落包裹、属性和 marks 保留、设置草稿映射与并发字段、目标删除失效、只读／切换／组合输入守卫、独立撤销、Mod+Enter 退出、详情折叠及搜索／大纲定位。折叠只影响视图，保存、复制和静态导出包含完整正文；选区进入收起内容时自动展开。

真实页面实际下载 Mewoc、HTML、DOCX、Markdown 和 TXT，核对完整详情正文与相应转换行为，见[下载结果](docs/m19-rich-blocks-evidence/manual-export-checks.json)。[Word 转换说明](docs/m19-rich-blocks-evidence/docx-dialog.png)明确文本框转为单格表格、详情展开；[Markdown 预览](docs/m19-rich-blocks-evidence/markdown-dialog.png)说明容器外观不保留。文件样本与详细边界见 [M19 记录](docs/m19-rich-blocks.md)。

Node **509/509**、浏览器 **123/123**（M19 14、常规 62、工具栏 29、M18 13、Word 5）、全量 lint 和最终构建通过；另在默认开发配置复验常规 **62/62**，焦点样式修复后 M19 专项再次 **14/14**。计数见[最终验收汇总](docs/m19-rich-blocks-evidence/verification-summary.json)。M19、常规、工具栏、M18 与[手动编辑器控制台](docs/m19-rich-blocks-evidence/manual-console.json)的警告和错误为空；[Word 日志](docs/m19-rich-blocks-evidence/docx-console.json)保留一条已有 Menu Overflow 组件卸载后更新警告，不将全部日志描述为无警告。

原始异常如实保留：首专项 13/14 的部分复制测试没有同步真实选区，修正测试后 14/14；首常规 56/62 来自测试入口静态／动态混合导入造成 Rsbuild 懒编译 chunk 路径移动，改用测试异步门面后固定配置与默认开发配置均通过。没有因此修改生产 Markdown 转换逻辑，详情见 [异常记录](docs/m19-rich-blocks.md#首轮异常与修正)。

检查结束恢复 1280×720 视口、浅色、完整模式和 100% 缩放，4177 用户正文未参与测试。无未解决的本批容器功能或视觉 P0/P1/P2。仍保留流式布局、Tabler 轮廓和 Mewoc 文件管理差异，不声称 Umo 全功能或逐像素一致；本批未重新执行 Word/WPS 原生排版、系统 PDF 或真实输入法候选验收。

## 2026-10-04 · M20 目录、书签与文内链接

final result: passed

「插入」接入目录与书签，「链接」增加文档位置选项；完整／极简模式共用命令和原目标草稿。沿用 Tabler Outline 尺寸、现有工具栏层级和主题变量。[浅色完整模式](docs/m20-document-navigation-evidence/editor-light.png)与[深色极简模式](docs/m20-document-navigation-evidence/compact-dark.png)中，目录层级、链接文字、选中描边和工具入口清晰可辨。目录采用纸张上的固定配色；深色只作用于编辑器界面。

[书签管理](docs/m20-document-navigation-evidence/bookmarks-light.png)明确显示整段绑定、名称范围与定位／重命名／删除操作。[链接面板](docs/m20-document-navigation-evidence/internal-link-light.png)区分外部地址和文档位置，原链接入口文案保持，缺失目标就近报错。[Word 转换说明](docs/m20-document-navigation-evidence/docx-dialog.png)明确静态目录边界；[Markdown 预览](docs/m20-document-navigation-evidence/markdown-dialog.png)使用真实嵌套列表表达层级。

实际复核 920×600 深色极简模式的[书签重命名](docs/m20-document-navigation-evidence/bookmarks-narrow-dark.png)、[目录设置](docs/m20-document-navigation-evidence/toc-settings-narrow-dark.png)和[文内链接](docs/m20-document-navigation-evidence/internal-link-narrow-dark.png)。前两项输入距离滚动裁切边界左右均为 6px，焦点描边完整；弹窗底部依次为 570px、367.64px、317.22px，均在 600px 视口内。滚动面板保留内容和按钮可达性，未使用隐藏焦点描边的处理。结束时恢复 1280×720、完整模式、跟随系统主题和 100% 缩放。

验收覆盖标题改名实时更新、原位置插入与撤销、设置草稿映射、删除后失效、复制目标重映射、只读定位及自动展开折叠详情。真实页面完成 Command 点击与保存刷新，并下载核对 Mewoc、HTML、DOCX、Markdown、TXT；具体结果见 [M20 使用与验收记录](docs/m20-document-navigation.md)。

Node **551/551**、浏览器 **121/121**（导航 16、常规 62、工具栏 29、容器 14）、lint 与构建通过，四组浏览器和手动预览控制台的警告／错误为空。[验收汇总](docs/m20-document-navigation-evidence/verification-summary.json)记录各组计数，未将重复文件作为额外测试。修复只读默认片段跳转、相邻目录草稿误绑定、Markdown 目录层级、首次目录扫描与本地拖动复制重映射问题。本批无未解决的具体 P0/P1/P2。

未修改 4177 用户正文。本批未重新执行 Word/WPS 原生排版、系统 PDF、真实输入法候选或物理拖动；没有声称 Umo 目录／书签交互或全产品逐像素一致。

## 2026-10-04 · M21 页面规格、边距与文字水印

final result: passed within verified scope

「页面 → 纸张设置」在完整／极简模式共用一份表单。规格、方向、预设与四边毫米边距在前；启用水印后显示文字、颜色、不透明度及角度，并提供仅预览的纸面。沿用 Tabler 图标、主题变量与原有按钮居中规则。[完整模式](docs/m21-page-settings-evidence/final-editor.png)、[极简深色模式](docs/m21-page-settings-evidence/compact-dark.png)中，当前纸型、方向和四边边距清楚可辨；纸面仍保持白底。

实际核对[浅色表单](docs/m21-page-settings-evidence/settings-final.png)、[深色表单](docs/m21-page-settings-evidence/settings-dark.png)和[模板快照预览](docs/m21-page-settings-evidence/template-preview-dark.png)。水印置于正文后，不捕获点击、不进入选区、字符统计或复制；历史和模板从各自保存快照读取规格、水印与纸面比例，不误用当前页面。

发现并修复两处具体 P2：方向 radio 继承全宽文本字段样式，造成纵向／横向逐字竖排；第一次限定字段选择器提高了 specificity，覆盖 42px 色块宽度，挤掉 HEX 输入。最终限定单个 `:not()`，radio 恢复 13px 原生尺寸、方向标签单行，颜色块 42px、HEX 输入同排；现有浏览器专项增加实际几何断言，复验通过。

1280×720 实测弹窗底部 690px，滚动区四周留白 6px，外扩 4px 焦点描边完整。[键盘到达底部](docs/m21-page-settings-evidence/settings-footer-dark.png)后应用／取消按钮完整可见，底部约 646px，Tab 可从角度输入到取消操作，见[实际尺寸记录](docs/m21-page-settings-evidence/viewport-checks.json)。浏览器视口能力对 920×600 请求未生效，未把 1280×720 截图当作窄窗口证据；另以实际应用的 920×600 iframe 核对[极简布局](docs/m21-page-settings-evidence/editor-responsive-dark.png)，但浏览器控制无法点击其中的控件，窄窗口弹窗焦点与操作仍未补验。

Node **576/576**、浏览器 **118/118**（页面 11、常规 62、工具栏 29、导航 16）、lint 和最终构建通过。四组浏览器及手动预览控制台警告／错误为空；初轮 11 项不重复计数。真实界面完成保存刷新、模板保存／预览及五种文件下载。HTML 与 DOCX 保留页面、水印；Markdown 和 TXT 明确提示外观降级。LibreOffice 实际输出确认 DOCX 页眉水印跨六页重复、中文完整，80 字／90° 长水印留在纸面内，见[渲染记录](docs/m21-page-settings-evidence/word-preview/README.md)。

已查看 [Umo 控件参考](docs/m21-page-settings-evidence/umo-reference.png)，本批采用 Mewoc 表单与连续正文布局，不声称 Umo 页面设置的全功能或逐像素一致。编辑区只在首张纸面显示一次水印，没有实时自动分页、页眉页脚编辑或页码。实际核对发现当前 Word 导入器会拒绝带 VML 水印的 DOCX，导出说明已提示保留 Mewoc 完整备份，专项验证其实际拒绝规则；未扩展 Word 水印导入。未执行 Microsoft Word／WPS 原生布局、浏览器系统 PDF、真实输入法候选或物理拖动。范围内无已知未解决的具体 P0/P1/P2；窄窗口交互限制单独保留。验收结束恢复跟随系统主题、完整模式和 100% 缩放，临时视口重置，4177 用户正文未参与测试。
