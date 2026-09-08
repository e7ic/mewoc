# M5 当前版本收口验收

2026-09-08 重新启动验收，覆盖首期编辑器及已经接入的 M6 功能。本文汇总当前版本证据；旧过程见 [稳定性验收](m5-validation.md) 和 [原生与持续运行补验](m5-native-soak.md)。原始失败保留，不能由后续通过记录覆盖或删除。

状态：**M5 首期验收已收口（2026-09-08）**。首期 12 类场景已有对应证据，当前扩展功能纳入回归；本轮完成小时级持续运行及原生补验。下述瞬时异常保留为未复现记录，资源计数通过不扩展为完整进程无泄漏保证。

## 环境与复现

- macOS 26.5.1；Chrome 152.0.7977.82、Safari 26.5、Edge 152.0.4191.66。
- 用户应用保留在 4177；原生输入及首轮 Chrome / Edge 回归在专用 4179。后续稳定服务使用 4182，各访问源的 IndexedDB 隔离。
- 稳定服务运行 `pnpm dev --config tests/rsbuild.validation.config.js`。该配置复用应用配置，提前编译异步模块并关闭 HMR / 自动刷新；应用动态 import 和生产分包不变。
- `/tests/browser.html` 分别运行常规与压力验收；两次运行之间刷新。`/tests/lifecycle.html` 提供 30 轮、15 分钟和 60 分钟模式。结束后点击「导出验收结果」，记录浏览器 UA、来源、时间与全部结果。
- 测试只清理本次生成 ID 的文档，不清空用户数据库。中断或热更新可能留下测试记录，因此始终使用专用访问源。

## 已取得的当前版本证据

| 检查 | 结果 | 原始记录 |
| --- | --- | --- |
| Chrome 功能 | 62/62，包含 1 条万字计时观测 | [JSON](m5-closure-evidence/chrome-browser.json) |
| Edge 功能 | 62/62 | [JSON](m5-closure-evidence/edge-browser.json) |
| Safari 功能 | 稳定服务 62/62 | [JSON](m5-closure-evidence/safari-browser.json) |
| Chrome 压力 | 3/3 | [JSON](m5-closure-evidence/chrome-stress.json) |
| Edge 压力 | 3/3 | [JSON](m5-closure-evidence/edge-stress.json) |
| Safari 压力 | 3/3 | [JSON](m5-closure-evidence/safari-stress.json) |
| Chrome 会话 | 30/30；150 个 URL 全部释放 | [JSON](m5-closure-evidence/chrome-lifecycle-30.json) |
| Chrome 小时级持续运行 | 720/720，末轮 3940 秒；3600 个 URL 全部释放，每轮观察器/监听归零 | [完整记录](m5-closure-evidence/chrome-lifecycle-720.json)、[汇总](m5-closure-evidence/chrome-lifecycle-summary.json) |
| Edge 会话 | 30/30；资源计数归零 | [JSON](m5-closure-evidence/edge-lifecycle-30.json) |
| Safari 会话 | 30/30；资源计数归零 | [JSON](m5-closure-evidence/safari-lifecycle-30.json) |
| 真实双拼输入 | 用户完成候选回删、恢复、确认、中英文连续切换；保存并刷新恢复一致 | [原生事件](m5-closure-evidence/chrome-native-input.json) |
| Safari 真实指针/选区 | 用户拖动图片、表格列宽，跨段落加粗再撤销；保存刷新尺寸一致 | [原生事件](m5-closure-evidence/safari-native-interaction.json)、[恢复结果](m5-closure-evidence/safari-native-restored.json) |
| Safari 资源复写 | 两份既有测试文档资源可读；独立副本重复保存/恢复/便携导出 8 轮字节一致 | [JSON](m5-closure-evidence/safari-asset-resave.json) |
| Safari 当前版本打印 | A4 横向 2 页，33 mm 左边距，图文表格、公式、代码、附件及手动分页完整 | [系统打印 PDF](m5-closure-evidence/safari-landscape.pdf) |
| Node 18.18.0 | 127/127 测试通过 | [测试日志](m5-closure-evidence/node18-tests.log) |
| Node 24.13.1 | lint、127/127 测试、生产构建通过 | [测试](m5-closure-evidence/node24-tests.log)、[lint](m5-closure-evidence/lint.log)、[构建](m5-closure-evidence/build.log) |

压力的 10 万字、20 张 1200×800 纯色 PNG、100×10 表格为三组独立样例，不能合并为支持容量承诺。计时是本机命令、布局、序列化和存储观测，不是真实输入法端到端延迟。

## 真实输入法

