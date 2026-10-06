# M11 · 表格与图片精细设置

日期：2026-10-01。当前光标位于表格时可打开「表格 → 表格设置」，选中图片后可打开「插入 → 图片设置」。

2026-10-02 M14 入口迁移：表格设置从「插入」迁至独立「表格」标签，建表入口在「插入」和「表格」中均保留；图片设置仍在「插入」。下方验证成绩和证据保留 2026-10-01 批次记录。

## 表格

「选中单元格」设置背景颜色、顶部/居中/底部垂直对齐，以及水平和垂直内边距（0–40 px）。多格选择有不同值时显示混合状态，仅修改的字段统一应用，其他字段保持各自设置。「无背景」恢复单元格默认背景；表头仍使用默认表头底色。

「整表边框」设置颜色、粗细（0–6 px）、实线/虚线/点线/无边框，应用到原表格全部单元格。颜色输入使用 #RRGGBB。零粗细与无边框均隐藏线条。

「尺寸」支持选中逻辑列宽（35–2000 px）和选中行最小高度（1–1000 px），也可恢复自动行高或均分整表全部列。合并单元格覆盖的每一个逻辑列同步全表对应列；纵向合并覆盖的各行均在选中范围内。行高是最小值，较多内容仍能撑高，不裁剪文字。均分使用未缩放布局尺寸，宽度或均分无法取得有效数值时拒绝提交。

整批设置只提交一次正文事务，可独立撤销和重做。原表格与选中单元格书签随主事务及 Tiptap 自动修复追加事务映射；删除或同位置替换原目标后拒绝旧草稿。修改选区不会把草稿应用到另一张表。只读或文档切换期间禁写并保留草稿。

## 图片

图片设置包含宽度、高度（1–20000 px）、锁定宽高比例、恢复原始比例、左/中/右对齐、替代文本及说明（各最多 1000 字符）。默认锁定比例，调整任一维度同步另一维；解锁可自由拉伸。恢复原始比例读取当前已解码图片的自然尺寸，图片加载完成后才可操作。此过程不改变图片原始字节，也不新建资源地址。

编辑视图和静态 HTML 以保存的宽高比例显示，过宽图片按正文宽度缩小。右下角拖动和方向键遵循当前比例锁定状态；解锁调整宽度时高度保持原值。拖动只作 DOM 预览，松开才提交一次可撤销事务；失焦、只读、组合输入、正文变化或取消时恢复全部预览样式。打开设置不改写旧图片的小数尺寸，未修改的草稿字段不会覆盖期间其他更新。

图片书签跟踪完整事务链。原图片删除或同位置重插同资源后永久失效，取消会释放书签监听。设置弹窗保持挂载，因此选区变化、删除目标或只读切换不会丢失草稿。两类弹窗的表单区域均可滚动，较矮窗口内标题和关闭按钮保持可见。

## 保存与导出

新属性进入共享 Schema，校验数值、颜色和枚举；编辑、文件校验和静态导出共用同一扩展。单元格直接持有外观属性，不重写 TableView 的表格样式，从而保留官方 colgroup 和列宽行为。内部 HTML 复制粘贴重建安全样式、列宽与图像属性，不带入任意 CSS 或外部图片地址。

当前文档、历史版本、自定义模板与 Mewoc 文件保留精细属性及资源。沿用 IndexedDB v1 和现有文件格式；旧文档未声明新属性时使用默认值，旧版本应用可能拒绝读取带新属性的文件，使用当前版本打开。

HTML 和打印共用静态输出。Word 导出使用原逻辑列宽、最小行高、单元格底色、垂直对齐、内边距、边框，以及图片尺寸和对齐；px 转换为 Word 使用的 twip、1/8 pt 和 EMU。过宽表格/图片按可用区域缩小；窄单元格内边距缩小以保留正文空间，并显示转换说明。纵向合并续行继承外观。Markdown 保留文字并逐类说明列宽、行高、单元格样式无法保留。

