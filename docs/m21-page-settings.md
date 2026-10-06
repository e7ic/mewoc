# M21 · 纸张、页边距与文字水印

后续：[M22 · Word 页面设置往返](m22-word-page-roundtrip.md)已支持本项目文字水印导回，补齐 920×600 交互及 Chrome 系统 PDF，并修复多页打印水印。下文保留 M21 当时的行为与验收边界。

2026-10-04，验收结果 passed。本批补齐页面基础设置，完整／极简模式共用纸张设置弹窗；页面配置随文档保存，并进入历史、模板与支持纸面外观的导出格式。

## 使用方式

1. 打开「页面 → 纸张设置」，选择纸张规格、方向和边距预设；也可分别输入上、右、下、左边距。
2. 勾选「文字水印」，填写文字、颜色、不透明度与角度。弹窗即时预览草稿，正文页面在点击「应用」后更新；取消不修改文档。
3. 点击「应用」保存到当前文档页面配置。非法输入显示错误并保留草稿；暂时进入只读、切换或组合输入状态时不能提交，恢复编辑后可继续使用原草稿。
4. 关闭「文字水印」并应用后移除水印。应用与当前配置相同的设置，不制造额外修订。

页面规格如下，横向交换宽高：

| 纸张 | 纵向宽 × 高 |
| --- | --- |
| A3 | 297 × 420 mm |
| A4 | 210 × 297 mm |
| A5 | 148 × 210 mm |
| Letter | 215.9 × 279.4 mm |

边距预设为常规四边 20 mm、窄四边 12.7 mm、宽四边 25.4 mm。四边可以不相同，数值必须有限且不小于 0；扣除边距后，正文宽、高都至少保留 40 mm。校验按当前纸型与方向计算，恰好 40 mm 的边界合法。

水印为 1–80 个 Unicode 码点的单行普通文字，支持中文和 emoji；空白文本、换行、控制字符和超长输入不能提交。界面保存及各出口显示时去掉首尾空白，文件原值也不能用大量首尾空白绕过 80 码点上限。颜色使用六位 `#RRGGBB`；不透明度为 5%–50%，角度为 -90°–90°，均允许有效小数。默认值为「草稿」、`#797087`、12%、-35°。

文字水印不提供图片、水印字体选择或文字换行。长文本会自动缩小字号，结合旋转后的横、纵包围盒保持在纸面内；不强制最小字号，因此最长文本可能很小。

## 草稿、保存与正文

弹窗按实际编辑过的字段合并到实时页面：只改左边距不会覆盖同时更新的右边距，只改水印文字不会覆盖其他操作更新的颜色或不透明度。未改动水印开关时遵循实时启用状态，不因旧文字草稿恢复已被关闭的水印。

草稿绑定打开时的文档 ID、编辑器和 store；跨工具栏标签与模式保留草稿，实际切换到新文档后旧草稿不能提交。提交时重新读取只读、切换、编辑器生命周期与输入法状态，不依赖滞后的界面禁用快照。

应用页面配置会产生待保存修订。页面设置属于文档元信息，不进入 ProseMirror 正文撤销栈；之后撤销文字只撤销正文，已经应用的纸张和水印保持不变。水印是非交互 SVG 层，位于文字后，不改变正文高度、选区、字数统计、复制内容或正文 JSON。

M21 原验收针对连续正文纸面；后续 [M25 第一批](m25-pagination.md)已改为按正文块实测分页，各编辑页分别显示水印与页码；[第二批](m25-table-pagination.md)接入表格安全行组跨页与重复表头；[第三批](m25-paragraph-pagination.md)接入顶层普通段落与标题按行跨页。不能安全拆分的超高块或完整合并行组仍完整显示在加高纸面，长列表及嵌套容器分页待后续批次。缩放与适应宽度只调整视图比例，不修改页面保存值。

完整页面配置通过独立深复制进入会话和保存快照，纸型、方向、四边边距与水印完整保留在 IndexedDB、Mewoc 文件、本地副本、历史版本与模板实例中。历史和模板预览读取各自快照的页面比例与水印，不读取当前编辑文档的页面。旧文件没有 `watermark` 字段时继续合法，不自动补写字段；显式 `null` 表示无水印。

## 导出行为

