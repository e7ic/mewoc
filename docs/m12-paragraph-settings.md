# M12 · 段落精细设置

日期：2026-10-02。入口为「开始 → 段落设置」，光标位于正文或标题时可用，支持跨段选择以及列表、引用和表格内的段落。

## 使用方式

段前、段后间距范围为 0–120 pt，步进 0.5 pt。留空使用原有默认样式，0 为明确的零间距。浏览器相邻段落的垂直 margin 会按 CSS 规则折叠，显示间距不保证等于前后两项相加；Word 使用自己的段落排版规则。

「与下段同页」「段内不分页」分别可选默认、开启、关闭，关闭可以覆盖标题原有的同页规则。设置用于打印和 Word 导出，不会让编辑页面变成实时分页视图。过长段落、表格和页面空间不足等情况仍可能分页，实际结果由浏览器或 Word 的排版程序决定。

跨段不同设置显示混合值。只应用用户修改的字段，其余段落属性各自保留；恢复默认一次清除四项显式设置。每次应用只产生一个独立的正文撤销步骤，不改写文字、批注和目标节点类型。代码块和图片节点不提供这四项段落属性。

打开弹窗时捕获原段落和选区；后续主事务及追加事务均映射原目标。前方插入、段内编辑及合法节点属性变化不会转向其他段落；原段落被删除、同位置替换或合并丢失原节点时，旧草稿不能提交。多单元格选择按各个范围处理，不会误改边界矩形之外的段落。只读、会话切换及组合输入期间禁写，弹窗保留草稿。

## 保存、复制与导出

新增 `spaceBefore`、`spaceAfter`、`keepWithNext`、`keepTogether`，默认均为 `null`；显式数值 0 和布尔 false 与默认分开保存。共享 Schema 限制合法数值和类型，旧文档缺失属性时沿用默认。沿用现有存储版本；旧应用的严格 Schema 可能拒绝带新增属性的文件，请用当前版本打开。

格式刷复制四项显式属性，包括默认值；默认来源会清除目标的显式设置，由目标正文/标题类型决定原有默认样式，不将浏览器计算后的 px 间距偷偷换算成 pt。文档保存、历史检查点、模板和 Mewoc 文件均保留属性。

静态 HTML 与打印共用安全内联样式：`margin-top/bottom` 使用 pt，`break-after/inside` 使用 avoid 或 auto。内部复制粘贴仅保留允许的属性和值，并兼容旧式 `page-break-*`；任意定位、URL 等 CSS 不带入编辑器。非零 px 间距不作为精确 pt 设置导入。

DOCX 导出按 1 pt = 20 twip 转换间距，分别输出 `keepNext`、`keepLines`；false 能覆盖标题默认 `keepNext`。列表、引用和表格原有默认段距仅在对应属性未设置时生效。Markdown 导出提示不保留段前/后间距和分页设置，包括显式 0/false。Word 导入仍按内容语义转换，原文间距与布局不在本批还原范围内，沿用导入预览的格式转换说明。

## 验证与限制

Node 24.13.1 全量 347/347：新增 24 项包含真实 ProseMirror 选区和事务、空段选区边界、split/join、目标同位置替换、不连续 CellSelection、0/false/null、格式刷、Schema、HTML 清理、Mewoc 往返和 Word XML。lint 零 ESLint 警告、生产构建及 `git diff --check` 通过；npm 提示项目 pnpm 配置键不被 npm 识别，不影响运行结果。

内置浏览器 129/129：段落专项 9、图表专项 10、常规编辑 62、文档库 8、历史 11、批注 8、模板 10、Word 导出 5、Word 导入 6。段落专项使用真实 Provider、完整页面、弹窗、IndexedDB 和独立 HTML iframe；包含多段混合值仅修改字段、非法输入修正、只读草稿、书签失效、单次撤销、格式刷、保存/历史/模板/文件以及实际计算样式。

隔离端口 4181 的完整演示文档设置段前 12.5 pt、段后 18 pt，并开启两项分页规则；保存刷新后内联样式全部保留，页面控制台错误为 0。实际下载的 Mewoc、HTML、DOCX 完成 8 项核验：文件字节副本和 SHA-256、Mewoc 读取生成新 ID 且四属性保留、HTML 无编辑控件并保留样式、DOCX 对应 `before=250`、`after=360`、`keepNext` 与 `keepLines`。

点击独立打印入口后，内置浏览器进入原生打印等待状态；工具安全限制禁止访问 Codex 原生窗口，本轮未取得 PDF，也未以打印调用成功替代实际分页验收。已关闭本轮隔离标签页。HTML 计算样式和 Word XML 通过不等于所有浏览器、Word/WPS 的分页视觉一致；实际 PDF 与 Word/WPS 原生分页留待补验。

回归首轮部分标签页恢复到等待运行，随后在代码和构建稳定后重新运行并保存全部最终结果。开发服务日志记录两次浏览器 ResizeObserver 未投递通知，未定位到具体测试且未导致断言失败；手动演示页单独读取的控制台错误列表为空，不能据此宣称所有测试页均无控制台通知。测试只清理本轮随机 fixture ID，没有清空数据库；4177 用户文档未编辑。本批没有重做 Chrome 真实输入法、Safari 物理鼠标、持续运行或 Node 18 验收。

证据：[汇总](m12-paragraph-settings-evidence/checks.json)、[Node](m12-paragraph-settings-evidence/node-tests.txt)、[段落专项](m12-paragraph-settings-evidence/paragraph-browser.json)、[常规编辑](m12-paragraph-settings-evidence/base-browser.json)、[图表](m12-paragraph-settings-evidence/precision-browser.json)、[实际导出](m12-paragraph-settings-evidence/export-roundtrip.json)、[弹窗截图](m12-paragraph-settings-evidence/paragraph-settings.jpg)、[应用效果](m12-paragraph-settings-evidence/paragraph-applied.jpg)。

## 实现入口

- [段落属性](../src/pages/editor/extensions/paragraph-layout.js)、[目标与事务](../src/pages/editor/tools/paragraph-settings.js)、[设置弹窗](../src/pages/editor/components/ParagraphSettings.jsx)
- [格式刷](../src/pages/editor/extensions/format-painter.js)、[粘贴清理](../src/pages/editor/hooks/use-editor-input.js)、[Word 导出](../src/pages/editor/tools/docx-export.js)
- [核心测试](../tests/paragraph-settings.test.js)、[转换集成测试](../tests/paragraph-layout-integration.test.js)、[浏览器专项](../tests/paragraph-settings-checks.jsx)

上一批见[表格与图片精细设置](m11-precision-settings.md)。