Word 导入仍按内容语义转换，保留内容与合并结构，列宽、行高、底色、边框和单元格设置使用默认值，预览中明确提示。图片浮动环绕、裁剪和原 Word 分页不在本批范围内；本批也未做 Word/WPS 原生渲染复核。

## 验证与证据

Node 24.13.1 全量测试 323/323，新增 38 项覆盖表格事务与书签、图片比例及指针取消、完整追加事务映射、导出 XML 单位、文件往返及粘贴清理。lint 零警告、生产构建与 `git diff --check` 通过。JSDOM 26 会在 DOMSerializer 写 CSSOM 时省略 `border-style:none`，因此该 Node 个案补入精确字面声明验证清理解析链；真实浏览器另核验未经修改的 HTML 无边框往返。

内置浏览器验收 120/120：精细设置专项 10、常规编辑 62、文档库 8、历史版本 11、批注 8、模板 10、Word 导出 5、Word 导入 6。专项使用真实 Provider、完整编辑页面、弹窗、IndexedDB 和 HTML iframe，涵盖混合值、逻辑合并、非法输入修正、单次撤销、只读草稿、目标删除替换、持久化及实际计算样式。

隔离端口 4181 的完整页面导入本轮生成样例后，设置单元格底色 #ede8fa、居中垂直对齐、18/12 px 内边距、整表紫色 2 px 虚线、第二列 230 px、第二行最小高度 78 px，以及居中图片 360×206 px。保存刷新后全部保留；实际下载 Mewoc、HTML、DOCX 文件逐项核验，Mewoc 重新读取生成新 ID、资源完整，HTML 使用内嵌图片，DOCX XML 具有对应样式与尺寸。HTML 检查按真实 DOM 排除编辑控件，而不把共享 CSS 中的控件选择器当成控件节点。

测试只清理本轮随机 fixture ID，没有清空数据库。本轮最初回归因代码热更新而重新加载，随后在代码稳定后完整重跑；浏览器控制曾丢失旧标签页引用，重建隔离页后收齐最终证据。4177 上的用户文档未编辑。本批没有重做 Chrome 真实输入法、Safari 物理鼠标、持续运行或 Node 18 验收。

证据：[汇总](m11-precision-settings-evidence/checks.json)、[Node](m11-precision-settings-evidence/node-tests.txt)、[精细专项](m11-precision-settings-evidence/precision-browser.json)、[常规编辑](m11-precision-settings-evidence/base-browser.json)、[文档库](m11-precision-settings-evidence/library-browser.json)、[历史](m11-precision-settings-evidence/history-browser.json)、[批注](m11-precision-settings-evidence/comments-browser.json)、[模板](m11-precision-settings-evidence/templates-browser.json)、[Word 导出](m11-precision-settings-evidence/docx-export-browser.json)、[Word 导入](m11-precision-settings-evidence/docx-import-browser.json)、[真实下载核验](m11-precision-settings-evidence/export-roundtrip.json)。

页面截图：[表格设置](m11-precision-settings-evidence/table-settings.jpg)、[图片设置](m11-precision-settings-evidence/image-settings.jpg)、[应用效果](m11-precision-settings-evidence/precision-applied.jpg)。

## 实现入口

- [表格外观](../src/pages/editor/extensions/table-appearance.js)、[表格事务](../src/pages/editor/tools/table-settings.js)、[表格界面](../src/pages/editor/components/TableSettings.jsx)
- [图片事务](../src/pages/editor/tools/image-settings.js)、[图片界面](../src/pages/editor/components/ImageSettings.jsx)、[图片节点](../src/pages/editor/extensions/document-image.js)
- [粘贴清理](../src/pages/editor/hooks/use-editor-input.js)、[Word 表格](../src/pages/editor/tools/docx-table.js)、[浏览器专项](../tests/precision-settings-checks.jsx)

上一批见[文档模板](m10-document-templates.md)。