用户使用双拼，“你好”的键序为 `nihk`。记录显示可信的 compositionstart / compositionupdate / beforeinput / input，以及组合状态中的 Backspace：候选文本从 `ni hk` 回退至 `ni h`，补 `k` 后确认“你好”；随后英文 `abc` 为普通 insertText，再次组合输入并确认“测试”。用户明确确认已完成候选操作。

最终正文为 `ni你好abc测试`，开头 `ni` 是验收工具此前普通按键探测留下的前缀。点击保存、状态显示「已保存到此浏览器」后刷新，标题及正文保持一致。两次 compositionend 的 trusted 值均为 false，原始记录未作改写；通过结论依据用户实际操作确认、可信组合更新及文本保存恢复，不能将结束事件标成可信。

## Safari 选择、尺寸与输出

用户在「M5 · 当前版本图文与输出验收」完成真实鼠标补验。图片从 240 px 调整为 456 px，记录包括 buttons=1 的 pointerdown 和可信捕获/释放边界；表格从 480 px 调整为 625 px，第一列从 160 px 调整为 305 px，其余两列仍为 160 px。随后拖选两段正文、点击加粗并使用 ⌘Z 撤销。明确保存后刷新，图片 456 px、表格 625 px 及 305/160/160 三列宽度保持一致。工具自己的拖动始终发送 buttons=0，不能替代这份人工证据。

当前文件样例在原图表与分页内容上包含 `E = mc^2`、JavaScript 代码、中英两段正文和 36 字节附件。系统竖向预览实际为 2 页；后续切换文档横向、左边距 33 mm，进入 Safari 系统打印窗口后显式选择横排、关闭浏览器页眉页脚、打开背景打印，保存 PDF。浏览器打印窗口的方向/页眉设置仍会覆盖页面意图，因此使用说明要求核对系统设置。

PDF 实测两页 MediaBox 均为 842×595 pt；Poppler 渲染并逐页检查：第一页图片、3×3 表格均完整，第二页从手动分页标题开始，公式、代码和附件说明完整，无工具栏、图片操作柄或附件下载按钮。左侧内容起点约 33 mm。PDF 是通过 Safari 系统对话框保存的实际文件，并非 HTML 截图或自动合成替代品。

## 本轮修复

`printDocument` 原先在调用打印后 60 秒无条件删除 iframe；用户还在纸张或保存面板中操作时，输出可能提前失效。清理同时可能经 afterprint、AbortSignal 和下一次打印重复调用。现删除固定时间销毁，使用幂等清理；afterprint 正常释放，未发送该事件的浏览器由下一次打印或会话卸载回收，调用方最多持有一个打印 iframe。

新增回归验证：停留超过 61 秒不提前移除、afterprint 后重复清理不访问失效窗口、缺少 afterprint 时由会话释放。原有“资源未就绪时卸载”测试同时确认迟到资源不会唤起打印。修改前 4 项中 3 项失败，修改后 Node 18.18 / 24 均为 4/4。完整套件增加至 127 项。

同一 Safari 会话再次打开打印窗口，停留超过 8 分钟后保存 [第二份 PDF](m5-closure-evidence/safari-long-dialog.pdf)。文件仍为 2 页横向 A4；用相同 Poppler 参数渲染，两页 PNG 的 SHA-256 分别与首份逐页相同，确认实际内容未因长时间等待而消失。原生保存面板一度延迟启用「保存」，待按钮实际可用后完成；不能把尚未落盘的中间面板当作保存成功。

## 失败记录与诊断

1. [首次 Chrome 持续运行](m5-closure-evidence/chrome-lifecycle-initial-failure.json)：完成 69 轮后，第 70 轮卸载检查出现 2 项 window 监听计数残留；URL / ResizeObserver 为 0。该轮失败保留，不能以短程重跑通过直接断言无泄漏。后续增加监听类型与函数名诊断，完整 720/720 轮通过，未复现残留；首次异常的完整因果仍未确定，不删除原始失败。
2. [Safari 开发服务失败](m5-closure-evidence/safari-dev-loader-failure.json)：4179 的懒编译代理分包加载失败，公式、代码高亮、Markdown 的后续检查连带失败，结果为 51/62。4182 提前编译异步模块后，同一套用例通过 62/62。验收配置不替换产品的按需加载逻辑。
3. Safari 在长时间打印操作及开发增量编译期间曾出现图片不显示、打印提示 `The object can not be found here.`。不能把该现象直接认定为 IndexedDB 损坏：独立读取既有资源成功，8 轮资源复写/导出字节一致；完整重启验收服务、重新加载同一文档后图片恢复并成功保存上述 PDF，未修改资源持久化代码。该瞬时现象的完整因果未定位，保留为未复现记录；打印生命周期缺陷则由独立回归明确验证并修复。