| 格式 | 页面与水印 |
| --- | --- |
| Mewoc | 保留完整页面配置，可重新打开继续编辑；旧文件的缺省字段保持缺省。 |
| HTML | 使用实际毫米宽高、四边边距和单层静态 SVG 水印，文字安全转义，水印不进入正文。 |
| 打印视图 | 使用 HTML 的页面规则；清除屏幕纸面 padding，避免边距扣两次。单个水印层在打印时使用 fixed，由浏览器按打印页面重复，位置抵消页边距偏移。 |
| DOCX | 输出真实纸型、方向和页边距；水印是原生 VML 页眉文字路径，按纸面居中、旋转并置于正文后，随页眉逐页重复。确认下载时提示当前导入器不支持这种水印，完整备份需使用 Mewoc。 |
| Markdown | 不保留纸型、方向、页边距或水印；下载前显示转换说明，正文不附加水印文字。 |
| TXT | 不保留页面外观，下载时显示提示；正文和批注文本保持原内容，不附加水印文字。 |

图片、表格和正文流内文本框按所选页面的实际正文区域处理可用宽度。HTML、DOCX 在首次异步工作前固定快照，后续修改原文页面不会混入这一轮输出。DOCX 门面和底层转换器都覆盖此保护。

HTML 打印规则和 iframe 生命周期已自动检查，本批未保存浏览器实际打印出的 PDF；不能据此承诺各浏览器打印结果逐像素一致。DOCX 的实际宿主渲染记录见下方 LibreOffice 证据。

实际将本批导出的带水印 DOCX 交给现有导入器时，会触发旧式图形的严格拒绝规则，见[导回边界](m21-page-settings-evidence/docx-reimport-boundary.json)。本批没有扩展 Word 水印导入；导出说明已明确这个限制，页面导出专项核对实际拒绝行为与提示。需要完整恢复页面设置、水印和资源时使用 `.mewoc.json`。

## 实现与注释

- `tools/page-settings.js` 定义四种尺寸、边距预设、水印默认值、正文尺寸和严格页面校验；未知字段、继承枚举、非有限数及非法水印不能进入持久契约。
- `tools/create-editor-store.js` 在页面应用前验证并深复制，隔离弹窗草稿中的嵌套边距与水印对象；`document-schema.js` 沿用统一页面校验入口。
- `components/LayoutToolbar.jsx` 管理即时预览、显式脏字段合并、会话身份及实时权限；`PaperCanvas.jsx` 按当前规格显示连续纸面。
- `components/PageWatermark.jsx` 与 `tools/page-watermark.js` 共享毫米几何、旋转包围盒及字号，编辑、弹窗、历史、模板、HTML 与 Word 复用相同尺寸计算。
- `tools/page-preview.js` 从预览快照计算尺寸说明和四边缩放；预览不更新当前页面或修订。
- `tools/page-export-layout.js`、`docx-watermark.js` 分别负责静态纸面／打印规则与原生 Word 页眉水印；Markdown/TXT 入口单独呈现降级说明。

代码注释说明旧文件缺省、纯校验不改稿、嵌套对象隔离、正文撤销边界、异步快照、物理单位及各格式的水印层级。

## 验收与证据

最终 Node **576/576**，浏览器四组 **118/118**，全量 lint 与生产构建通过。新增 Node 用例为页面契约／保存 16 项、页面导出 9 项，共 25 项。最终日志为 [Node](m21-page-settings-evidence/node.log)、[lint](m21-page-settings-evidence/lint.log) 与 [构建](m21-page-settings-evidence/build.log)。样式修复后已重新构建成功；npm 对既有项目配置的提示不属于 ESLint 警告。

| 浏览器组 | 结果 | 证据 |
| --- | --- | --- |
| 纸张、边距与水印 | 11/11 | [最终专项](m21-page-settings-evidence/browser-final.json) |
| 常规编辑 | 62/62 | [回归](m21-page-settings-evidence/regression.json) |
| 工具栏 | 29/29 | [工具栏](m21-page-settings-evidence/toolbar.json) |
| 目录、书签与文内链接 | 16/16 | [导航回归](m21-page-settings-evidence/navigation.json) |

四份浏览器控制台记录及[真实操作控制台](m21-page-settings-evidence/manual-console.json)均为空数组，无警告或错误。`browser-first.json` 是初轮结果，不与最终 11 项重复累计；`node-first.log` 是中途验证，最终计数取 `node.log`。

现有 11 项专项已经纳入真实纸面几何与 Unicode 边界：实际 SVG 包围盒、纸面和缩放比例符合尺寸，80 中文字及 90° 水印留在纸面内；81 中文字拒绝提交，80 emoji 可以通过真实表单输入并应用。另覆盖取消、无修改应用、正文撤销隔离、并发字段合并、实时只读／切换／组合输入保护、文档重开与历史快照预览。

