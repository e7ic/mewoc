# M19 文本框与折叠详情

日期：2026-10-04。状态：本批实现与验收完成。

## 使用方式

「插入」增加文本框与折叠详情，完整模式和极简模式共用功能。在普通正文或引用内的光标处插入空容器，会保留光标两侧文字；选中完整的相邻段落或标题时，将原内容放入容器。部分文字选区、列表、表格及已有容器内部不开放这个插入入口，避免意外改变结构。

文本框随正文自然排列，内部继续使用正常富文本节点。将光标放入框内，点击「文本框设置」可选简洁、提示、提醒配色，并设置背景、边框颜色、0–6 px 边框宽度和 0–40 px 内边距。它不提供浮动定位、旋转或文字环绕，不用于还原 Word 原有浮动文本框布局。

详情默认展开，点击标题前的箭头可以收起或展开，支持键盘按钮操作；「折叠详情设置」修改 1–120 个字符的普通文字标题。标题是容器属性，不是段落，不进入正文查找或字符统计；正文内的标题、文字、列表与表格仍参加原有查找和统计。大纲或查找将选区定位到折叠正文时，会自动展开对应详情。

折叠属于当前视图状态，不进入正文 JSON、修改序号或撤销历史，重新打开文档会展开。只读时仍可展开和收起。输入法组合期间不折叠当前正文，避免隐藏输入位置。

点击「退出文本框 / 退出详情」或按 ⌘+Enter / Ctrl+Enter，将光标移到容器后的正文段落；需要时新增一段。点击「移除文本框 / 移除详情」只移除外壳，保留富文本结构；详情标题转换成普通段落。插入、属性修改、移除和新增退出段落均可独立撤销；跳转到已有段落不产生正文历史。

## 保存与文件转换

| 路径 | 实际行为 |
| --- | --- |
| 本地保存、历史、模板、Mewoc 文件 | 保留节点、属性和内部富文本，内部图片与附件继续按原资源 ID 保存 |
| HTML | 文本框保留外观；详情输出原生 `details/summary`，默认展开，可以离线折叠 |
| 编辑器打印 | 从最新快照重建默认展开的静态 HTML，包含全部详情正文；不读取当前收起的 NodeView |
| DOCX | 文本框转换为单格表格，保留底色、边框、内边距及富内容；详情展开为加粗标题和完整正文，下载前展示转换说明 |
| Markdown | 文本框展开为普通正文，详情保留加粗标题与完整正文；预览说明不保留容器外观或折叠交互 |
| 纯文本 | 保留详情标题、正文分段与任务状态，不改变原稿 |
| 内部 HTML 复制粘贴 | 保留合法容器及受支持的文字、表格、资源；重新生成白名单外观，不恢复任意事件或 CSS |
| 纯文本复制 | 完整详情保留标题和正文；仅选中正文片段时只复制该片段 |

DOCX 再导入时，文本框按照表格识别，详情按照普通标题与段落识别，不宣称保留 Mewoc 容器语义。打印分页仍由浏览器决定，本批不提供实时自动分页。

## 实现与边界保护

- `extensions/block-containers.js` 注册 `textBox` 与 `details`，正文使用 `block+`；编辑视图与静态序列化分开，折叠不写 `open` 属性。
- `tools/block-containers.js` 与文件 Schema 共用属性校验，颜色仅允许六位 HEX，数字只接收范围内的整数，详情标题拒绝空白、换行和控制字符。
- 插入目标跟踪原文字块及全部被包裹段落。任何原块被删除或整体替换，旧目标永久失效，撤销恢复也不会复活；普通文字或段落样式编辑允许映射。
- 设置弹窗跟踪原容器，切换选区或工具栏模式保留草稿；只合并用户修改字段，保留并发事务对其他属性的修改。目标删除、只读、切换及组合输入阻止提交。
- 详情 NodeView 仅忽略按钮和自己控制的显示属性，内部正文的 DOM 输入继续交给 ProseMirror。卸载释放按钮事件和选区监听。
- 畸形或外部详情在剪贴板清理时展开，保留标题、重复正文、包装外文字及顺序，不通过截取一个 body 静默丢失其余内容。
- 本批不创建互相嵌套的容器；已存在的合法嵌套内容可以保存和读取，仍受全树深度与节点预算约束。

