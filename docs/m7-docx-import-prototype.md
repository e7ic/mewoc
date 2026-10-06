# M7 DOCX 导入原型

> 后续进展：已接入正式编辑器，详见 [Word 导入记录](m7-docx-import.md)。下文保留原型完成时的范围与验证结果。

2026-09-12：在已提交的导出基线 `76a3b56`（`feat: add complex DOCX export flow`）上完成独立 Node 导入原型。可将受支持的 DOCX 转为 Mewoc 文件，并验证真实编辑器修改、保存重读、再次导出。正式编辑器还没有 DOCX 导入按钮。

Word/WPS 未安装，本轮没有把这两个应用标记为验收通过。原有三份导出样例及渲染证据保留，见 [导出接入记录](m7-docx-export.md)。导出基线可回溯，但 Word/WPS 打开、编辑、保存重开仍是独立待验项。

## 运行与样例

```sh
node --import ./tests/setup-node.js scripts/verify-docx-import.js
# 自选 DOCX 与独立输出目录（仅原型范围内的文件）
node --import ./tests/setup-node.js scripts/verify-docx-import.js /absolute/source.docx /absolute/output
node --import ./tests/setup-node.js --test tests/docx-import-prototype.test.js
```

[三份样例与往返证据](m7-docx-evidence/import-prototype/checks.json)记录源文件/输出文件/图片哈希。生成的 `portrait.mewoc.json`、`landscape.mewoc.json`、`long-table.mewoc.json` 可以使用编辑器现有「打开」入口查看，标题中带有“DOCX 导入验证”。长表格样例有 48 行正文。横版源文件导入后使用编辑器默认竖版，因此不以文件名宣称页面方向保留。

这些样例来自既有自动生成的 DOCX，不代表 Microsoft Word、WPS 或 Google Docs 来源文件均已验证。测试另从复杂样例中明确移除公式，只用于隔离检查列表、横纵合并、嵌套表格和同图多处引用；完整的复杂公式样例必须拒绝导入。

## 选型结果与边界

原型使用开发依赖 `mammoth 1.12.3`、`jszip 3.10.2`、`image-size 2.0.2`。保留当前导出依赖所使用的 JSZip 版本，没有升级或降级生产依赖。三个库仅在 `tests/docx-import-prototype` 和验证脚本中使用，正式页面不加载它们。

