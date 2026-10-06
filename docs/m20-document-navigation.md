# M20 · 目录、书签与文内链接

2026-10-04，验收结果 passed。本批在现有编辑器中接入自动目录、命名书签和文档内部链接，完整／极简模式共用命令与设置草稿。

## 使用方式

1. 将光标放在正文段落，打开「插入 → 目录」。填写目录标题并选择包含的标题级别，确认后在原光标处插入。默认显示 H1–H3，最高可包含 H6；标题改名、增删或调整级别会自动更新目录。
2. 选中目录，使用「目录设置」「更新目录」「删除目录」。设置和删除均支持撤销；自动更新随正文修改一起撤销。没有符合条件的标题时显示「暂无可用标题」。
3. 将光标放在段落或标题中，打开「插入 → 书签」，输入名称后添加。书签绑定打开面板时的整段或标题；「使用当前段落」可重新绑定。管理面板支持定位、重命名和删除，删除书签保留原文字。
4. 选中文字，打开「链接」，选择「文档位置」，再选择标题或书签并应用。光标位于已有链接内时可修改整条链接。外部地址的原有流程继续可用。

编辑状态下按住 macOS Command 或其他系统 Ctrl 点击目录条目或内部文字链接，可定位正文；只读预览直接点击即可。定位到收起的详情内容时自动展开。目标已经删除时显示错误，不将文档地址改成失效的片段地址。

目录标题和书签名称为 1–80 个单行字符。目录按正文顺序收集指定级别以内的标题，最多保存 2000 条；单条标题文字最多 1000 个字符。书签目前绑定整段或标题，不提供跨段文字范围书签。目录没有页码或点线引导符。

## 目标、保存与复制

标题在目录或内部链接需要时获得稳定导航 ID；改名及位置移动保留 ID。同一标题的书签和目录条目使用同一个目标。删除标题书签保留标题目标，删除普通段落书签清除该书签目标。

导航属性和目录快照属于文档 JSON，随现有保存和文件流程保留。实际浏览器验收覆盖 IndexedDB 保存重开、Mewoc 文件转换与下载，手动页面保存刷新后目录、书签和内部链接均保留。

复制粘贴与本地拖动复制共用目标重映射：目标 ID 冲突时分配新 ID，同一复制片段内的内部链接和目录条目指向复制出的目标；不在片段内的目标链接仍指向原位置。书签名称冲突时添加副本序号。片段自身包含重复 ID、无法确定引用对象时保留文字并去除歧义链接。移动使用原生编辑器移动流程，保持目标身份。

设置面板在打开时捕获原位置，持续映射正文事务。切换工具栏保留草稿；原节点删除或替换后，旧草稿失效，撤销恢复节点也不会复活旧草稿。只读、文档切换及组合输入期间禁止写入；只读允许查看书签和定位。

## 导出行为

| 格式 | 目录与内部链接 |
| --- | --- |
| Mewoc | 保留目录节点、稳定目标、书签名称与链接，可继续编辑。 |
| HTML | 刷新目录快照，输出真实目标锚点及内部链接，可在导出页面中点击。 |
| 打印视图 | 使用与 HTML 相同的静态目录和目标；系统 PDF 是否保留链接取决于打印实现，本批未验收系统 PDF。 |
| DOCX | 输出当前目录文字和原生内部超链接；目标使用成对且数字 ID 唯一的 Word 书签。目录是静态快照，不是 Word 自动目录域，不包含自动页码。 |
| Markdown | 目录转换为真实嵌套列表；内部链接转为可读文字，书签导航能力不保留，导出前说明降级。 |
| TXT | 保留目录标题、条目层级和完整正文；不输出内部 ID 或书签名称。 |

目标不存在的内部链接在静态导出时保留文字，不生成无效跳转。转换操作使用正文副本，不修改当前文档、修订或撤销历史。原生 Word 目录域和书签导入仍沿用既有导入降级，不承诺导航完整往返。

## 实现与注释

- `tools/document-navigation.js` 定义纯 JSON 契约、导航目标和目录快照；文件校验、剪贴板和导出复用同一规则。
- `extensions/document-navigation.js` 管理稳定 ID、目录实时同步、组合输入后的同步及真实 DOM 点击导航。
- `tools/navigation-commands.js` 管理原目标映射、目录与书签命令、原文字和目的位置的原子链接修改。
- `tools/navigation-clipboard.js` 与 `tools/pasted-navigation.js` 分别处理编辑器 Slice 和 HTML，覆盖复制／移动、名称冲突及歧义引用。
- `tools/navigation-export.js` 提供静态导出目标检查；DOCX、Markdown 和 TXT 使用各自格式的转换规则。
- `components/NavigationControls.jsx` 与 `LinkAction.jsx` 实现入口和表单，注释说明原目标生命周期、并发属性及权限保护。