## 验收证据

验收使用独立 4183 端口，当前 4177 文档不作为测试输入。浏览器汇总 **123/123**：M19 专项 14、常规编辑 62、工具栏 29、M18 图片与格式标记 13、Word 导出 5；另在默认开发配置下复验常规 62/62。计数与控制台记录见[最终验收汇总](m19-rich-blocks-evidence/verification-summary.json)。

| 检查 | 已确认结果 | 证据 |
| --- | --- | --- |
| Node 全量测试 | 509/509 通过 | [Node 日志](m19-rich-blocks-evidence/node.log) |
| 文本框与折叠详情浏览器专项 | 14/14 通过；焦点样式修复后在默认开发配置再次通过，控制台为空 | [最终专项结果](m19-rich-blocks-evidence/browser-final.json) |
| 全量 lint | 通过 | [lint 日志](m19-rich-blocks-evidence/lint.log) |
| 生产构建 | 通过 | [构建日志](m19-rich-blocks-evidence/build.log) |
| 常规编辑回归（固定验收配置） | 62/62 通过，控制台警告和错误为空 | [常规结果](m19-rich-blocks-evidence/regression.json)、[控制台](m19-rich-blocks-evidence/regression-console.json) |
| 工具栏回归（固定验收配置） | 29/29 通过，控制台警告和错误为空 | [工具栏结果](m19-rich-blocks-evidence/toolbar.json)、[控制台](m19-rich-blocks-evidence/toolbar-console.json) |
| M18 图片与格式标记回归 | 13/13 通过，控制台警告和错误为空 | [M18 结果](m19-rich-blocks-evidence/view-image.json)、[控制台](m19-rich-blocks-evidence/view-image-console.json) |
| Word 导出回归 | 5/5 通过；保留一条既有菜单组件卸载警告 | [Word 结果](m19-rich-blocks-evidence/docx.json)、[控制台](m19-rich-blocks-evidence/docx-console.json) |
| 常规编辑回归（默认开发配置） | 62/62 通过，控制台警告和错误为空 | [默认开发结果](m19-rich-blocks-evidence/regression-dev-final.json)、[控制台](m19-rich-blocks-evidence/regression-dev-final-console.json) |
| 受加载修正影响的 Node 测试 | 45/45 通过；全量 lint 再次通过 | 加载修正只调整测试导入方式 |
| 完整页面、深浅主题及窄窗口视觉检查 | 通过；焦点描边补修后原生复核通过 | [视口检查](m19-rich-blocks-evidence/viewport-checks.json)、下方截图 |
| 实际导出下载 | Mewoc、HTML、DOCX、Markdown、TXT 五种文件核对通过 | [下载核对](m19-rich-blocks-evidence/manual-export-checks.json) |

浏览器专项使用真实 Workspace、设置表单、IndexedDB、Mewoc 文件和独立 HTML iframe，覆盖两种工具栏模式、原位置插入与分段保留、整段包裹、属性草稿校验与实际 CSS、标题转义、折叠视图、搜索及大纲导航、原目标映射、删除失效、禁写保护、快捷键退出、保留内容移除、保存重开及复制导出。测试只按本轮随机文档 ID 清理数据，结束后恢复原工具栏与格式标记偏好。

M19 专项、常规编辑、工具栏、M18 回归及完整编辑器手动页面的控制台警告和错误为空，见[专项控制台](m19-rich-blocks-evidence/browser-final-console.json)与[手动页面控制台](m19-rich-blocks-evidence/manual-console.json)。Word 5/5 的日志包含一条已有 Menu Overflow 组件卸载后更新警告，未将该日志描述为无警告。

正文选区、按键和组合输入为合成事件，不作为物理鼠标或真实输入法候选操作的补验证据。DOCX 转换检查包含真实文件和 XML 结构；本批没有重新执行 Word/WPS 原生排版、系统 PDF 或真实输入法候选验收。

### 实际下载核对

在完整编辑器通过真实导出入口下载五种文件，逐一核对标题、容器内全部正文和格式对应的保存行为：