## 首期场景与证据对应

| 场景 | 证据范围 |
| --- | --- |
| 中文与中英文混排 | 本轮用户双拼候选回删、恢复、确认和中英文连续输入，保存刷新一致 |
| 格式与跨块选区 | 三浏览器命令回归及本轮 Safari 真实跨段加粗/撤销；选区书签映射由自动化覆盖 |
| 图片生命周期 | 三浏览器资源往返、删除撤销及异步卸载；Safari 独立重复保存校验 |
| 图片与表格缩放 | 三浏览器 50%/100%/150% 合成坐标回归；既有 Chrome 原生缩放与 Edge 用户跨窗口完整事件记录，本轮 Safari 真实调整/恢复 |
| 保存期间继续输入 | 保存协调器版本/修订号测试，旧成功不覆盖新修订状态 |
| 失败与切换 | 配额及异步事务故障回滚、旧会话迟到结果隔离测试 |
| 双标签页 | 事务内比较 storageVersion；既有原生双窗口冲突及当前 Node 冲突回归 |
| 多实例与只读 | 三浏览器双 Provider、只读异步写入与资源隔离检查 |
| 导入校验 | Schema/文件/资源类型大小、未知节点与版本拒绝的自动化；系统文件选择器导入当前样例 |
| 查找替换 | 三浏览器中文、跨 mark、范围、全部替换与撤销回归 |
| 文件与打印 | 便携文件资源往返及 HTML 独立输出回归；当前 Safari 系统 PDF 逐页核对 |
| 长文档 | 三浏览器万字基础及 10 万字、20 张图、100×10 表格三组独立压力样例 |

## 持续运行与交付边界

Chrome 完成 720 轮、1440 次真实会话挂载，末轮采样距开始 3940 秒（65 分 40 秒），随后页面结束，用户点击导出。633 轮采样时页面可见，其余为后台；因此这是包含前后台切换的小时级运行，不描述为全程前台输入压力。

- 720 轮旧编辑器销毁、迟到插图不写回、附件原始字节/公式/代码恢复断言全部通过；所有观测到的 window error / unhandledrejection 均未触发失败。
- 每轮 URL / ResizeObserver / 指定 window 监听为 0；累计创建 3600 个 URL，在用峰值 2、观察器峰值 2；DOM 节点首轮 30，随后稳定为 31。
- JS 堆估算首轮 70.36 MiB、末轮 72.09 MiB，范围 68.13–91.62 MiB；首/末一分钟低位分别为 70.36 / 72.09 MiB。末值比首值高约 1.73 MiB，报告数组本身也持续增长，但未做保留路径分析，不能将差值直接归因于诊断或断言没有泄漏。
- 本次关闭小时级会话稳定性与指定资源释放门槛；不承诺无限连续运行、全部原生图片内存无增长或崩溃时最后输入必然落盘。首次 69 轮后的残留异常与 Safari 瞬时输出异常继续保留，若复现应按原记录定位。

用户此前要求的注释补充保持完整。再次对比 HEAD 的 76 个生产 JS/JSX 文件 AST，只有 `print-document.js` 存在本轮明确的逻辑修复，其余为注释变化。新增验收代码只通过开发入口提供；生产构建仅输出应用入口。没有新增运行依赖或改变文件协议，也未创建发布版本或 Git 提交。

## 白盒契约与证据边界

生命周期每轮挂载真实 Provider / PaperCanvas，插入图片、附件、公式和代码，保存后在图片读取及拖动过程中卸载，再从 IndexedDB 恢复；恢复会话进入表格拖动后再次卸载。检查由 Tiptap 自己完成销毁，不手工调用 destroy；记录只保存数字、布尔值和字符串，不持有 editor、DOM 或 Blob 引用。

对象 URL 随会话回收，附件字节从持久化 Blob 校验；恢复后的公式和代码节点应存在。监听器诊断只保存类型和函数名；计数覆盖 beforeunload、mousemove、mouseup、blur，不能代表所有浏览器资源。堆数值来自 Chromium 非标准估算，Safari 不支持时写 null，不以 0 代替不可取得的数据。

保存故障继续依据事务原子性、版本确认和会话隔离测试：配额异常及异步事务失败必须回滚正文与资源删除，失败不推进版本；旧保存响应不能将新输入标记为已保存。没有填满用户磁盘或强制终止浏览器，因此不把故障注入描述成实际磁盘耗尽或崩溃演练。

依赖清单记录 206 项，第三方声明保留已取得的许可全文。`toggle-selection@1.0.6` 仍只有 MIT 元数据、缺少许可全文；项目保持 private，当前验收不等同于对外分发许可审计。