目录条目纳入既有文件节点和字符预算。首次建立标题 ID 使用一次目标扫描和共享已用 ID 集合；同一文档的多个目录复用六种级别筛选结果，避免对每个标题重复扫描全文。

## 验收与证据

Node **551/551**、浏览器 **121/121**、全量 lint、生产构建和 `git diff --check` 通过。新增 Node 用例为核心 19、转换 10、剪贴板 6、拖动 7，共 42 项。最终结果在[验收汇总](m20-document-navigation-evidence/verification-summary.json)。

| 浏览器组 | 结果 | 证据 |
| --- | --- | --- |
| 目录、书签与文内链接 | 16/16 | [专项](m20-document-navigation-evidence/browser-final.json) |
| 常规编辑 | 62/62 | [回归](m20-document-navigation-evidence/regression.json) |
| 工具栏 | 29/29 | [工具栏](m20-document-navigation-evidence/toolbar.json) |
| 文本框与折叠详情 | 14/14 | [容器回归](m20-document-navigation-evidence/rich-blocks.json) |

四组浏览器与[手动预览控制台](m20-document-navigation-evidence/manual-console.json)均没有警告或错误。`browser-first.json` 与 `browser-final.json` 保存同一次通过的专项结果，不重复累计；`node-first.log` 为中途验证，最终 Node 计数使用 `node.log`。

真实界面下载并核对五种文件，见[下载核对](m20-document-navigation-evidence/manual-export-checks.json)：HTML 有 4 个有效目标和 4 条内部链接；DOCX 有 4 对唯一数字书签和 4 条内部超链接；Markdown 目录含两个真实子列表项。样本为 [Mewoc](m20-document-navigation-evidence/manual-export.mewoc.json)、[HTML](m20-document-navigation-evidence/manual-export.html)、[Word](m20-document-navigation-evidence/manual-export.docx)、[Markdown](m20-document-navigation-evidence/manual-export.md)、[TXT](m20-document-navigation-evidence/manual-export.txt)。

真实页面操作另外确认 Command 点击、内部文字链接定位、标题编辑后目录更新、书签添加／重命名、保存刷新及只读点击保持页面 URL。独立专项检查只读定位收起详情时自动展开，正文 JSON 和修订保持不变。

已核对[浅色完整模式](m20-document-navigation-evidence/editor-light.png)、[深色极简模式](m20-document-navigation-evidence/compact-dark.png)、[书签面板](m20-document-navigation-evidence/bookmarks-light.png)和[内部链接面板](m20-document-navigation-evidence/internal-link-light.png)。920×600 深色窗口下，书签重命名和目录标题输入两侧均保留 6px 焦点描边空间，三个弹窗底部均在视口内，详见[视口测量](m20-document-navigation-evidence/viewport-checks.json)。结束时恢复 1280×720、完整模式、跟随系统主题和 100% 缩放。验收使用独立端口，4177 用户正文未参与测试。

## 发现并修复的问题

1. 只读点击绕过普通编辑点击回调，浏览器执行默认片段跳转。改为 DOM 点击处理，补充真实 DOM 和只读折叠定位断言。
2. 删除相邻目录时，旧设置目标可能映射到另一目录。仅允许原目录的准确属性替换步骤保留身份，删除或替换后拒绝旧草稿。
3. Markdown 目录原先依赖段落空格表达层级，渲染后层级丢失。改为实际嵌套列表，并使用 Markdown AST 检查父子关系。
4. 首次建立大量标题目标会重复扫描全文。共享已用 ID 集合，3000 标题固定样例检查全树遍历次数，不依赖不稳定的耗时阈值。
5. 原生本地拖动复制绕过 HTML 清洗，可能保留指向原文的链接。对复制 Slice 统一重映射，补充实际拖动处理路径、移动保持 ID 和禁写保护用例。

本批无未解决的具体 P0/P1/P2。界面沿用此前实际参考过的 Umo 工具栏交互和 Mewoc／Tabler 风格；没有声称复刻 Umo 的目录或书签交互，也没有重新执行 Word/WPS 本体排版、系统 PDF、真实输入法候选或物理鼠标拖动验收。
