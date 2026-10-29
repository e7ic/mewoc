# NDA 导入兼容修复

2026-10-29，针对用户指定的 `NDA_Agreement.docx` 修复空页码域与组合编号两处兼容限制。源文件 293180 字节，SHA-256 为 `bbbebbe2d0663fe5766a239fd5a6570a92cdf5f8af114d61ea8b94a083e6e519`。源文件未修改，也未复制进仓库；回归使用合成脱敏样例，归档仅包含数量、编号和校验摘要。

## 根因与结果

源文件页脚的 PAGE 和 NUMPAGES 具备完整的 begin/instruction/separate/end，但没有保存结果文字。原实现只接受已有缓存，因此首先拒绝。只补缓存的内存探针随后在 `%1.%2.` 组合编号处被拒绝。修复前基线 `6426c1d` 和当时工作区有相同首个错误，属于既有支持边界。

- 普通页眉页脚里的完整、独立空 PAGE/NUMPAGES 域转为 `[页码]` / `[总页数]`。保留原有上下文，并明确提示未保存实际数字、不会自动更新；不猜测页数。有缓存的字段继续按原值导入。
- 实际使用十进制组合模板的整个编号实例转为静态编号文字。根据源定义计算起点、覆盖、父级当前值、重启和中断续编，保留逻辑层级与正文格式；制表间隔降为单空格，转换说明明确指出不会自动续编。没有使用组合模板的简单列表继续走原动态列表路径。
- 空域支持不扩展到正文、目录或页码引用，不接受缺分隔、未闭合、嵌套、未知指令或未知内容。组合编号不猜测未出现祖先、字母/罗马组合或未解释的覆盖重启语义；这些输入仍明确拒绝。

页眉页脚仍按既有第三方导入约定，各保留一次并附于文末，不重新创建动态页眉页脚。简单列表的 `)` 转为句点、默认字体/段距和独立分页等已有转换边界保持，并在导入前提示。

## 回归与验收

新增 `docx-empty-page-fields.test.js`、`docx-composite-numbering.test.js` 和 `docx-nda-import.test.js`，覆盖单 run/跨 run/简单空域、缓存保持、损坏结构拒绝、组合编号续编/重启/覆盖、相邻独立列表和联合导出往返。联合回归先复现原报错，再验证两项修复同时生效。旧 Word 原生回存样本继续通过。

全量 Node **872/872** 通过；最后调整页眉页脚提示文案后，相关 **16/16** 再次通过。lint、生产构建和 `git diff --check` 通过。原 NDA 独立文件验收 **120/120**：

| 核对项 | 结果 |
| --- | --- |
| 原始正文 | 90 个段落逐段文字与顺序保持；预期从原 XML 独立读取 |
| 组合编号 | `1.`、`1.1.`、`1.2.` 与独立计算的源编号一致 |
| 表格 | 正文 5×4、页眉 1×2、页脚 1×3，合计 3 表，文字与格结构保持 |
| 图片 | 页眉 PNG 原始 6764 字节保持；浏览器实际解码为 400×116 |
| 页脚 | 原文字保持，两个缺缓存页码各生成一次明确占位 |
| 再导出 | 生产 DOCX 导出后再次导入，正文、编号、表结构和资源语义一致 |
| 原件 | SHA-256 前后不变 |

完整页面通过正式「导入 Word」选择原件，确认预览和转换说明后新建文档，保存、刷新恢复，再从正式导出菜单下载 Mewoc 备份和 DOCX。验收使用本机 4182 服务与内置浏览器；首次选文件工具出现长延迟，不计作产品转换耗时。浏览器文档和下载产物保留在用户本机。

正式下载文件的 13 项检查通过。浏览器备份与当前生产转换的完整内容仅差编辑器追加的一个顶层空段；DOCX 再导入只发现三处格式差异：首标题增加显式加粗，两个静态子条款的段落缩进由 1 回到默认 0。逐项检查这些差异后，正文、编号、表格跨度、页面设置和原图字节均一致，不宣称 DOCX 格式逐属性无损。组合编号文字仍保留层级关系；需保留全部编辑属性时使用 Mewoc 备份。

已保留标题为 `NDA_Agreement` 的本地浏览器文档与 4182 服务，便于继续查看；原 DOCX、正式下载备份和导出 DOCX 均留在用户本机。

证据见 [源文件独立核对](m7-docx-evidence/nda-compatibility/source-checks.json)、[浏览器下载核对](m7-docx-evidence/nda-compatibility/browser-file-checks.json)与[验收汇总](m7-docx-evidence/nda-compatibility/verification-summary.json)。本次证明内容导入和保存/导出往返，不宣称 Word/WPS 原生排版相同，也不标记 M25 全部收口。

计数规则参考 Microsoft 的 [Word 重启实现说明](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/140a2cd9-2f26-456d-9760-ae6ecef4e8b5)、[起始值](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.startnumberingvalue?view=openxml-3.0.1)及[编号后缀](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.levelsuffix?view=openxml-3.0.1)。
