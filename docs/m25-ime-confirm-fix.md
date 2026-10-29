# M25 双拼确认分页抖动修复

2026-10-29，本轮中文输入与物理拖选补验已完成。双拼确认跨页抖动已修复；真人候选确认、撤销、单个未确认候选的 Esc 取消，以及物理跨页拖选、跨窗口释放后返回重新拖选均取得证据。重做由工具点击正式工具栏验证，未声称验收人工 `⌘⇧Z`。最终完整正文恢复基线，正式保存并清理本轮副本。2026-10-29 用户明确排除 WPS 原生往返，M25 已按本轮范围收口，见[最终矩阵](m25-closure.md#最终验收矩阵2026-10-29)。

## 真实双拼反馈与失败证据

用户在混合长文的跨页输入位置反馈：“双拼，候选正常，确认后会出现抖动，瞬间从上一页抖动下来”。[原始事件记录](m25-native-input-evidence/shuangpin-before-fix.json)包含 **698 个事件，丢弃 0 个**；[初始状态](m25-native-input-evidence/ime-start-state.json)与[定位截图](m25-native-input-evidence/ime-start.png)保留补验环境。该轮使用 75% 缩放。

对两次“中文验收”确认，从 `compositionend` 到首个 `pending=false` 的 `pagination-update`，比较相同逻辑选区下的光标位置：

| 确认事件 → 首个收敛事件 | 光标顶部：确认 → 暂态 → 恢复 | 往返额外位移 | 确认后开始暂态 / 恢复 |
| --- | --- | --- | --- |
| 231 → 235 | 797.90625 → 692.765625 → 797.90625 px | 105.140625 px | 10.2 / 53.2 ms |
| 408 → 412 | 797.90625 → 692.765625 → 797.90625 px | 105.140625 px | 12.7 / 52.6 ms |

这里的单位为视口 CSS 像素。两段窗口内，模型选区和 DOM 选区均保持在 265，编辑器 `scrollTop=150`、窗口 `scrollY=557` 均未变化。暂态对应不修改正文、不进入撤销历史的事务；初始分页空隙节点的仍连接数量从 25 降到 5，新布局安装后旧节点全部断开。事件记录本身未保存事务元数据键，不能单凭它直接命名触发分支；结合源码和下述合成复现，定位到清除段内分页空隙与重新安装布局之间的跨帧间隔。

[轨迹失败判定](m25-native-input-evidence/ime-confirm-before-verdict.json)使用 2 px 阈值，两次确认均失败。规则允许动作前后位置合理变化，只判定超出初始与最终位置包络后又返回的额外位移。该判定重放已记录的几何数据，不会生成系统输入，也不代表修复后原生复验。

## 最小修复与回归

[分页扩展](../src/pages/editor/extensions/page-pagination.js)此前在重置段内空隙后，另约下一帧测量自然行并回填分页，浏览器可能绘制出空隙已移除、布局尚未恢复的正文。现在清除旧空隙、重新读取分页状态、测量自然行和安装新布局在同一帧内完成。候选期间仍保持暂停重排；分页事务仍不进入撤销历史。

同时，只有 `pending=false` 且分页断点一致时才采用已收敛 DOM 的几何值；重置后的 `pending` 阶段使用新布局计算值，避免把临时无空隙的容器位置误作最终位置。

新增的[浏览器回归](../tests/ime-pagination-checks.jsx)通过正式 `EditorProvider`、`EditorWorkspace` 和 `PagePagination` 挂载最小长段落，在续页边界合成候选输入。每个动画帧回调结束后另起任务采样，避免将同帧内已修复的测量暂态误计为可见跳动。光标坐标相对编辑表面并按缩放还原，因此以下数值为文档坐标像素，与前述原生轨迹的视口像素口径不同。

| 批次 | 结果 | 证据 |
| --- | --- | --- |
| 最小合成复现，修复前 | 32 帧；向上额外位移 145.6875 px，失败 | [before](m25-native-input-evidence/ime-regression-before.json) |
| 最小合成复现，首轮修复后 | 32 帧；上下额外位移均为 0，确认正文不变、撤销精确恢复原文 | [after](m25-native-input-evidence/ime-regression-after.json) |
| 最终五阶段专项 | 1 个用例通过；确认、撤销、重做、再次撤销、取消各 32 帧；各阶段上下额外位移均为 0 | [五阶段结果](m25-native-input-evidence/ime-regression-five-phase.json) |

初版最小复现的 before/after 保留当时约 51 px 的阈值；最终五阶段回归收紧至 **2 px**，不能把不同批次的阈值混写。五阶段的确认正文不变、首次撤销恢复原文、重做恢复候选、再次撤销恢复原文、取消恢复原文共五项精确内容检查均为 `true`。取消阶段由代码移除候选并发出空 `compositionend`，没有操作真实 Esc 键或系统候选框。

上述合成测试能验证修复路径和内容恢复，不能替代系统输入法、物理键盘或物理指针验收。最终源码另行完成以下自动化检查；本轮汇总及被测源码 SHA-256 见[验收汇总](m25-native-input-evidence/verification-summary.json)。

| 最终自动化检查 | 结果与证据 |
| --- | --- |
| 四组分页回归 | Codex 内置浏览器 **75/75**；[逐项结果](m25-native-input-evidence/pagination-75-final.json) |
| 全量 Node | **883/883**，退出码 0；[日志](m25-native-input-evidence/node-test.log) |
| lint | 通过，退出码 0；[日志](m25-native-input-evidence/fix-lint.log) |
| 生产构建 | 通过，退出码 0；[日志](m25-native-input-evidence/fix-build.log)。汇总确认原生事件记录器未进入生产包 |

## 事件来源与撤销边界

用户明确报告使用双拼；修复前后轨迹里的 `compositionstart`、`compositionupdate` 和 `input` 为 `trusted=true`，但所有已捕获的 `compositionend` 为 `trusted=false`。保留这一混合来源事实，不将整段记录泛称为全部硬件可信事件，也不据此猜测结束事件的来源。修复后候选正常且确认不再抖动有用户视觉反馈，并有下述新一轮事件记录；这些证据各自按覆盖范围使用。

原始记录在事件 457 已精确恢复初始正文，直到事件 465 仍保持一致。随后事件 466、479、491 的额外 `⌘Z` 撤回了夹具初始化时插入的媒体、附件、图片，最终正文恰好等于初始正文去掉前三个资源节点，剩余所有节点完全一致，文本长度仍为 13295。这是额外撤销进入夹具准备历史的结果，单独记录，不归因为输入法丢字。该轮记录中的相关 `z` 快捷键均未记录 Shift，因此也不能据最终文字变化宣称已经完成要求的单次撤销、重做、再次撤销流程。

## 修复后真人复验

首次修复后复验曾从保存记录重新挂载干净副本 `cd049fbf-b6be-443f-8dc9-a0f5202f7fad`：正文与基线一致、3 项资源、27 页、`pending=false`，撤销与重做深度均为 0。对应的[就绪状态](m25-native-input-evidence/ime-retest-ready-state.json)与[截图](m25-native-input-evidence/ime-retest-ready.png)是该副本开始操作前的历史记录。

用户随后反馈 **“不再抖动，候选正常”**，见[真人确认反馈](m25-native-input-evidence/human-shuangpin-confirm-feedback.json)。这完成了候选显示及一次确认的视觉复验。读取页面准备导出时，补验正文面板已不在，页面显示等待运行；该变化的具体原因未确定，不能归因于用户或工具刷新。该轮事件未导出，因此没有将视觉反馈扩展为完整原生输入法流程通过，也没有宣称事件归档完成。

随后在新干净副本 `abb3bf03-721d-4fef-b6d1-a23f25258f2e` 续验，用户反馈 **“都正常，最后恢复原文”**。[修复后原始轨迹](m25-native-input-evidence/shuangpin-after-fix.json)已归档，包含 **1382 个连续事件，丢弃 0 个，未切换记录会话**；逐项分析见[分析 JSON](m25-native-input-evidence/shuangpin-after-analysis.json)。此前 `cd049fbf-…` 的就绪记录仍属于前一副本，未与本轮混用。

| 本轮实际观测 | 结果与边界 |
| --- | --- |
| 双拼确认 | 事件 98、491、1336 分别提交 4、19、46 字，均为非空候选确认 |
| 撤销与原文恢复 | 事件 129、525、1370 均记录 `⌘Z`、`shift=false`；其后正文事务 131、527、1372 均恢复基线 |
| 确认后几何 | 三组 `render-frame` 各 14、17、17 个，共 **48 个 post-RAF 样本**；各组在同一模型与 DOM 选区下光标顶部范围均为 **0 px**，编辑器与窗口滚动不变 |
| 最终内容 | 导出快照的完整正文、纸张设置、图片/附件/媒体三个资源节点与初始基线完全一致；27 页、`pending=false`、`composing=false`。资源引用与清单完整，本轮分析未重新读取资源字节 |
| 未观测到的操作 | 无重做、Shift 修饰键、Esc 或空 `compositionend`；轨迹证明的是三次确认后分别撤销，不能记作一次撤销→重做→再次撤销→Esc 的完整流程 |

几何结论仅使用 `geometryTiming=animation-frame-then-task` 的采样，不把同步事务中的测量暂态计为可见跳动。各组首样本分别在确认后 **102.3、98.5、58.4 ms** 才取得，之前的区间没有 post-RAF 覆盖；这些样本也不单独证明每个物理屏幕帧。结合用户的“不再抖动”和“都正常”视觉反馈，本轮确认行为未再报告抖动，但不扩大为逐帧完整捕获。三次撤销后的正文恢复有直接证据，撤销阶段没有独立 post-RAF 采样组。

## 物理跨页与跨窗口拖选

物理补验使用干净副本 `4fd753fa-a76d-490a-9b21-2fc0f5c2b848`，开始时正文与基线一致、3 项资源、27 页、`pending=false`，撤销与重做深度均为 0；[就绪状态](m25-native-input-evidence/physical-drag-ready-state.json)与[截图](m25-native-input-evidence/physical-drag-ready.png)保留初始环境。用户反馈“能选中两页文字，稳定无跳动”“松手后停止，返回和重新拖选都正常”，见[真人反馈](m25-native-input-evidence/human-physical-feedback.json)。

两次跨页选区分别为 1125–1200、220–302，跨过分页边界 1159、261，按下、移动、释放及处理后模型与 DOM 选区证据完整，正文保持基线；见[跨页原始记录](m25-native-input-evidence/physical-cross-page.json)与[分析](m25-native-input-evidence/physical-cross-page-analysis.json)。随后三次释放位置均超出源窗口右边界，记录到 `buttons=0`、返回和重新拖选；结合源窗口与右侧独立窗口的原生摆放信息及用户确认，跨窗口释放、返回和重新选择通过。见[离窗释放原始记录](m25-native-input-evidence/physical-window-release.json)与[分析](m25-native-input-evidence/physical-window-release-analysis.json)。

这组完整档案有 896 个连续事件、`droppedEvents=0`；按 80 ms 规则节流了 1234 个移动事件，不代表所有原始移动点均被保存。序号 894 起属于取证控件操作，工具点击引起的外层滚动不算作真人返回或释放失控证据。`isTrusted` 结合用户操作确认使用；本轮没有独立验证 `pointercancel` 路径，也不声称取得每个显示帧的画面。`physicalPointerPassed=true` 的范围为跨页拖选、跨窗口释放、返回和重新选择。

## 工具栏历史操作与最后取消补验

同一副本后续的候选取消尝试实际留下了六次非空确认，共 42 字；每次之前都有空格键事件。之后用户另输入“重做验收”4 字。该阶段没有记录到 Esc 或空 `compositionend`，不能判断系统是否吞键，也不能把这次尝试记为取消成功。基线与快照的精确差分只有这两段插入，其余正文和资源节点不变；见[取消阶段原始记录](m25-native-input-evidence/native-cancel-before-toolbar.json)与[分析](m25-native-input-evidence/native-cancel-analysis.json)。

工具随后点击正式工具栏“撤销 → 重做 → 撤销”，文本长度依次为 **13341 → 13337 → 13341 → 13337**。“重做验收”的局部文字、长度与选区精确恢复，再次撤销后的完整快照等于操作前完整正文仅移除这 4 字。操作来源是工具点击，不能记成人工键盘快捷键验收；中间重做阶段只保存了局部读出状态，没有完整正文快照，不能将其扩大为整份 JSON 的精确比较。见[逐步读出](m25-native-input-evidence/toolbar-history-observation.json)、[原始记录](m25-native-input-evidence/native-toolbar-history.json)与[分析](m25-native-input-evidence/toolbar-history-analysis.json)。

上述分析的末尾仍有先前 42 字，这是当时的阶段结果。随后又点击一次正式“撤销”，事件 2108 恢复原始正文，新的[取消前干净快照](m25-native-input-evidence/native-pre-cancel-clean.json)已核对 **完整 `snapshot.content` 与 `baselineContent` 相等**，三个资源节点也完全一致；文本长度 13295、27 页、`pending=false`、`composing=false`。因此当前已恢复整个基线，不沿用上一份分析的 42 字残留状态。

最后单独验收一次 `a → Esc`，用户确认候选出现后按 Esc 消失。[原始记录](m25-native-input-evidence/native-escape-final.json)中，2125 为可信 `KeyA`，2127 开始组合输入，2129 更新候选 `a`，2134 文本长度变为 13296；2137 为 `composing=true` 时的可信 Escape，2139 候选更新为空，2144 恢复 13295 且 `originalMatches=true`，2146 以空 `compositionend` 结束。Escape 后 20.2 ms 已恢复原文；结束事件仍为 `trusted=false`，不改变前述事件来源边界。

这次取消后有 **14 个 post-RAF 样本**，同一选区 261、光标顶部 570.90625 px、滚动均不变，位移范围 0 px；样本覆盖 `compositionend` 后 63.9–302.4 ms，之前的区间没有 post-RAF 覆盖，不扩展为每个物理帧均已采集。最终完整快照与基线相等，三个资源节点不变、27 页、`pending=false`、`composing=false`。见[取消分析](m25-native-input-evidence/native-escape-analysis.json)。原生候选取消已通过；结合前述真人确认、撤销与正式工具栏历史操作，本轮 `nativeImePassed=true`，其中重做来源明确为工具点击，人工 `⌘⇧Z` 未单独声称通过。

同一会话在后续操作中达到 2000 条环形记录上限，各文件保留自己的截断状态：

| 原始档案 | 保留序号 | `droppedEvents` |
| --- | --- | --- |
| `physical-window-release.json` | 1–896 | 0 |
| `native-cancel-before-toolbar.json` | 77–2076 | 76 |
| `native-toolbar-history.json` | 108–2107 | 107 |
| `native-pre-cancel-clean.json` | 121–2120 | 120 |
| `native-escape-final.json` | 177–2176 | 176 |
| `native-saved-final.json` | 178–2177 | 177 |

按序号核对，后一个档案与已归档事件分别有 820、1969、1987、1944、1999 条重叠，重叠内容完全一致，联合可组成 **1–2177 的连续链**。没有修改原始文件，也不把任一截断文件描述为无丢弃；这条联合链仍保留移动事件节流的既定边界。

## 保存、清理与最终收口

完成取消后点击正式保存按钮，界面显示已保存到此浏览器。[保存后记录](m25-native-input-evidence/native-saved-final.json)再次核对完整正文与基线相等，最终状态为文本长度 13295、27 页、`pending=false`、`composing=false`；另保存[状态](m25-native-input-evidence/native-final-state.json)与[正文截图](m25-native-input-evidence/native-final-body.jpg)。本项记录保存按钮及界面确认，不另声称完成一次刷新重载。

随后通过正常结束按钮清理，页面回到“等待运行”，`remainingFixturePanels=0`，见[清理记录](m25-native-input-evidence/cleanup.json)；两个临时 Chrome 标签已关闭。清理范围仅本轮完成的副本 `4fd753fa-a76d-490a-9b21-2fc0f5c2b848`，不宣称全部历史测试数据库已清空。

用户本轮要求的真实中文输入与物理拖选补验已完成。用户随后明确决定“WPS 不看了，M25 收尾”，WPS 原生打开、编辑保存和导回移出本轮验收范围，状态保持未验收。

已有 [Word 原生往返结果](m25-word-roundtrip.md)与本轮输入/拖选证据已合入[M25 最终验收矩阵](m25-closure.md#最终验收矩阵2026-10-29)。M25 已收口，最终汇总见[收口 JSON](m25-closure-evidence/final-verification-summary.json)。