Mammoth 适合提取内容语义，但转换结果不能直接注入页面，也不能视为完整 DOCX 往返格式。当前实现显式禁用外部文件访问和内嵌样式映射，再从临时 DOM 的白名单节点构造编辑器 JSON。[Mammoth 官方说明](https://github.com/mwilliamson/mammoth.js)

| 内容 | 原型行为 |
| --- | --- |
| 中文、英文、段落、标题 | 保留文字，保留三级以内标题；更深标题降为三级并提示 |
| 粗体、斜体、下划线、删除线、链接 | 语义标记保留；不安全链接、书签与相对地址转为文字并提示 |
| 列表 | 可编辑列表；编号起点、字母/罗马样式、续编和复杂嵌套可能变化，必须提示并人工复核 |
| 表格 | 保留内容、横纵合并、嵌套；缺格、重叠、越界拒绝；列宽和视觉样式使用默认值 |
| 图片 | PNG/JPEG/WebP 的签名与尺寸初检，字节内嵌，SHA-256 去重，节点引用独立；本轮样例实际覆盖 PNG，其他格式及完整解码待浏览器专项 |
| 纸张、字体、颜色、间距、分页 | 使用编辑器默认设置；普通换行保留，不保证原分页与布局 |
| 原生公式、修订、域、内容控件、脚注尾注、宏、嵌入对象、非空页眉页脚、批注 | 明确拒绝，提示保留原文件；不让转换器静默丢失这些内容 |
| 其他未识别正文元素或缺图错误 | 转换器的丢弃警告/错误升级为失败，不返回不完整记录 |

因此当前结论是“语义导入原型可运行”，还不足以开放通用 DOCX 导入。下一步应优先解决编号身份/起点与多段列表项、公式导入策略，再迁入正式模块并接入转换确认弹窗及浏览器解码。

## 关键修正与数据流

Mammoth 1.12.3 的表头读取只判断 `w:tblHeader` 是否存在，会把 `w:val="false"` 也视为表头。原型对副本移除显式关闭的标记，保持真实表头和普通单元格的区别，不修改源 Buffer。对应测试确认 3 个表头与 6 个普通单元格。[实现依据](https://github.com/mwilliamson/mammoth.js/blob/master/lib/docx/body-reader.js)

数据流为 `Buffer → ZIP/XML 检查 → Mammoth → 临时 HTML DOM → 白名单 JSON + Blob → validateDocument → 新 record`。每次调用独立拥有 warnings、资源 Map 和预算；不创建 Object URL、不写 IndexedDB、不切换当前编辑文档。图片资源失败直接拒绝，成功也必须在结构校验后才返回记录。

压缩文件不超过 32 MiB、条目不超过 512；通过 JSZip StreamHelper 按实际展开字节限制单项 8 MiB、总量 40 MiB。XML 深度最多 64、单项最多 100000 个元素；HTML 深度最多 48、最多 50000 个节点；表格最多 10000 格。实体声明、异常路径和外部资源关系均拒绝。[JSZip 流读取](https://stuk.github.io/jszip/documentation/api_zipobject/internal_stream.html)

取消会停止消费当前解压流并移除 AbortSignal 监听；Mammoth 和压缩库没有强制中止接口，结束后再次检查 signal，不能宣称取消立即终止所有底层计算。解析器仍在当前 Node 进程内运行，这些限额也不等于面向任意敌意文件的完整隔离沙箱；正式接入前需评估 Worker 与超时策略。

## 验证记录

最终结果：全部测试 153/153；新增导入专项在 Node 24.13.1 与 Node 18.18.0 下均为 13/13；lint 和生产构建通过。构建总量仍为 2484.3 kB / gzip 753.7 kB，生产源文件未改动。

- 新增专项覆盖图文结构、合并、图片去重、危险链接、缺图/伪造签名、坏包、路径、实体、超深结构、高压缩比、取消、未知元素，以及真实 Editor 命令与便携文件往返。
- 样例脚本读取 3 个既有 DOCX，插入“导入后编辑验证”文字，保存并重读 Mewoc 文件，比较完整 JSON 数据和原始图片哈希，再调用正式 DOCX 导出器验证新文字存在。
- 文件比较时按 JSON 数据比较。ProseMirror attrs 的空原型经 JSON 序列化变成普通对象，首次严格原型比较失败；已修正验收断言，没有修改文档数据迁就断言。
- JSZip 的 Node stream 适配器不支持当前尝试的 async iteration，已使用其公开文档中的 StreamHelper 事件和暂停接口，并测试中断和重试。
- 最终命令结果见 [验收汇总](m7-docx-evidence/import-prototype/acceptance.json)。本轮未新增或宣称浏览器导入、Word/WPS 真机验收。

## 风格与原理复核

审查范围为本次新增原型、专项测试、验证脚本及依赖声明。符合 `$qucm-code-style`，确认风格偏差为零。沿用现有同模块双引号、无分号、2 空格和显式领域函数；Node 工具属于独立验证范围，未创建前端第二套服务或状态层。

1. 为什么先复制 Buffer 再 await？调用方可能在异步转换期间修改原始内存，副本固定本次输入。
2. 为什么不能只检查 ZIP 文件大小？很小的压缩输入也可能展开成大量内容，必须按输出字节计数并停止消费。
3. 为什么不能直接把 Mammoth HTML 放进编辑器？它不提供内容安全清理，而且 HTML 节点也不一定满足业务 Schema；白名单转换与统一校验各负责一层边界。
4. 为什么图片转换错误需要再看 messages？转换器会把部分失败收集成消息，Promise 成功不代表每张图都转换成功。
5. 为什么源文件两处图片可以共用 Blob？内容哈希相同时可以共享不可变字节，但每个正文节点仍保留自己的属性与位置。
6. 为什么原生公式暂时直接拒绝？只保留公式中的文字会改变数学结构；在建立可靠的 OMML 映射前，拒绝比无提示丢弃更符合文件内容契约。
