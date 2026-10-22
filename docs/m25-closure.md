# M25 自动分页持续验收

本轮接续块分页、跨页表格、段内分页和长列表/嵌套容器四批实现，补充混合长文的持续使用检查。正文、资源、保存和撤销仍使用原有产品实现；新增入口仅在开发服务提供。

## 复现方式

使用项目固定的 pnpm 版本和已有验收配置（默认隔离端口 4182）：

```sh
pnpm dev --config tests/rsbuild.validation.config.js
```

在 Chrome 打开 `http://127.0.0.1:4182/tests/pagination-soak.html`，先选择「运行 6 轮混合长文验收」，完成后刷新，再选择「运行 15 分钟分页持续验收」。持续模式按真实经过时间结束，不把预定轮数当作已运行时长。点击「停止并清理」会完成当前轮的保存、卸载和清理后退出。入口仅接受本机 4182 或 4190，正式 4177 访问源不能运行此检查。

使用浏览器控制工具时，先读取页面再点击运行，确保工具自己的 DOM 观察器在资源计数开始前初始化。不要在运行期间修改源文件、刷新页面或首次注入另一套控制工具。已有稳定验收配置关闭热更新、自动刷新和懒编译，避免开发重载打断检查。

四组分页专项和持续验收现共用运行前检查：在创建测试文档前，要求页面报告 `visible` 且执行两个真实动画帧。检查时限设为 3 秒，失败会直接显示页面可见性、焦点、帧数与顶层页面标记，并清理检查计时器及动画帧请求；不会继续生成整套布局超时结果。

`tests/browser.html` 另提供「连续运行四组分页验收（75 项）」。该入口先等待页面可见，最长 120 秒；随后按自动分页、表格、段落、容器顺序串行执行原有检查，每组清理后才进入下一组。请保持 Safari 窗口可见直到显示完成，无需在各组之间切换窗口或刷新。

Safari 27 拒绝访问 4190 端口。分页专项现同时接受已有的 `http://127.0.0.1:4182/tests/browser.html`，仍限制为这两个本机测试端口；未关闭浏览器的端口限制。工具取得页面内容不代表标签页已选中，应先在浏览器界面确认测试标签处于活动状态。

## 每轮覆盖范围

- 一个包含长段落、48 行双列表格、48 项有序列表、文本框/详情/引用中的长段落和 24 个待办项目、90 行代码、手动分页符的混合文档。
- 插入本轮生成的 PNG 图片、UTF-8 附件和 WAV 音频。每轮保存重开后核对只有一个正文编辑器和一个原始音频节点。
- 轮换 A5 竖版、Letter 横版和 A4 竖版，对应 50%、75%、150% 缩放；详情收起后页数减少，展开恢复；这些视图操作不修改正文或增加保存修订。
- 用独立 DOM Range 测量原始文字行，并测量真实表格行和资源节点；它们必须位于所属编辑页正文预算内。混合夹具不允许退回超高展开页。
- 跨续页边界替换四个 UTF-16 单元，执行撤销、重做、再次撤销，逐步核对原始 JSON。测试使用编辑器命令，不代表真实输入法候选验收。
- 每轮检查 IndexedDB 最新正文/纸张、Mewoc 备份往返和三种资源的逐字节一致性；HTML 不包含屏幕分页装饰；每十轮额外生成 Word，检查尾段只出现一次。
- 每轮两次真实 Provider/PaperCanvas 挂载。通过产品自身生命周期销毁会话，检查旧 store 不再更新，并精确清理本轮创建的文档 ID。

## 资源计数与诊断

观察对象 URL、ResizeObserver、MutationObserver，以及 `beforeunload / mousemove / mouseup / blur / resize` 五种窗口监听。每轮结束必须全部归零；失败时保存仍在活动的观察器和监听器的注册调用栈。调用栈使用 WeakMap，不保留已经释放的对象。

最初两次预检在计数启动后首次调用浏览器控制工具的 DOM 读取，额外记录到一个 MutationObserver 与两个窗口监听。调用栈来自 `_setupGlobalListenersRemovalDetection` 和 `_setupHitTargetInterceptors`。改为测试前初始化工具后，六轮预检的 12 次挂载均归零；没有过滤或忽略产品资源。诊断见[过程记录](m25-closure-evidence/diagnostics.json)。

