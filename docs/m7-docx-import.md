# M7 · Word 导入接入记录

后续：[独立样例兼容性回归](m7-docx-compatibility.md)已补充 18 份外部固定文件和明确拒绝提示；[旧式文本框与图片导入](m7-docx-legacy-content.md)支持可可靠展开的 VML 内容；[实际报告导入修复](m7-docx-report-content.md)补齐目录、页码、页眉页脚和图表数据转换。下文保留初次接入时的验证结果。

日期：2026-09-12。顶部「导入 Word」已接入正式编辑器：选择 DOCX → 查看纯文本预览与转换说明 → 导入为新文档 → 自动保存 → 刷新恢复 → 再次导出。此前的 [Node 原型](m7-docx-import-prototype.md)保留为历史记录。

## 本次补齐

- 列表从源 XML 重建：保留非 1 起点、字母/罗马编号、独立编号实例、被正文打断后的续编、嵌套与层级重启、样式继承和起点覆盖。与列表文字对齐的后续段落按同项内容导入，并提示复核边界；Word 本身没有对应 HTML 的多段列表项容器，不能仅凭缩进保证所有原稿都判断正确。
- 常用 OMML 转为可编辑 LaTeX：分式、根式、上下标、上下限、大运算符、重音、括号、简单矩阵及函数组合。逐个通过 KaTeX 渲染校验；不支持的结构、属性、普通文字模式或超限公式拒绝整份导入。
- PNG/JPEG/WebP 保留原始字节并去重，表格保留横纵合并、图片/列表单元格及嵌套表格。图片先检查格式、体积和像素，再经真实浏览器解码。
- 转换在独立 Worker 中完成，按需加载；取消、错误、超时和组件卸载统一终止 Worker。主线程解码中的 Bitmap 在返回后关闭；已经开始的浏览器解码不能强制中断，迟到结果不会恢复已关闭的弹窗。
- 确认前只保存候选结果，不创建文档或资源 URL。确认时复用 FileActions 的会话切换流程，先保存当前文档；失败保留当前会话和候选结果，可重试。同步引用阻止快速重复确认。

## 转换边界

这是语义导入，字体、字号、颜色、缩进外观、纸张、边框、底色、图片浮动/裁剪及手动分页不承诺还原。图片显示宽度不超过 520px；引用和代码等样式可能转成普通段落，正文与换行保留。导出样例中的附件本来已转成说明文字，导入不能恢复原始附件。

目前明确拒绝复合/自定义前缀编号、图片编号、法律编号、编号样式链接、非正起点；跳过的空列表层级会收拢并提示。拒绝旧 DOC、加密文件、宏、嵌入对象、修订、域、内容控件、脚注/尾注引用、文本框、非空页眉页脚/批注及外部资源关系。普通超链接经白名单检查。未知转换元素不会被静默忽略。

输入最多 32 MiB、512 个 ZIP 部件，单部件解压 8 MiB、累计解压 40 MiB；XML 深度 64、单文件元素 100000；生成 HTML 最多 2000000 字符、深度 48、50000 个节点，表格网格最多 10000 格。图片单个 5 MiB、总量 20 MiB、四千万像素。Worker 转换限时 30 秒；单条公式 2000 字符，最终文档继续通过现有 Schema 与总量校验。

## 验证结果

| 范围 | 结果与方法 |
| --- | --- |
| Node 24.13.1 | 全部 166/166；包含历史原型 13 项和正式导入 13 项 |
| Node 18.18.0 | 正式导入 13/13；本轮未重新执行冻结安装 |
| lint / 生产构建 | 通过；构建总量 3035.3 kB，gzip 898.5 kB |
| 内置浏览器专项 | 最终代码 6/6；真实 Worker、三类图片解码、坏文件、取消、卸载、保存失败与重试 |
| Safari 原生浏览器专项 | 同一入口 6/6；通过本机 Safari 点击运行，未使用替代内核 |
| 完整编辑器 | 隔离端口 4180 导入复杂样例，确认 3/4/A 编号、多段项、图片、合并和公式，自动保存后刷新恢复，再下载 DOCX |
| 生产预览 | 隔离端口 4181 实际选择文件并导入，生产 Worker 分包正常加载，自动保存后刷新恢复 |
| 再下载文件 | 11437 字节；XML 含 3 个 OMML、2 张表格、2 个 drawing；文件及 SHA-256 已留档 |

