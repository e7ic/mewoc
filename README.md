# Mewoc

参考 Umo Editor 核心体验独立实现的桌面文档编辑器。React 17 + Tiptap 3 + Ant Design 5 + Zustand，使用 Rsbuild 构建，全部应用源码使用 JavaScript / JSX。首期功能与 M6 七项扩展已实现；M5 当前版本验收已收口，结果见[收口记录](docs/m5-closure.md)。

## 本地运行

支持 Node.js 18.18+（18.x）、20.9+（20.x）或 21.1+，pnpm **10.34.5**；版本以 package.json、pnpm-lock.yaml 为准。Node 18 用户需要使用 pnpm 10，pnpm 11 无法在 Node 18 上启动。已在 Node 18.18.0 全新安装目录验证测试和构建；兼容说明见 [Node 18 调整记录](docs/node18-compatibility.md)。

```sh
pnpm install --frozen-lockfile
pnpm dev --port 4177
```

打开 http://127.0.0.1:4177 。文档按浏览器和访问源保存在 IndexedDB；更换端口、浏览器或清理站点数据不会共享原来的本地文档。跨设备或独立备份请导出 `.mewoc.json`，文件包含当前文档引用的图片和附件。

```sh
pnpm lint
pnpm test
pnpm build
pnpm preview --port 4178
pnpm licenses:collect
```

局域网访问时先构建，再监听全部网卡：

```sh
pnpm build
pnpm preview --host 0.0.0.0 --port 4180
```

同一局域网设备打开启动输出中物理网卡对应的 `Network` 地址。文档仍按设备、浏览器与访问源分别保存在本地，不会自动同步；跨设备使用 Mewoc 文件传递。普通 HTTP 的 ID 生成兼容修复及验证见[局域网访问记录](docs/lan-access.md)。

## 已实现

- 新建、打开 Mewoc 文件、最近文档、标题、自动/手动保存、刷新恢复上次打开文档、版本冲突提示。
- 文字格式、字体、字号、颜色、背景色、H1–H3、段落行距/对齐、列表、链接、撤销/重做。
- 格式刷：单次/连续复制文字与段落样式，保留目标链接和结构；Esc 退出，每次格式变更可独立撤销。
- 段落缩进：首行 0–4 字符、左侧 0–8 字符，支持多段设置、混合状态、格式刷、保存与 HTML/打印输出。
- 界面主题：视图中切换浅色、深色、跟随系统；自动保存偏好并同步其他标签页，文档纸张保持白底。
- 公式：行内/独立 LaTeX 公式，支持预览、选中编辑、删除和撤销；源码随文档保存，HTML/打印输出内嵌 MathML。
- 代码块：纯文本及 JavaScript、HTML、CSS、JSON、Bash、Python 高亮；语言选择、整行缩进、继承缩进换行、退出正文和撤销，保存/复制/HTML 输出保留源码与语言。
- Markdown：选择 UTF-8 文件或粘贴源码，预览转换后新建文档；导出前查看实际源码和转换说明，支持代码块、公式及普通 GFM 表格。
- 本地图片插入/粘贴/拖入、等比调整、替代文本；表格增删行列、合并/拆分、表头和列宽调整。
- 附件：选择本地文件插入下载卡片，支持保存恢复、只读下载、删除撤销及 Mewoc 文件往返；HTML 内嵌附件下载数据。
- A4 横竖版、页边距、50%–150% 缩放、适应宽度、手动分页符、大纲、字符统计、查找替换、只读。
- 含图片与附件的 JSON、Word（DOCX）、静态 HTML、纯文本导出，以及独立打印文档入口。

图片支持 PNG/JPEG/WebP；附件通过本地文件选择器插入，保留原始字节，只提供下载。图片或附件单个最多 5 MiB，文档资源合计最多 20 MiB；外链图片不自动下载。正文是连续纸张容器；没有实时自动分页、协作、AI、批注或修订。打印由浏览器控制，可在系统打印窗口选择另存 PDF。请核对 A4 方向、页眉页脚和背景选项；Safari 可能不会沿用文档横向设置，需要在系统窗口选择横排。