资源归零只覆盖这些会话和被监测的 API；没有取得堆保留路径或浏览器原生内存分析，不能推导整个进程没有泄漏。

## 最终记录（2026-10-22）

2026-10-22，macOS 27.0、Chrome 155.0.8059.82、Safari 27.0、Node v24.13.1。六轮预检在 29 秒完成 12 次挂载，三种纸型分别为 30、19、17 页；见[短轮次结果](m25-closure-evidence/short-soak-browser.json)。

全量 Node **838/838**、lint、生产构建通过。构建检查确认新验收入口和混合长文夹具没有进入生产文件；原始命令输出与入口检查位于 [Node 日志](m25-closure-evidence/node-test.log)、[lint 日志](m25-closure-evidence/lint.log)、[构建日志](m25-closure-evidence/build.log)、[生产入口检查](m25-closure-evidence/production-entry-check.json)。npm 读取项目 pnpm 配置项时的提示保留在日志内。

Chrome 四批分页专项完整通过 **75/75**：自动分页 15、跨页表格 20、段内分页 18、容器分页 22。分别见[自动分页](m25-closure-evidence/chrome-pagination-browser.json)、[表格](m25-closure-evidence/chrome-table-pagination-browser.json)、[段落](m25-closure-evidence/chrome-paragraph-browser.json)、[容器](m25-closure-evidence/chrome-container-browser.json)。

一次持续运行在 99 轮、198 次挂载、505 秒时通过「停止并清理」结束，全部已完成轮次资源归零。该结果只作为[停止分支与阶段证据](m25-closure-evidence/stopped-soak-browser.json)，不计作完整 15 分钟。其后切到关闭热更新的稳定服务，另行开始完整持续验收。

稳定服务上的完整运行实际持续 **902 秒，134 轮，268 次会话挂载**，`stopped=false`，全部通过。134 轮的对象 URL、ResizeObserver、MutationObserver 与指定窗口监听在卸载后均为 0；累计创建并释放 804 个对象 URL。每轮检查三种资源及 Mewoc/HTML，额外完成 14 次 Word 导出检查；所有记录的页面可见性为 `visible`。完整证据见[逐轮结果](m25-closure-evidence/chrome-soak-15min.json)、[完成截图](m25-closure-evidence/chrome-soak-complete.png)及[汇总](m25-closure-evidence/verification-summary.json)。

本轮纸张变更的等待收敛耗时中位数为 **623.5 ms**、P95 为 **882 ms**、最大 **974 ms**；整轮含导出、保存与卸载的耗时为 5.673–8.484 秒。这些是当前机器与测试夹具的观察值，不作为通用性能上限。持续验收没有捕获异步错误，控制台保留两条 locatorjs 扩展初始化提示，见[控制台记录](m25-closure-evidence/chrome-soak-console.json)。

Safari 首轮 **0/15**，全部在初始布局等待时超时，原始失败保留在[首轮记录](m25-closure-evidence/safari-pagination-initial.json)。加入诊断后完整复跑仍为 **0/15**：全部 `visibility=hidden`、`frames=0`、`pending=true`、`pages=0`，未记录到异步错误。原生窗口工具返回 `noWindowsAvailable`，窗口提升和键盘操作未改变页面隐藏状态。证据见[诊断结果](m25-closure-evidence/safari-pagination-diagnostic.json)与[原始界面文本](m25-closure-evidence/safari-pagination-diagnostic-ax.txt)。

这些早期诊断说明当时初始动画帧测量没有启动，不能据此判定分页算法缺陷，也不能计为 Safari 通过。后续恢复可见窗口后，四组专项已完整重跑，结果见下文。

本轮 Chrome 持续验收与 Safari 四组分页回归已完成；真实输入法、物理指针与原生打印/Word 验收仍待补齐，M25 整体不标记为全部收口。最初一轮测试文档、资源、标签和 4182 / 4190 服务已清理；随后按用户补验要求重启 4182，当前保持运行。

## Safari 前台补验跟进

