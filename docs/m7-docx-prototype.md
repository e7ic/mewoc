# M7 DOCX 导出最小验证

后续进展：复杂转换和正式入口现已接入，见 [Word 导出接入记录](m7-docx-export.md)。以下为最小原型阶段的历史记录。

2026-09-09：稳定基线已存在于 `5490b65`（`fix: close M5 acceptance and preserve print output`），开始时工作区干净。本轮完成 DOCX 转换原型和样例验证，**不是 M7 正式功能验收完成**；尚未给产品增加 DOCX 菜单。

## 结果与样例

使用工作区提供的 `docx 9.6.1`，生成真实 WordprocessingML 文件。库支持 Node 与浏览器，但本轮实际执行的是 Node 生成与 LibreOffice 渲染，不能据此声明浏览器下载或 Microsoft Word 已通过。[官方介绍](https://docx.js.org/)、[段落 API](https://docx.js.org/api/types/IParagraphOptions.html)、[分页 API](https://docx.js.org/api/classes/PageBreak.html)。

- [竖版样例](m7-docx-evidence/portrait.docx)：A4、四边 20 mm，2 页。
- [横版样例](m7-docx-evidence/landscape.docx)：A4、左边 30 mm，其余 20 mm，2 页。
- 当前 Node 运行时 [8/8 检查](m7-docx-evidence/checks.json)；Node 18.18.0 [8/8 检查](m7-docx-evidence/node18-checks.json)。
- [渲染核对](m7-docx-evidence/render-checks.json)：LibreOfficeDev 26.8.0.0.alpha0，通过 `render_docx.py` 生成 PNG，逐页查看全部 4 页；中文、图表和分页完整，无缺字、重叠或裁切。原型样例保留源文档样式，不应用通用报告模板。
- 原项目 lint、127/127 测试、生产构建通过；构建体积仍为 2111.3 kB / gzip 648.4 kB。未修改 `src`、`package.json` 或锁文件，也未重新安装 Edge。

## 已验证的转换

| 内容 | 本轮处理与证据 |
| --- | --- |
| 正文与标题 | 从应用 JSON 读取正文和 H1–H3 默认字号；样例核对中英文、加粗、下划线、14 pt、文字色、背景色 |
| 行距与缩进 | 1.5 倍行距写成 OOXML 360；正文首行 2 字符写成 480 twip |
| 图片 | PNG/JPEG 内嵌原始字节，PNG 样例验证媒体内容逐字节一致；240×120 px 写成 2286000×1143000 EMU，并保留替代文本 |
| 表格 | 普通 3×3 表格、表头底色、固定列宽；160 px 写成 2400 twip。合并单元格或超宽表格明确拒绝 |
| 纸张 | A4 竖横版、20/30 mm 页边距，XML 尺寸与渲染纸张方向一致 |
| 手动分页 | 写入原生 page break；第二页标题确实从第二页开始 |
| 公式 | 暂以 LaTeX 原文输出，生成结果同时返回转换说明，不声称保留可编辑 Word 公式 |
| 代码块 | 保留源码、空白、换行和等宽字体；本轮不转换语法高亮，并返回说明 |
| 附件 | 保留文件名和原始字节数，说明 DOCX 未内嵌附件；完整备份仍用 Mewoc 文件 |

8 个检查组包括两种完整纸张样例、缺失资源、超宽表格、合并表格、范围外列表、未知节点、H3 字号量化提示。两种完整样例同时检查源数据不变、媒体关系、图片原字节和关键 OOXML 属性。

## 数据与失败路径

`tests/docx-prototype/export.js` 只接收应用快照、Blob 资源 Map 和验证脚本注入的 SDK。开始时复制快照并复用应用 Schema 校验，检查声明的资源字节数与 MIME，再按文档顺序构造 Word 节点；完成后返回文件模型和去重的转换说明。

原型没有 React 状态、网络请求、存储写入、对象 URL、定时器或监听器。`Packer` 只在脚本中生成文件；异常使脚本失败，未实现节点不会静默展平成正文。注入 SDK 是为了让验证使用明确的工作区依赖，本轮不把机器上的运行时路径写进生产模块。

字符缩进以段落基础字号近似 em；混合字号缩进、CSS 数值字重、字体回退与复杂分页还不能宣称完全还原。Word 通常以半磅保存字号，12.75 pt 在此原型取为 13 pt，并返回转换提示。标题默认 600 字重映射到 Word 加粗，不能视为字体笔画完全一致。

## 渲染环境问题

首轮 DOCX 的 XML 含完整中文，但打包的无界面排版引擎未加载中文字体，PNG 出现缺字；该轮不计通过。随后仅给渲染进程传入 `tests/docx-prototype/fontconfig-macos.conf`，读取已有系统字体，中文恢复。

该配置将环境中不可用的 PingFang SC 回退到 Heiti SC；没有安装字体、改写系统偏好或把系统字体打包分发。最终视觉检查证明的是这一字体替换环境中的可读性和页面结构。本机未安装 Microsoft Word，尚未在 Word 本体打开保存，也未验证 WPS。

## 复现

先使用工作区依赖加载工具取得 Node、Python、Node 模块目录和 documents 技能目录。以下参数使用返回的实际路径；原型固定检查 docx 9.6.1，版本不符会拒绝运行。

```sh
"$MEWOC_NODE" --import ./tests/setup-node.js scripts/verify-docx-prototype.js "$MEWOC_NODE_MODULES"
FONTCONFIG_FILE="$PWD/tests/docx-prototype/fontconfig-macos.conf" "$MEWOC_PYTHON" "$MEWOC_DOCS_SKILL/render_docx.py" docs/m7-docx-evidence/portrait.docx --output_dir /private/tmp/mewoc-m7-portrait --emit_pdf
FONTCONFIG_FILE="$PWD/tests/docx-prototype/fontconfig-macos.conf" "$MEWOC_PYTHON" "$MEWOC_DOCS_SKILL/render_docx.py" docs/m7-docx-evidence/landscape.docx --output_dir /private/tmp/mewoc-m7-landscape --emit_pdf
```

验证脚本第三个参数可指定独立输出目录，Node 18 检查使用这一方式，避免覆盖待检查的正式样例。PNG/PDF 为本地核对中间文件，交付样例为 DOCX。

## 正式入口前的剩余工作

1. 补齐列表、引用、分隔线、合并单元格及单元格复杂内容；覆盖长表分页、图片比例和超宽处理。
2. 确定 WebP 转换、公式的 Word 原生格式或明确转换方式、代码高亮与附件说明规则。
3. 在项目内固定生产依赖并按需加载；使用最新快照导出，在等待期间处理重复点击、会话切换与卸载，导出前呈现转换说明。
4. 完成真实浏览器下载与 Microsoft Word/WPS 打开、编辑、保存回读；LibreOffice 渲染不能代替这一步。

## 风格与原理复核

本轮新增脚本、转换原型及必要读取链路确认偏差为零，符合 `$qucm-code-style`。沿用项目的无分号 JS、具名领域函数、中文约束注释及测试模块位置；不增加通用 service 或状态层。按 `$frontend-code-style` 完成白盒核对，项目现有 React 17 / AntD 5 / Rsbuild 与 JS/JSX 约定优先。

1. 为什么横向纸张不能先交换宽高再传给 SDK？SDK 的 `createPageSize` 已按 orientation 交换；重复交换会写回竖向尺寸。
2. 为什么 160 px 列宽与 240 px 图片宽度使用不同倍率？列宽存 twip（1 px = 15 twip），图片范围存 EMU（1 px = 9525 EMU），单位混用会造成严重尺寸偏差。
3. 为什么 XML 中有中文仍不能认定输出通过？文字存在不等于排版引擎拥有对应字形；首轮缺字就是结构检查无法替代视觉检查的实际反例。
4. 为什么转换开头复制快照？读取 Blob 有异步边界；固定正文和页设置避免转换前后读到不同版本，转换本身也不得改写调用方文档。