保存停顿为 800 ms，连续输入最长等待约 5 s；成功状态明确为“已保存到此浏览器”。写入失败保留编辑内容，仍可尝试导出文件。冲突时先导出当前副本，再刷新读取存储版本；导入导出的文件会生成新的文档 ID。浏览器关闭/崩溃前的最后一次输入不保证已经落盘。

## 代码入口

```text
rsbuild.config.js                    React / Sass 插件、HTML 与开发验收入口
src/main.jsx                         React 17 入口、AntD 5 中文与主题配置
src/pages/editor/EditorPage.jsx       本地文档加载与会话切换
src/pages/editor/components/          工具栏、纸张、表单和领域 Context
src/pages/editor/hooks/               保存、图片、附件、选区、输入生命周期
src/pages/editor/tools/               Schema、IndexedDB、快照、文件与打印
src/pages/editor/extensions/          图片、附件、表格列宽、格式刷、段落行距、分页符、公式、代码块
src/pages/editor/sass/                Sass CSS Modules 与内容样式
tests/                               自动化与浏览器验收
```

Tiptap 是正文、选区与正文撤销的唯一所有者；Zustand 按编辑器实例创建，保存标题、纸张、界面状态和 revision。没有后端、账号或虚构保存接口。服务端适配契约保留在实施方案中，尚未实现宿主 SDK。

## 验证状态

2026-09-09：M7 已将 [Word 导出](docs/m7-docx-export.md)接入编辑器，支持嵌套列表、合并表格、复杂单元格、常用可编辑公式、代码高亮与 WebP 转 PNG。下载前展示实际转换说明；Microsoft Word/WPS 本体验证仍待补。[最小原型记录](docs/m7-docx-prototype.md)保留作为阶段证据。

2026-09-08：M5 当前版本验收收口。当前版本 Chrome / Edge / Safari 功能回归均为 62/62，三组独立压力样例均通过，三个浏览器的 30 轮生命周期均通过；真实双拼输入、Safari 选区/图表拖动及当前 PDF 输出已取得证据。Node 18.18.0 / 24.13.1 均为 127/127 测试通过，lint 和生产构建通过。Chrome 另完成 720/720 轮、65 分 40 秒持续验收，指定资源每轮归零。完整证据与异常留档见 [M5 收口记录](docs/m5-closure.md)。

M6 已完成格式刷、[段落缩进](docs/m6-paragraph-indent.md)、[界面主题](docs/m6-theme.md)、[公式](docs/m6-formula.md)、[代码块与高亮](docs/m6-code-block.md)、[Markdown 导入/导出](docs/m6-markdown.md)和[附件](docs/m6-attachments.md)。2026-09-08 本批在 Node 18.20.6 下 117 项测试、lint、生产构建通过，内置浏览器常规回归 56 项通过；此前 Markdown 批次在 Node 18.18 下的验证记录保留。此处为当时批次记录，后续完整验收见上方 M5 收口记录。

2026-09-08 后续修复[标题格式刷与字号回显](docs/heading-format-fix.md)：默认标题字号、字重、颜色和行距可以刷到正文；字号控件按实际 pt 值显示，H1 / H2 / H3 分别为 22.5 / 15 / 12.75，手动字号优先。最新 125 项测试、lint、构建及 62 项浏览器回归通过。

在「插入 → 附件」选择单个本地文件；选中卡片后可删除，删除和插入均可撤销。Mewoc 文件保留原文件名、MIME 和字节；HTML 提供内嵌下载，打印、Markdown 与纯文本保留文件说明，Markdown 同时提示转换。附件不提供在线预览、服务端上传或拖入识别。实际下载的 112 字节验收文件与源文件 SHA-256 一致；系统落盘、浏览器覆盖范围及一次未复现的 UI 操作现象详见附件记录。

使用顶部「导入 Markdown」，或「导出 → Markdown 文档」。导入源码最多 200000 字符，UTF-8 文件最多 1 MiB。图片转换为说明文字，HTML 源码按文字保留；合并表格和无法表达的排版会显示转换说明。Markdown 用于内容交换，完整样式、图片与附件备份继续使用 Mewoc 文件。