用户确认 Safari 已在前台后重新启动自动分页专项。窗口前置、退出全屏幕均未恢复页面动画帧；最后可读取的 13 项仍全部超时，均报告 `hidden / frames=0`。该次没有取得完整结束状态，不记为完整 0/15，见[阶段结果](m25-closure-evidence/safari-foreground-retry-partial.json)及[当时窗口截图](m25-closure-evidence/safari-foreground-retry.png)。

另建 Safari 普通窗口运行独立预检，仍报告 `visibility=hidden`、`focused=true`、`frames=0`、`topLevel=true`，在创建文档前结束；见[新窗口预检](m25-closure-evidence/safari-foreground-preflight.json)。该窗口[截图已成功保存](m25-closure-evidence/safari-foreground-preflight.png)，后续关闭窗口及读取状态的组合调用返回 `noWindowsAvailable`，无法确认关闭状态。之后窗口读取及重新连接持续超时，无法确认该次完整专项结束。当前证据不能确定页面可见性与窗口控制异常的底层原因。

WebKit 官方说明，页面处于后台、窗口被遮挡或位于其他桌面时，会暂停动画帧并限制计时器；这解释了为什么几何验收需要先确认动画帧可用，但不能单凭该机制确定本次窗口异常的原因。见 [WebKit 电源使用说明](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/)。

运行前检查加入后，Chrome 自动分页复跑 **15/15**，另完成 **6 轮、12 次挂载、41 秒**混合长文，监测资源逐轮归零；lint、生产构建通过。分别见[专项结果](m25-closure-evidence/chrome-preflight-pagination.json)、[六轮结果](m25-closure-evidence/chrome-preflight-soak.json)、[lint](m25-closure-evidence/visibility-preflight-lint.log)和[构建](m25-closure-evidence/visibility-preflight-build.log)。这组是新增预检的回归，前文 902 秒结果保持原始批次记录。

## Safari 原生连接排查

再次连接 Safari 的原生窗口仍在约 5 秒后返回 `timeoutReached`，同一控制通道读取 Chrome 窗口成功。Safari 两秒进程采样的 183 个主线程样本均位于 AppKit 正常事件等待路径，没有在该采样区间发现忙循环或主线程阻塞；见[调用栈节选](m25-closure-evidence/safari-main-thread-sample.txt)。这只能排除当时的持续主线程卡死，不能证明 Safari 辅助功能、窗口可见性或控制服务均正常。系统应用启动入口未能恢复连接，Finder 原生绑定另返回 `cgWindowNotFound`，因此窗口控制故障不限于本次 Safari 页面。筛选 Safari 可见性与辅助功能日志未取得遮挡或可见性错误的直接原因；底层原因仍未确定。

新增开发专用诊断页 `http://127.0.0.1:4182/tests/browser-visibility.html`，只运行原生可见性、动画帧与计时器探针，不加载 React、编辑器或测试夹具。页内持续展示状态变化和最近十个采样，可导出 JSON。Chrome 对照在 30 秒内记录到 3245 个动画帧，页面为 `visible`，见[对照结果](m25-closure-evidence/chrome-visibility-probe.json)。本阶段未取得 Safari 探针结果，随后通过正常退出并重开 Safari 恢复了窗口连接。

诊断入口加入后，lint 与生产构建通过，生产文件中未包含该入口。见[lint](m25-closure-evidence/visibility-probe-lint.log)和[构建](m25-closure-evidence/visibility-probe-build.log)。4182 已重启以载入新开发入口并保持运行；没有修改产品分页调度、伪造页面可见性或以计时器代替动画帧。

## Safari 恢复与验收完成

用户正常退出并重开 Safari 后，原生窗口读取、导航、下载和截图恢复。独立探针先记录到 `visible` 与 694 个动画帧，随后在 11591 ms 转为 `hidden`，帧数保持不变；见[重开后的完整诊断](m25-closure-evidence/safari-reopened-visibility-probe.json)。这直接证明可见性切换会停止本次几何验收依赖的动画帧。保持窗口可见、切入全屏并重新启动连续验收后，真实分页测量恢复。旧窗口绑定超时的底层原因仍未确定，不将一次恢复描述为操作系统问题已永久修复。

