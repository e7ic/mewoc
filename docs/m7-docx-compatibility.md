# M7 · 独立 DOCX 样例兼容性回归

后续：[旧式文本框与图片导入](m7-docx-legacy-content.md)已支持本页文本框样例，当前独立样例为 12 份往返通过、6 份明确拒绝；下文保留本批初始验收结果。

日期：2026-09-12。本批为已接入的 Word 导入补充外部固定样例，验证结果为 18/18：11 份允许导入并完成再次导出、重读，7 份按既定边界明确拒绝。全量 Node 24 测试 184/184，Node 18.18.0 本批专项 18/18，lint 与生产构建通过。

## 来源与可复现性

- [Mammoth.js 官方仓库](https://github.com/mwilliamson/mammoth.js/tree/71fe5daa50f85939efc9ea546ac588c4dba56d4c/test/test-data) 1.12.3 对应提交的 17 份 DOCX。
- [python-docx 官方仓库](https://github.com/python-openxml/python-docx/blob/e45454602b53e8e572b179ccf1c91093ec9f4ed7/features/steps/test_files/tbl-cell-access.docx)固定提交的横纵合并样例。

文件直接保存至 `tests/fixtures/docx-compatibility/`，累计 265504 字节。每份文件的来源链接、SHA-256、包内 Application 元数据和许可证对应关系见 [sources.json](../tests/fixtures/docx-compatibility/sources.json)。来源许可证原文保留在同目录；测试不依赖网络，也不执行上游仓库代码。

其中 13 份元数据写明 Microsoft Office Word，1 份写明 Microsoft Macintosh Word，1 份写明 LibreOffice，3 份未提供 Application。元数据是来源线索，不是未经修改或本机操作的证明；本轮没有安装、启动 Word/WPS，也没有获得独立的 WPS 文件。

## 内容与断言

| 范围 | 结果 |
| --- | --- |
| 普通正文、空文档、UTF-8 BOM | 内容保留；空文档可编辑 |
| 文档内嵌样式映射 | 不执行文件自带映射；正文保留 |
| 普通列表 | Apple、Banana 仍为同一无序列表的两项 |
| 下划线与删除线 | 保留原文和指定文字的标记 |
| 两种图片关系路径 | 图片节点、资源数量与再次导出后的图片字节一致 |
| 2×2 普通表格 | 四个单元格位置与文字一致 |
| 四张 3×3 合并表格 | 普通、横向、纵向和 2×2 合并均保留；TableMap 每格对应预期文本，无缺格或重叠问题 |
| 批注、脚注、尾注、文本框、外部图片 | 明确拒绝，不作为成功导入 |
| 严格 Open XML | 仍不支持；提示在 Word 中另存为普通 Word 文档后重试 |

11 份可导入文件均执行“原文件 → 编辑器 JSON → DOCX → 编辑器 JSON”的语义断言，保留文本、列表结构、指定文字标记、表格网格和图片字节。预期来自上游测试断言及原始 XML，不由本项目输出生成。输入字节在前后核对 SHA-256；Node 图片接口仅提供尺寸和清理替身，真实解码证据仍见前批浏览器专项。

新增入口：[docx-compatibility.test.js](../tests/docx-compatibility.test.js)。运行：

```sh
node --import ./tests/setup-node.js --test tests/docx-compatibility.test.js
pnpm test
```

## 界面验证与本轮调整

在隔离端口 4180 的完整编辑器中，实际选择严格格式样例后显示明确拒绝说明，确认按钮保持不可用，原文档仍在。随后重新选择 `tbl-cell-access.docx`，预览、确认导入、自动保存和刷新恢复均成功。页面 DOM 显示 4 张表格，合并范围为 2×1、1×2、2×2；页面截图也核对了合并显示。首次选择期间弹窗曾消失，未取得拒绝结果；在构建完成后的稳定页面重试成功，不将首次尝试计为通过。

生产代码仅调整拒绝说明：脚注、尾注、修订、域、内容控件等使用中文名称，严格 Open XML 单独解释，不再只返回笼统的文件结构提示。没有扩大可接受格式，也没有调整转换或保存逻辑。样例只用于 Node 回归，不加入应用生产入口。

证据：[汇总](m7-docx-evidence/compatibility/acceptance.json)、[Node 24](m7-docx-evidence/compatibility/node24-tests.txt)、[Node 18](m7-docx-evidence/compatibility/node18-tests.txt)、[lint](m7-docx-evidence/compatibility/lint.txt)、[构建](m7-docx-evidence/compatibility/build.txt)。本轮构建 3035.8 kB，gzip 898.8 kB；没有重复前批 Safari 专项或生产预览操作。

## 尚未收口

独立公式和复杂编号样例尚未补足；已有项目生成样例和 XML 变体测试继续通过，但不能作为真实 Word/WPS 作者文件的替代。下一阶段需在实际 Word/WPS 环境中验证公式、编号重启和导出后的原生打开/重存。精确字体、分页与原排版还原仍不在当前语义转换承诺内。前批记录中的分发许可全文缺失问题仍未解决。