在「插入 → 代码块」将当前纯文字段落转为代码块；Tab / Shift+Tab 调整缩进，Enter 继承缩进，⌘ / Ctrl+Enter 继续正文。高亮按需加载，单块超过 20000 字符或累计超过 100000 字符时按纯文本显示；未知语言保留原属性，不截断源码。HTML/打印内嵌高亮样式，打印允许长行折行；本轮 Edge/Safari 代码块回归及 Safari 系统打印已补验；真实输入法样例位于普通正文，不扩展为所有代码语言的组合输入证明。

公式渲染器 KaTeX 0.18.4 按需加载，采用原生 MathML；导出不依赖外链字体、样式或脚本。单条源码最多 2000 字符、文档累计最多 100000 字符。不自动转换 `$` 输入；编辑已有公式时保留显示类型。本轮 Edge/Safari 公式回归及 Safari 系统打印已补验。

新增缩进属性默认 0，旧资源未声明 kind 时继续作为图片读取；新程序可读取旧文件。旧程序的严格校验会拒绝携带新增属性、公式或附件节点的文件，文件协议尚未发布，不宣称双向兼容。

当前构建使用 AntD 5.29.3、Rsbuild 1.7.6，Vite 已移除；历史迁移见 [AntD v5 / Rsbuild 记录](docs/stack-migration.md)。2026-09-08 为支持 Node 18，调整构建及公式依赖；Node 18.18 下冻结安装、46 项测试、lint、构建和内置浏览器 38 项回归通过，Node 24.13.1 下 46 项测试也通过。开发服务保留 `/tests/browser.html`、`/tests/lifecycle.html`、`/tests/pointer.html`，请用 `pnpm dev --port 4179` 启动隔离验收；生产包只含应用入口。

最新 M5 记录见 [稳定性验收](docs/m5-validation.md) 与 [原生及持续运行补验](docs/m5-native-soak.md)：已修复批量插图、Safari 列宽、打印取消、删图后的资源积累、图片/表格拖动取消及查找旧替换词残留。当时 17 项 Node 测试通过；Chrome / Safari / Edge 均已通过常规功能、30 轮生命周期和三组独立压力样例，Edge 补验了系统文件导入及保存恢复。Chrome 另完成 180 轮、约 15 分钟持续运行，指定资源每轮归零，堆采样已留档。Chrome / Safari 原生打印预览已补验。这是恢复验收前的历史状态；真实 IME、跨窗口指针复核与当前运行证据见 [M5 收口记录](docs/m5-closure.md)。资源计数与堆估算不等于完整进程无泄漏证明。

以下为首期实现时的历史验收记录，最新结果以上述 M5 文档为准。

2026-09-06：lint、12 项 Node 测试和生产构建通过。开发服务器的 `/tests/browser.html` 可运行 22 项真实浏览器功能检查，另记录一条 1 万字操作耗时。拖动用例是合成事件，图片指针捕获使用测试替身。请在专用浏览器/端口运行测试页；用例会创建本地测试文档，正常结束后清理本次创建的文档，运行前刷新或中断可能留下测试记录。

真实拼音输入法、物理鼠标/系统选图窗口、Edge/Safari、原生打印预览与复杂压力样例尚未完成验收。构建仍有 Tiptap `use client` 指令忽略提示和 AntD 界面分包大于 500 kB 提示。详细证据、实现裁定和后续清单见 [编码与验收记录](docs/implementation-notes.md)。

## 来源与许可记录

本项目没有复制 Umo 源文件、商标图片或 Umo Next 商业代码。参考范围与许可调研见 [技术调研](docs/umo-react-research.md)。项目自身尚未指定发布许可证，package.json 保持 private。

[运行依赖清单](docs/runtime-dependencies.json) 记录 206 个已安装运行依赖；[第三方声明](public/THIRD_PARTY_NOTICES.txt) 保留可取得的许可全文，包括 KaTeX、lowlight、unified / remark 的 MIT 许可及 highlight.js 的 BSD-3-Clause 许可。remark-math 发布包缺少许可全文，已从其发布版本对应提交补齐并记录来源。间接依赖 `toggle-selection@1.0.6` 只取得 MIT 元数据声明，发布包及此前核对的对应提交未提供许可全文。这份清单不代表分发许可审计已经完成。