通过真实界面下载并核对五种文件，见[下载核对](m21-page-settings-evidence/manual-export-checks.json)。样本采用 A5 横向、四边 12.7 mm、水印「内部资料」、`#6554c0`、18%、-35°：HTML 只有一个水印层；DOCX 为 `11906 × 8391` twips、landscape，并有一个水印页眉；Markdown/TXT 正文不含水印。样本为 [Mewoc](m21-page-settings-evidence/manual-export.mewoc.json)、[HTML](m21-page-settings-evidence/manual-export.html)、[Word](m21-page-settings-evidence/manual-export.docx)、[Markdown](m21-page-settings-evidence/manual-export.md)、[TXT](m21-page-settings-evidence/manual-export.txt)。

真实操作另确认自定义页面保存为模板后，预览使用模板快照的规格和水印，见[深色模板预览](m21-page-settings-evidence/template-preview-dark.png)。页面应用、保存、历史和模板已有的独立身份及完整快照规则保持有效。

## 原生 DOCX 渲染

使用已有 LibreOfficeDev 26.8.0.0.alpha0 将正式入口生成的 DOCX 转为 PDF，再生成 PNG 检查：

1. [短水印 DOCX](m21-page-settings-evidence/word-preview/watermark.docx) 为 A5 纵向、四边 15 mm、「Mewoc 水印验证」、`#AB12EF`、30%、-35°；[PDF](m21-page-settings-evidence/word-preview/watermark.pdf) 共 6 页。[第一页](m21-page-settings-evidence/word-preview/font-page-1.png)与[第二页](m21-page-settings-evidence/word-preview/font-page-2.png)显示完整中文正文，水印居中、旋转、置于文字后，并逐页重复。
2. [长水印 DOCX](m21-page-settings-evidence/word-preview/long-watermark.docx)与[PDF](m21-page-settings-evidence/word-preview/long-watermark.pdf)验证 A5 横向、80 中文码点、90°。水印缩小字号后完整留在纸面内，见[长水印预览](m21-page-settings-evidence/word-preview/long-page-1.png)；[Mewoc 输入](m21-page-settings-evidence/word-preview/long-watermark.mewoc.json)可复验。

运行时缺省 Fontconfig 未检索现有中文字体，初次渲染曾缺字。复验使用临时 Fontconfig 配置读取已有系统字体目录，缓存放在临时目录，没有安装字体。复验流程和宿主边界见[渲染记录](m21-page-settings-evidence/word-preview/README.md)。

上述证据证明原生 VML 水印可由 LibreOffice 解析和逐页输出；本批未运行桌面 Microsoft Word 或 WPS，字体回退及各宿主的逐像素排版差异仍由宿主决定，不承诺原文布局完全还原。

## 界面核对与补验边界

已核对[浅色编辑器](m21-page-settings-evidence/final-editor.png)、[浅色页面设置](m21-page-settings-evidence/settings-final.png)、[深色设置](m21-page-settings-evidence/settings-dark.png)与[底部焦点](m21-page-settings-evidence/settings-footer-dark.png)。1280×720 实际视口下，滚动表单两侧保留 6px 焦点描边空间，Tab 可到达底部取消与应用按钮；对话框底部为 690px，详见[视口记录](m21-page-settings-evidence/viewport-checks.json)。初轮截图保留作为修正过程证据，最终样式以上述文件为准。

请求将浏览器视口改为 920×600 的控制能力未生效，实际仍为 1280×720。另使用真实应用的 920×600 iframe 保存[响应式深色布局](m21-page-settings-evidence/editor-responsive-dark.png)，只核对显示；浏览器控制无法点击其中的控件，因此**没有完成窄窗口弹窗焦点交互补验**。

本批再次实际观察 [Umo 示例](https://www.umodoc.com/demo) 的纸型、方向和水印控件，保存[参考截图](m21-page-settings-evidence/umo-reference.png)与[控件观察](m21-page-settings-evidence/umo-controls.txt)。采用 Mewoc 自己的弹窗、草稿和 Tabler 图标，不宣称功能或交互全面等同 Umo。

## 发现并修复的问题

1. 底层 DOCX 转换器仅浅复制页面，异步期间可能混合旧基准尺寸、新方向和水印；改为首次异步前独立深快照，补充真实 OOXML 回归。
2. 原生文字输入长度按 UTF-16 计数，80 的输入上限使 80 emoji 无法填写；输入上限改为 160 个码元，最终按共享 80 码点契约校验。
3. 普通表单输入样式影响方向单选框尺寸，颜色输入的选择器优先级造成布局不一致；修复样式范围与优先级，专项加入控件尺寸断言，真实界面复验后重建生产包。
4. 原水印文本若只限制 trim 后长度，可用超长空白绕过容量；原值也限制 80 码点，保留纯校验不改稿，新增十万空格拒绝用例。

本批无未解决的具体 P0/P1/P2。仍不包含实时分页、分节、原生 Word/WPS 界面验收、实际浏览器打印 PDF、图片水印，以及上述未完成的窄窗口弹窗焦点交互补验。