开发进程的累计日志曾出现 ResizeObserver 提示与一次 Worker 分包加载失败；日志不足以确定当时归因。最终代码重跑的内置浏览器和 Safari 专项均为 6/6，独立生产页面成功完成转换；不把通过结果扩展成整个开发会话零控制台错误。

Node 测试中的 Bitmap 是尺寸/清理替身，真实图片解码由浏览器专项覆盖。浏览器保存失败用例使用真实 FileActions 配合受控 Context，完整编辑器另验证实际 IndexedDB 成功路径。测试来源为项目生成的复杂样例及内存 XML 变体；没有宣称覆盖所有第三方 Word 文件。Microsoft Word/WPS 本体尚未安装并验收，尚不能作为原生 Word/WPS 兼容性收口。

证据：[汇总](m7-docx-evidence/import-integration/acceptance.json)、[Node 24](m7-docx-evidence/import-integration/node24-tests.txt)、[Node 18](m7-docx-evidence/import-integration/node18-tests.txt)、[构建](m7-docx-evidence/import-integration/build.txt)、[真实下载](m7-docx-evidence/import-integration/editor-roundtrip.docx)。用户的 4177 文档没有被测试替换，临时页面使用独立端口。

## 实现与审查问答

1. **为什么独立拆出 XML、列表、公式、HTML 和会话模块？** 每层处理不同的输入契约；组件只管理选择、预览、取消和确认，不承载转换逻辑。新文件采用现有 JavaScript/JSX、双引号、无末尾分号、具名导出与 Sass Modules 写法。
2. **为何不使用 Mammoth 默认列表分组？** 默认分组不足以保留实例起点及多段项；固定版本只借用段落变换 API，强制逐段输出并核对源段落数量，编号统一从 XML 计算。XML 与转换后的段落次序不一致时停止，避免套错编号。
3. **正文和候选数据由谁持有？** 正文仍由 Tiptap 与现有保存会话持有；弹窗只持有未确认的候选记录。没有增加全局状态、镜像正文或重复保存接口。
4. **异步结束后是否会写回旧组件？** 每次选择/关闭/卸载递增版本并取消旧任务；写回前核对版本。Worker 终止、监听器和计时器清理统一由 finish 处理，Bitmap 使用 finally 关闭。
5. **导入失败是否损坏旧文档？** 类型/转换/渲染/Schema 校验先完成；确认后旧文档保存成功才切换。失败、取消和重复点击均有测试，候选数据不预先进入 IndexedDB。
6. **验证是否只是复述实现？** 测试断言起始编号与续编值、转换后的公式再次导出 OMML、表格与资源数量、真实解码失败、Worker 存活数归零及旧会话保留；完整页面额外观察刷新恢复和实际下载。已审查本轮风格偏差并修复引号问题，无已确认偏差留存。

## 依赖与后续

运行依赖固定为 Mammoth 1.12.3、JSZip 3.10.2、image-size 2.0.2、xmldom 0.8.15、hash.js 1.1.7；后两者此前已为传递依赖。转换器位于异步 Worker 分包，sha256 不依赖只在安全上下文可用的 crypto.subtle。Node 验证入口和浏览器入口向 SDK 传入同一块字节的 buffer / arrayBuffer，不引入 Node 内置模块到浏览器链路。

许可证清单已更新为 242 个运行依赖。toggle-selection 原有缺失，以及新增传递依赖 dingbat-to-unicode 1.0.1 的全文缺失均已如实记录。已查其官方 js-1.0.1 标签（提交 b27f259b49907f99b1b9097abba5a9668106b779），该版本仓库同样未附许可证全文；包元数据声明 BSD-2-Clause，不自行补造版权声明。对外分发前仍需补足来源与许可证审计。

下一步使用由真实 Word/WPS 保存的代表性文件建立兼容性样例，优先验证编号重启、公式样式和合并表格，再按样例决定扩展范围；本轮不把未验证格式自动放开。

参考：[Mammoth 官方 API](https://github.com/mwilliamson/mammoth.js)、[编号起点覆盖](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.leveloverride?view=openxml-3.0.1)、[层级重启](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.levelrestart?view=openxml-3.0.1)、[Rsbuild Worker](https://rsbuild.rs/guide/basic/web-workers)、[JSZip 流式读取](https://stuk.github.io/jszip/documentation/api_zipobject/internal_stream.html)。实际行为同时核对已安装的固定版本源码与测试。
