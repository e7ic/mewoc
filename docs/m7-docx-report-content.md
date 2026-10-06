# M7 · 实际报告导入修复

日期：2026-09-12。本轮使用用户提供的原始 DOCX 复现问题。原文件 8762074 字节，包含自动目录、嵌套页码引用、目录内容控件、页眉页脚、旧式文本框环绕属性、两张原生图表及其内嵌 XLSX。原入口首先拒绝域内容，单独放开文本框不足以处理此文件。

原文件未复制进仓库，也未修改；仓库只记录哈希、数量与验证结果。自动回归使用合成内容和现有公开样例。

## 最终行为

- 目录、PAGE、NUMPAGES、PAGEREF 仅保留已保存的显示结果，并转成普通文字。支持分段域代码、跨段目录和结果中的嵌套页码引用；无结果、不完整或不支持的域明确拒绝。
- 只展开已识别的目录/页码内容控件；数据绑定和其他表单控件继续拒绝。内部目录书签显示原文字，不再追加 `_Toc` 标识，也不保留跳转行为。
- 页眉页脚按正文引用解析，每份部件保留一次，附于文末并标注。图片和链接按所属部件重新映射关系，避免与正文同名关系串用；不再按页重复。
- 文本框中的 `w10:wrap` 和 `w10:anchorlock` 作为布局属性降级；未知的嵌套内容仍拒绝。
- 普通柱形、折线和饼图的已保存缓存可转为带标题、分类、系列和数值的数据表。明确的零点缓存保留空图表说明，缺缓存、缺点、重复索引、分类错位和无效数值拒绝。
- 原文件第一张图表转为数据表；第二张图表本来就没有数据点，保留其系列及空图表说明。原有两张表格保留，因此编辑器总计三张表格。
- 只有已成功读取缓存的图表所引用的内嵌 XLSX 可作为附属数据略过，工作簿不读取、不执行，也不放入内部转换 ZIP。无关嵌入附件、宏和外部数据关系继续拒绝。

预览逐项提示原排版、自动更新、图形外观及显示格式的变化。此次为内容转换，不承诺 Word 原页面还原；页码仍是原文件保存值，原生图表不再是可编辑的 Word 图表对象。

域的状态处理参考 [Microsoft FieldChar 文档](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.fieldchar?view=openxml-3.0.1)；图表只读取 [NumberingCache](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.charts.numberreference.numberingcache?view=openxml-3.0.1) 等已有缓存，不自行计算工作表公式。

## 验证结果

- 全量 Node 24：202/202；新增合成回归 10 组。最后补充的内嵌工作簿排除断言也在 Node 18 专项通过。
- Node 18.18.0：独立样例、旧式内容及报告专项共 36/36；lint 与生产构建通过，构建 3049.6 kB / gzip 903.0 kB。
- 原文件核对：89 段非空源文字、49 处源图片均能对应；图片字节和出现次数一致，去重后 28 份资源。图片独立校验来自原 ZIP 的关系及内容哈希，不由转换输出生成预期。
- 原文件导入 → DOCX 导出 → 再次导入：文字一致，图片字节与顺序一致；原文件 SHA-256 前后不变。Node 的 Bitmap 只替代尺寸读取与生命周期检查。
- 隔离端口 4180 完整页面：实际选择原文件，看到转换说明及预览，确认导入、保存、刷新恢复均通过。刷新前后 DOM 均为 49 张图片、49 张成功解码、3 张表格；目录无内部书签编号，文末页眉页脚保留。
- 浏览器工具首次选文件后弹窗消失，未计为通过；重试及最终重新选择后通过。部分文件选择调用很慢，刷新后角色定位也曾超时；最终用新 DOM 快照和 DOM 实际图片状态核对，未把工具延迟当成转换耗时。

证据：[源文件核对](m7-docx-evidence/report-content/source-checks.json)、[Node 24](m7-docx-evidence/report-content/node24-tests.txt)、[Node 18](m7-docx-evidence/report-content/node18-tests.txt)、[lint](m7-docx-evidence/report-content/lint.txt)、[构建](m7-docx-evidence/report-content/build.txt)、[界面记录](m7-docx-evidence/report-content/browser.json)。没有进行 Word/WPS 本体重存验收。

本机复验入口：`node scripts/verify-docx-report.js <原文件路径> [仅含统计的结果路径]`。该脚本用于对应原文件的内容/图片核对，不生成新文件来替代原 DOCX。
