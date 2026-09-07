# Mewoc：参考 Umo Editor 的 React 实现调研

调研日期：2026-09-06。

后续状态：已开始首期编码。本文保留调研时结论，当前工程与验收结果见 [编码记录](implementation-notes.md) 和 [使用说明](../README.md)。

用户约束：React 17、Tiptap 3、JavaScript / JSX、不编写 TypeScript / TSX、Zustand、pnpm。本轮为技术调研，未初始化应用工程。默认首期目标是 Umo 开源版的主要功能与交互；实时自动分页、AI、批注、协作分别评估，不默认为已经具备。

**结论**

这套技术组合可行，并已通过临时项目的构建与浏览器运行验证。建议新建 React 编辑器外壳，使用 Tiptap 官方 React 绑定；对 Umo 的开源扩展逐个评估、选择性移植。工作量主要来自节点交互、编辑状态同步、格式转换和排版，而不是 React 17 本身。

后续已整理 [首期实施方案](/Users/e7ic/Desktop/Zephyr/Labs/mewoc/docs/mewoc-v1-plan.md)，细化功能清单、扩展注册、文档与图片格式、保存冲突和验收样例。补充核对确认 Tiptap 3.31.3 已有公开的 FindAndReplace 与 Image resize 能力，应优先评估官方实现；段落行距仍需区别于文字 mark 的 lineHeight。本项目目前只有调研与方案文档。