恢复后的首轮完整结果为 **57/75**，见[原始结果](m25-closure-evidence/safari-pagination-visible-initial.json)。18 项失败中，17 项来自验收脚本只读取 `getComputedStyle(...).userSelect`：Safari 实际返回标准属性缺失，`webkitUserSelect=none`，构建 CSS 已带 `-webkit-user-select:none`。验收改为读取实际支持的属性，仍要求禁选值和 `pointer-events` 均为 `none`，同时保留装饰数量、几何和 DOM 交互检查。Safari 前缀用法亦见 [MDN user-select 示例](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/user-select#css)。

另一项是容器合成组合输入的焦点时序：Tiptap 的聚焦包含后续动画帧，旧脚本在完成聚焦前就记录装饰并启动候选。现先将光标放在候选插入位置，等待真实焦点与布局稳定，再发起合成 composition。最终记录确认 `composing=true`、断点未改变、4 个原装饰全部保持连接；候选结束后的重新排版及只读勾选检查也通过。此结果仍属于合成事件，不扩展为真实系统输入法验收。

修正验收读取和时序后，Safari 完整复跑 **75/75**：自动分页 **15/15**、表格 **20/20**、段落 **18/18**、容器 **22/22**。完整 JSON 包含运行环境、时间、分组和诊断数值，见[最终结果](m25-closure-evidence/safari-pagination-complete.json)、[窗口截图](m25-closure-evidence/safari-pagination-complete.png)及[原始界面文本](m25-closure-evidence/safari-pagination-complete-ax.txt)。本轮未修改产品分页算法或生产样式。

Safari 随后完成 **6 轮、12 次挂载、30 秒**混合长文检查，A5、Letter 横版与 A4 分别为 30、19、16 页，六轮均报告页面可见，监测资源逐轮归零，`stopped=false`。页数与 Chrome 的差异来自本轮各浏览器真实排版结果，未要求跨浏览器页数完全一致；两者均逐行核对正文预算与原始内容。见[六轮完整结果](m25-closure-evidence/safari-soak-six-rounds.json)与[完成截图](m25-closure-evidence/safari-soak-complete.png)。完成后已退出临时全屏，保留用户打开的 Safari 验收窗口与 4182 服务。

同一版验收脚本在 Chrome 完整复跑 **75/75**，包括标准 CSS 属性读取与稳定聚焦后的 composition 检查，见[最终 Chrome 结果](m25-closure-evidence/chrome-pagination-final.json)。该 JSON 已经浏览器下载并归档；下载事件等待随后超时，控制会话重置，未取得这一批额外的 Chrome 截图或控制台归档，主动关闭结果标签也未确认。该工具故障发生在 JSON 完成下载之后；完整通过状态已由页面与下载的 75 项 JSON 共同确认。

最终 lint、生产构建与 `git diff --check` 通过，开发验收入口未进入生产文件。见[lint](m25-closure-evidence/safari-compatibility-lint.log)与[构建](m25-closure-evidence/safari-compatibility-build.log)。

## 交付边界

后续[原生验收](m25-native-acceptance.md)已完成 Chrome 原生打印并逐页核对 27 页 A5 PDF，发现并修复了媒体控件打印隐藏规则的 CSS 优先级问题；媒体专项 11/11、相关 Node 10/10 通过。该生产样式修复属于后续批次，不改变前文 Safari 恢复批次未修改生产代码的记录。

编辑纸面与浏览器打印、Word/WPS 分别排版。自动化保存/导出语义检查不能证明外部软件中的物理分页。剩余版本收口包括：跨页位置真实输入法候选、确认及撤销；物理指针跨窗口拖选；混合长文在 Word/WPS 中原生打开、另存和导回。保存 JSON、屏幕行矩形、实际 PDF 和 DOCX XML 检查分别保留各自的验收范围。

新代码沿用当前项目 React 17、Tiptap 3、AntD 5、Zustand 和 JavaScript/JSX；不增加依赖、不修改文档协议和生产编辑器逻辑。首次浏览器基线因开发服务重启丢失完整结果，该次不计入本轮最终通过数量。