- [Mewoc 文件](m19-rich-blocks-evidence/manual-export.mewoc.json)保留文本框内边距 20、详情标题「补充材料」和富正文。
- [HTML 文件](m19-rich-blocks-evidence/manual-export.html)包含展开的完整详情，文本框内边距为 20px，不携带编辑按钮。
- [DOCX 文件](m19-rich-blocks-evidence/manual-export.docx)将文本框输出为一个单格表格，核对底色 `F5F3FF`、内边距 300 twips 和详情全文。下载前的[Word 转换说明](m19-rich-blocks-evidence/docx-dialog.png)明确容器转换行为。
- [Markdown 文件](m19-rich-blocks-evidence/manual-export.md)和[TXT 文件](m19-rich-blocks-evidence/manual-export.txt)保留详情标题与全文，不承诺保留文本框外观。导出前的[Markdown 预览与说明](m19-rich-blocks-evidence/markdown-dialog.png)已核对。

这些是实际下载文件的内容核验，Word 原生排版及系统 PDF 仍不在本批补验范围内。

### 首轮异常与修正

首轮专项为 13/14，最后一项部分文字复制断言失败。测试传入部分内容 Slice，却没有同步编辑器的真实选区；Tiptap 的纯文本复制序列化器仍读取当时的整个详情节点选区，因此把标题和完整正文作为复制结果。已修正测试，先派发对应的 NodeSelection 或 TextSelection，再序列化实际选区，并在部分复制自动展开后重新收起详情继续验证导出。生产代码未因此调整；复跑专项为 14/14。[首轮专项结果](m19-rich-blocks-evidence/browser-first.json)

首轮常规回归为 56/62，原因已定位为测试入口的模块混合加载：M18 的 `tests/view-image-checks.jsx` 静态导入 `markdown-converter`，其他入口动态导入 `markdown-file`。Rsbuild 懒编译后将共同模块的 chunk 移到不含 `async` 的路径，旧 runtime 仍请求原 `async` 路径并收到 HTML，导致模块加载失败。已将该测试改为使用异步门面，并在两处调用等待结果，生产代码保持原实现。固定验收配置下常规 62/62、工具栏 29/29 通过，默认开发配置常规复验也为 62/62；对应控制台警告和错误均为空。受影响 Node 测试 45/45、全量 lint 再次通过。[首轮常规结果](m19-rich-blocks-evidence/regression-first.json)、[首轮控制台](m19-rich-blocks-evidence/regression-first-console.json)

视觉检查发现实际 P2：920×600 深色极简模式的文本框设置中，右侧数值输入贴住 `ant-modal-body` 滚动裁切边界，2px 焦点描边加 2px offset 被裁掉。已为滚动区域增加 6px 内侧留白，通过 `content-box` 和 -6px margin 保持原表单占位，保留最大高度与局部滚动。原生复核确认两个数字框和详情标题的描边完整；详情标题距左右裁切边界均为 6px，大于 4px 描边外扩。920×600 下文本框弹窗底部为 417.7px，详情设置底部为 266.8px，均在视口内。[首次问题截图](m19-rich-blocks-evidence/settings-first-narrow-dark.png)与[修复后的内边距焦点](m19-rich-blocks-evidence/settings-narrow-dark.png)、[边框宽度焦点](m19-rich-blocks-evidence/settings-border-focus-dark.png)、[详情标题焦点](m19-rich-blocks-evidence/details-settings-narrow-dark.png)保留供对照。补修后 lint 和最终生产构建通过。

### 页面截图

已实际核对[浅色完整模式](m19-rich-blocks-evidence/editor-light.png)、[深色完整模式](m19-rich-blocks-evidence/editor-dark.png)和[深色极简模式](m19-rich-blocks-evidence/compact-dark.png)：插入入口沿用 Tabler 图标及现有工具栏排列，详情箭头、标题与文本框边框可辨，白纸正文保持固定色板。窄窗口的设置截图与焦点补修证据见上方。

检查结束后恢复 1280×720 视口、浅色主题、完整模式和 100% 缩放。4177 用户正文未参与验收修改；本批没有遗留容器功能或视觉 P0/P1/P2，Word 回归中的既有卸载警告另行如实留档。

参考 Umo 演示的「插入 → 文本框 / 详情」即时插入与展开按钮，实际查看证据见 [Umo 参考](m19-rich-blocks-evidence/umo-reference.png)。本批实现正文流式文本框及普通标题详情，不宣称覆盖 Umo 的全部容器交互。