必须纠正一个早期判断：Umo 当前官网介绍仍有分页表述，但其更新日志明确说明 v4.6 是最后一个支持自动分页的版本，v5.0 起移除了该能力。当前主分支的纸张容器、手动分页符及浏览器打印，与 Word 式实时自动分页应分别评估。[Umo 更新日志](https://dev.umodoc.com/cn/docs/editor/changelog)

**已核对的版本与实际验证**

| 项目 | 调研结果 | 建议 |
| --- | --- | --- |
| React / React DOM | 17.0.2 | 保持用户指定版本；使用 ReactDOM.render |
| Tiptap React | npm 当前 latest 为 3.31.3，peerDependencies 明确支持 React 17 / 18 / 19 | 本次验证使用 3.31.3；核心相关包锁定同版 |
| Tiptap core / pm | React 包 3.31.3 要求精确匹配 3.31.3 | 避免混用不同小版本或重复 ProseMirror 实例 |
| Zustand 4 | 4.5.7 支持 React >=16.8 | React 17 项目采用 4.5.7 |
| Zustand 5 | 当前 5.0.15 的 React peer 为 >=18 | 不作为本项目默认 React 状态绑定 |
| 语言 | Tiptap 提供 JavaScript 运行产物，业务代码可用 JS / JSX | .js、.jsx、jsconfig.json；不建立 TS 编译流程 |
| 构建 | Vite 7.3.1 在本机 Node 20.20.0 下构建通过 | 可作为已验证基线，不表示它是当前最新 Vite |
| 包管理 | 本机 pnpm 11.19.0 安装通过 | 正式工程写 packageManager 并提交锁文件 |

证据：[Tiptap React 3.31.3 包元数据](https://registry.npmjs.org/@tiptap/react/3.31.3)、[Zustand 4.5.7 包元数据](https://registry.npmjs.org/zustand/4.5.7)、[Zustand 5.0.15 包元数据](https://registry.npmjs.org/zustand/5.0.15)。

不使用 TypeScript 是应用源码和开发流程的约束。第三方依赖自身用 TS 开发、发布包附带 .d.ts 文件，不影响我们仅编写 JS / JSX；正式安装时需确保可选类型 peer 不导致 React 类型主版本漂移。

临时验证目录为 `/private/tmp/mewoc-research-20260906/compatibility`。安装时禁用了生命周期脚本，关闭自动补装 peer 并启用严格 peer 检查。执行了 pnpm install、pnpm build，以及本机 Chrome 页面检查。

浏览器验证结果为 10/10：

- React 17 挂载。
- React NodeView 挂载。
- 加粗命令及 HTML 序列化。
- 撤销。
- 重做。
- JSON 回填一致性。
- 表格插入。
- useEditorState 订阅更新。
- Zustand 订阅更新。
- 只读状态订阅。

构建成功但有两类提示：Tiptap 的 use client 指令被 SPA 构建忽略，以及单个产物超过 500 kB。临时示例产物约 593 kB，gzip 约 190 kB；这不是完整产品体积或性能指标。

这次验证未覆盖中文输入法组合输入、图片缩放、复杂粘贴、大文档、分页、真实上传保存、协作或其他浏览器，不能据此宣称完整编辑器已经兼容。

**Umo 源码结构与重写边界**

本次静态审阅固定到 Umo 提交 `baa1d0e9eb99b4ce116d9a894fe538e4d2917e1f`，package.json 标注 11.1.1，Tiptap 主要依赖为 3.20.0。该快照 src 中有 196 个 .vue 文件、95 个 .js 文件，说明界面移植具有相当规模。[源码依赖](https://github.com/umodoc/editor/blob/baa1d0e9eb99b4ce116d9a894fe538e4d2917e1f/package.json)

| Umo 实现部分 | React 路线 | 复用判断 |
| --- | --- | --- |
| Tiptap / ProseMirror 基础编辑 | 使用 @tiptap/react、core、pm 和官方扩展 | 使用官方实现 |
| 菜单、Ribbon、弹窗、工具栏、侧栏 | 重建 React 组件与样式 | Vue / TDesign Vue 组件需要重写 |
| Vue provide/inject、watch、VueUse 本地存储 | React Context、hooks、按实例创建的 Zustand store | 状态生命周期重新设计 |
| 行高、缩进、书签、查找替换等 | 检查扩展 API、节点属性和外部依赖 | 部分纯 JS 逻辑可选择性移植 |
| 图片、附件、音视频、图表等节点 | ReactNodeViewRenderer 或原生 DOM NodeView | 解析与命令可评估复用，交互视图需要重写 |
| 页面样式、打印 | 纸张容器与独立打印模板 | 原理可参考，输出结果重新验证 |
| Umo Next 商业功能 | 独立实现或另行评估授权产品 | 不视为开源仓库可复制代码 |

具体证据：[编辑器初始化](https://github.com/umodoc/editor/blob/baa1d0e9eb99b4ce116d9a894fe538e4d2917e1f/src/components/editor/index.vue)、[扩展注册](https://github.com/umodoc/editor/blob/baa1d0e9eb99b4ce116d9a894fe538e4d2917e1f/src/extensions/index.js)、[查找替换](https://github.com/umodoc/editor/blob/baa1d0e9eb99b4ce116d9a894fe538e4d2917e1f/src/extensions/search-replace.js)、[图片节点视图](https://github.com/umodoc/editor/blob/baa1d0e9eb99b4ce116d9a894fe538e4d2917e1f/src/extensions/image/node-view.vue)。

从这些代码判断，不适合逐文件把 Vue 模板机械改成 JSX。图片节点就同时涉及上传、缩放、旋转、裁剪、选区和撤销；应先建立 React 节点生命周期，再迁移独立逻辑。

**建议架构：明确每种状态的归属**

| 状态 | 所有者 | 处理方式 |
| --- | --- | --- |
| 文档正文、光标、选区、marks、编辑撤销历史 | Tiptap / ProseMirror | 通过 command 和 transaction 更新 |
| 编辑器实例 | useEditor / 稳定的 Context 引用 | 不序列化、不放入持久化 store |
| 当前工具栏、打开的面板、主题、缩放 | Zustand | 组件按 selector 订阅 |
| 文档标题、纸张参数、保存状态、请求状态 | 按文档隔离的 Zustand store | 业务状态与文档元数据管理 |
| 粗体、标题级别、可否撤销等工具栏状态 | useEditorState | 从编辑器派生，避免双份可写状态 |
| 保存数据 | Tiptap JSON + 页面设置 + 文档元数据 | 保存时取快照，并包含 schemaVersion |
| 本地恢复 | IndexedDB 文档草稿；偏好可用 localStorage | 不把全文同步写入每次 UI 更新 |

正文不应在每个按键后完整写进 Zustand，再由 React effect 调 setContent 回灌。这样会制造重复渲染、选区跳动、历史被扰动和循环更新。保持单个编辑器实例，外部只订阅需要显示的派生状态。[Tiptap 性能指导](https://tiptap.dev/docs/guides/performance)

保存采用 JSON 作为主格式，HTML / Markdown 是派生格式。自定义节点需要同时定义 schema、parseHTML、renderHTML；React NodeView 只负责编辑中的交互视图，其外观不会自动成为导出结果。[Tiptap 持久化](https://tiptap.dev/docs/editor/core-concepts/persistence)、[React 节点视图](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views/react)

建议文档封装字段包括 schemaVersion、id、title、content、page、updatedAt。page 包含纸张、方向、页边距等文档属性；UI 缩放和面板展开状态单独保留，避免混入正文。

保存的关键流程是：编辑使 revision 增加；保存取 revision 对应快照；响应成功只确认该版本。若请求过程中用户继续输入，旧请求成功不能把新内容标成已保存。切换文档与卸载时取消旧订阅、计时器和可取消请求，并忽略过期响应。关闭页面前临时发请求不能作为唯一防丢机制。

正文撤销使用 Tiptap 的历史。纸张配置的撤销如需与正文统一，需要额外设计；不能认为 Zustand 或 Tiptap 会自动把两种历史合并。后续引入 Yjs 协作时，还需采用协作对应的撤销与持久化机制。

**功能分解与难度判断**

以下难度为工程评估，不是已完成状态。

| 功能组 | 实现方向 | 难度 / 主要边界 |
| --- | --- | --- |
| 标题、字体、字号、颜色、列表、链接、撤销 | 官方扩展 + React 工具栏 | 低至中；关注选区与菜单状态 |
| 行高、字距、缩进、格式刷 | 官方已有能力优先，缺口写扩展 | 中；多节点选区与历史一致性 |
| 图片、附件、拖拽上传、缩放 | 自定义节点 + React NodeView + 上传回调 | 中至高；异步完成时节点可能已移动或删除 |
| 表格增删行列、合并拆分、列宽 | TableKit + 操作面板 | 中；跨页表格另算 |
| 大纲、字数、查找替换、快捷键 | 官方扩展与定制命令 | 中；中文计数定义及大文档开销 |
| 纸张样式、页边距、横竖版、缩放、水印 | CSS 纸张容器 + Zustand 配置 | 中；不等同于实时自动分页 |
| 打印 / 用户另存 PDF | 独立打印 DOM 与 print CSS | 中；受浏览器、字体、纸张设置影响 |
| JSON / HTML / 文本 | 自定义节点序列化与导入验证 | 中；需防止未知节点静默丢失 |
| Markdown | 输入规则与全文互转分别实现 | 中；字体、复杂表格、浮动图片无法完整表达 |
| 公式、代码块、Mermaid、ECharts、签名等 | KaTeX、代码高亮、图表库等按需集成 | 中；需静态输出和资源加载管理 |
| Word 导入导出 | 语义转换 / 自定义映射 / 专门转换服务 | 高；不能承诺通用格式无损往返 |
| 实时自动分页 | 专项分页层或商业 Pro 扩展 | 高至很高；长表格、超高块、中文断行等 |
| AI | 后端模型适配 + 编辑上下文 + 结果采纳 | 中至高；选区过期、流式写回、取消与撤销 |
| 多人协作、批注、修订、版本历史 | Yjs / Hocuspocus + 业务模型及服务 | 高；协作同步不自动提供所有审阅功能 |

Umo 源码中 PDF 导出最终使用 iframe.contentWindow.print()，不是静默生成 PDF 文件的接口。我们的 UI 应明确“打印 / 另存 PDF”语义；若需要一键下载或服务端批量输出，应另建转换链路。[Umo 打印实现](https://github.com/umodoc/editor/blob/baa1d0e9eb99b4ce116d9a894fe538e4d2917e1f/src/components/container/print.vue)

Markdown 输入快捷规则、全文 Markdown 解析、Markdown 导入导出是三件事。Tiptap 提供 Markdown 扩展路线，但自定义节点仍需适配，且文档格式往返需要样例验证。[Tiptap Markdown](https://tiptap.dev/docs/editor/markdown)

**分页方案的取舍**

| 路线 | 能得到什么 | 成本与限制 |
| --- | --- | --- |
| 纸张容器 + 手动分页符 + 打印分页 | 接近当前 Umo 开源版的页面体验 | 首期最合理；编辑时正文不自动拆成独立纸页 |
| 自研实时分页 | 可控的页面布局与编辑体验 | 需要长期承担排版、选择、剪贴板、撤销与协作兼容成本 |
| Tiptap Pages | 已有的分页层、页眉页脚等 | 当前为 Team 计划中的 Pro / Beta 能力；商业条款与版本需另核对 |

Tiptap 官方说明 Pages 中的表格需要专用 PagesTableKit；普通开源 Table 扩展不能直接等价替换。超过单页高度的不可拆块也有明确限制。购买组件仍然需要针对业务文档验证。[Pages 概览](https://tiptap.dev/docs/pages/getting-started/overview)、[Pages 限制](https://tiptap.dev/docs/pages/core-concepts/limitations)

如果选择自研，建议先验证普通段落、列表、图片和受约束表格，定义超高内容处理策略，并证明排版不会无限循环。应保持一个文档模型；为每一页创建一个独立编辑器会让跨页选区、复制、撤销、拖拽及协作变得复杂。分页结果尽量作为布局派生数据，手动分页符才作为明确的文档内容；最终模型由专项原型结果决定。

不建议直接沿用 Umo 已停止维护的 v4 分页分支作为项目基础。它可以作为历史研究材料，但需要同时解决旧 Tiptap API 与分页机制问题。

**导入导出与协作的可行路线**

DOCX 导入可以评估 Mammoth：它偏向提取语义结构，不是 Word 页面还原引擎，官方列明部分表格格式不会保留。导入的 HTML 还需经过清理与 schema 验证。DOCX 导出可评估 docx 库，并明确支持的节点映射。复杂页眉页脚、浮动图片、多栏、修订等需专项处理。[Mammoth 官方仓库](https://github.com/mwilliamson/mammoth.js)、[docx 官方站点](https://docx.js.org/)

JSON 导入遇到不支持的节点，应报告并按明确策略处理，避免默默删掉内容。若要求读取已有 Umo 文档，还需额外设计节点名称、属性、样式和附件引用的迁移；共用 Tiptap 并不保证 schema 相同。

协作可采用 Yjs + Hocuspocus 自建服务。Hocuspocus 提供 WebSocket、鉴权和持久化等接入点，采用 MIT 许可；具体 provider 版本和 React 17 绑定仍需另行验证，不能推导为任意新 React hook 包均兼容。评论需要位置锚定、线程、权限和持久化；修订需要变更模型和接受/拒绝机制。[Hocuspocus 文档](https://tiptap.dev/docs/hocuspocus/getting-started/overview)、[Hocuspocus LICENSE](https://github.com/ueberdosis/hocuspocus/blob/main/LICENSE.md)

AI 可独立对接业务后端，前端负责选区快照、请求状态、结果预览和采纳。首版宜采用“生成结果 → 用户采纳 → 单次事务写回”，再处理流式原位写入。生成期间文档变化时必须映射或重新确认目标位置；批注、协作和 AI 同时存在时还需约定撤销边界。

**资源、许可与产品实现**

不建议直接引入 @umoteam/editor 外套 React：它仍依赖 Vue，与目标技术栈不符。也不默认引入 @umoteam/editor-external；该包属于 Umo 外部资源集合，包含对 Umo Editor / Viewer 的依赖。图表、公式和播放器等应独立选择依赖并按需加载。[Umo 外部资源包元数据](https://registry.npmjs.org/@umoteam/editor-external/10.1.0)

当前 Umo 配置有指向 CDN latest 的默认值。若以可私有部署为目标，字体、图标、公式样式、图表库与文档附件地址均需有可控的部署方式；我们应优先随包或同源加载，避免隐式依赖公网资源。[Umo 默认配置](https://github.com/umodoc/editor/blob/baa1d0e9eb99b4ce116d9a894fe538e4d2917e1f/src/options/config/index.js)

UI 以自建 React 工具栏、菜单组合和 CSS Modules 为候选。对话框、选择器等可以再按 React 17 支持情况评估 UI 库，本轮不自动绑定整套组件库，也不引入 Redux、React Router 等当前没有需求的依赖。

如实际移植 Umo 源码，应保留适用的 MIT 版权和许可声明，并记录移植文件及来源提交。官方界面署名说明与 LICENSE 的差异沿用前轮结论，具体去标授权不在本轮作法律定论。Umo Next 及 Tiptap Pro 代码按各自商业许可评估；本轮未引入。[Umo LICENSE](https://github.com/umodoc/editor/blob/baa1d0e9eb99b4ce116d9a894fe538e4d2917e1f/LICENSE)、[Umo 官方说明](https://dev.umodoc.com/cn/docs/editor#开源协议)

**建议实施顺序与验收门槛**

1. 基础验证：React 17、Tiptap 3、Zustand 4、JSX 构建与基础命令。本轮已完成最小验证；仍需中文输入法、卸载重挂与多实例检查。
2. 可用编辑器：文档内核、工具栏、文本格式、列表、链接、表格、图片、纸张样式、本地恢复、保存接口和打印。验收重点是输入、选区、撤销、刷新恢复、失败可重试。
3. Umo 主要体验：大纲、查找替换、格式刷、附件、图片缩放、主题、水印、公式、代码块、Markdown 和独立预览。重型能力按需加载。
4. 专项增强：根据优先级投入自动分页、DOCX、AI、协作与审阅。每项用真实文档建立验收样例，再扩展承诺范围。

基础组合验证不等于第 2 阶段的功能完成。建议先交付第 2 阶段，再逐步补齐第 3 阶段；自动分页若是硬需求，应提前到阶段 1 进行技术验证，避免完成界面后才发现文档模型需要调整。

后续专项验收至少覆盖：中文输入法与中英文混排；嵌套列表；跨段落及表格选区；图片上传失败、撤销和重试；快速切换文档时保存响应乱序；字体加载后的排版变化；多编辑器实例隔离；复杂自定义节点的 JSON / HTML 往返；不同规模文档上的输入与滚动性能。
