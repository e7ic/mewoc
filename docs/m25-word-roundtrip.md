# M25 Word 原生往返验收

2026-10-29，代码基线 `6426c1d`，macOS Microsoft Word **16.100.2**。本轮通过 Word 桌面界面打开浏览器正式导出的 DOCX、修改另存、打印 PDF，再通过 Mewoc 正式「导入 Word」选择原生回存文件。

**最新结果：Word 水印显示与字母编号差异已修复，原生显示及数据往返复验通过。** 最终 Word PDF 为 30 页，48 项字母编号从 `g` 到 `bb` 与浏览器一致；水印在无不透明底色遮挡处可见，正文底色覆盖仍遵循置于文字背后的规则。正式导回、保存刷新与备份核对通过，全量 Node **883/883**。真实中文输入和物理跨窗口拖选已在后续补验完成；2026-10-29 用户明确排除 WPS，M25 已收口，见[最终矩阵](m25-closure.md#最终验收矩阵2026-10-29)。下文保留历史失败和前两轮结果，Word 最终证据见文末「水印与字母编号显示修复复验」。

## 首轮样本和操作（修复前）

原件为 [browser-export.docx](m25-native-evidence/browser-export.docx)，17281 字节，SHA-256 `aad0d66c61be08b7b0b75b664043caaab9e3fbdeffa58af9c55a30d32998b20a`。复制为 [word-input.docx](m25-word-roundtrip-evidence/word-input.docx) 后操作，原件保持不变。

1. 在 Word 打开副本。打开时出现更新引用域提示，选择「否」，随后文档正常排成 30 页。
2. 在最后一段末尾追加一次 ` M25_WORD_ROUNDTRIP_20261029`。过程中曾新建末段造成 31 页，已撤销该段和输入，最终改为原段内追加，恢复 30 页；最终 XML 证实只增加上述文字。
3. 通过「另存为」保存 [word-resaved.docx](m25-word-roundtrip-evidence/word-resaved.docx)。[修改画面](m25-word-roundtrip-evidence/word-resaved.png)与[首页面](m25-word-roundtrip-evidence/word-first-page.png)记录 Word 原生状态。
4. 使用 Word 系统打印窗口「PDF → 保存为 PDF」，生成 [word-native-layout.pdf](m25-word-roundtrip-evidence/word-native-layout.pdf)。打印后又另存 [word-fields-updated.docx](m25-word-roundtrip-evidence/word-fields-updated.docx)，作为第二次导入样本。文件名表示操作过程，不代表字段缓存已成功刷新：两份 DOCX 的 PAGE/NUMPAGES 存储缓存仍为 1/1；原生 PDF 实际显示 1–30/30。
5. 刷新 `http://127.0.0.1:4182/`，使用正式「导入 Word」及系统文件选择器选择第二份样本。最终提示「Mewoc 页眉、页脚或页码结构无法可靠恢复，请保留原 DOCX」，「导入为新文档」不可用。见[最终截图](m25-word-roundtrip-evidence/browser-fields-updated-import-failure.png)与[界面文本](m25-word-roundtrip-evidence/browser-fields-updated-import-failure.txt)。没有创建回导文档。

## 内容和原生排版核对

完整比较见 [XML 结构对照](m25-word-roundtrip-evidence/structural-comparison.json)，原生 PDF 的逐页和文字核对见 [PDF 验收结果](m25-word-roundtrip-evidence/pdf-review.json)。本轮结论与清理状态见[验收摘要](m25-word-roundtrip-evidence/verification-summary.json)，归档文件校验值见 [SHA-256 清单](m25-word-roundtrip-evidence/SHA256.json)。

| 检查项 | 结果 |
| --- | --- |
| 正文 | 两次回存均完整等于原正文加唯一验收标记，起止标记各一次 |
| 表格 | 2 表、49 行、97 格保持；包括 48 行主表与文本框转换的单格表 |
| 长段、代码和待办 | 长段重复 110 次、引用重复 80 次、代码 90 行、待办已选 8 项及未选 16 项保持 |
| 有序列表 | 48 项、原顺序、`lowerLetter` 类型和起始值 7 保持；显示标签差异单列下文 |
| 图片 | 唯一 PNG 1100 字节，SHA-256 `3000f55839a18c6dfd0eba68fa2912af63d525c33b1c402d4fdbef7ca1aa4c4b` 保持 |
| 页面 | A5 纵向、四边 850 twip（约 15 mm）、页眉页脚距离保持 |
| Word PDF | 30 页，约 419.528 × 595.276 pt；页眉页脚 30/30，页码连续 |
| 视觉检查 | 全部 30 页渲染检查，另放大检查第 1、13、19、30 页；未见正文裁切、页脚重叠或额外空白页 |
| 表格续页 | 第 9–13 页均重复两列表头，47 行正文两列各出现一次 |
| 水印 | DOCX XML 保留水印文字和形状，但 Word 屏幕首页面及全部 30 页 PDF 未显示水印，未通过 |
| 字母编号显示 | Word 在 `z` 后显示 `aa、bb、cc…zz、aaa、bbb`；浏览器为 `aa、ab…bb`，存在语义显示差异 |

逐页联系表：[1–10 页](m25-word-roundtrip-evidence/word-pages-01-10.png)、[11–20 页](m25-word-roundtrip-evidence/word-pages-11-20.png)、[21–30 页](m25-word-roundtrip-evidence/word-pages-21-30.png)。Word 的 30 页与此前 Chrome 的 27 页分别由各自排版引擎产生，不以页数相等作为通过条件。

文本框转单格表、详情展开、代码转保留换行的正文、待办转 `[x]` / `[ ]` 文字、附件与媒体转文件说明属于既有 DOCX 转换边界。本轮没有把这些差异当作新增数据丢失。

## 导入失败定位

原始浏览器导出文件经生产转换器及会话组装函数可以转换，见 [Node 基线](m25-word-roundtrip-evidence/import-baseline.json)。此辅助检查使用 Node/JSDOM，图片尺寸来自文件头，不代替浏览器解码或原生 Word 验收。

两份 Word 回存文件均在 `src/pages/editor/tools/docx-import-furniture.js:165` 被拒绝，日志分别为[首次回存](m25-word-roundtrip-evidence/node-resaved-import-failure.log)和[打印后再保存](m25-word-roundtrip-evidence/node-fields-updated-import-failure.log)。确定的首个阻塞是 Word 在自有页眉/页脚内容控件的 `w:sdtPr` 内添加 `w:id`，当前实现只接受 `w:tag`。

实际回存 XML 还包含后续兼容差异：文字被拆为多个 run、默认格式被省略、简单 PAGE/NUMPAGES 域变成复杂域、段落增加元数据。水印被改写为两个 VML shape，旋转从 −35° 变为 325°，透明度从小数变为固定点表示，几何尺寸发生量化。现有严格结构匹配不能覆盖这些原生保存结果，不能只放开首个 `w:id` 就宣称往返修复。

早期浏览器尝试曾显示「目录或页码域没有完整的已保存显示值」，保留在[早期截图](m25-word-roundtrip-evidence/browser-resaved-import-failure.png)与[文本](m25-word-roundtrip-evidence/browser-resaved-import-failure.txt)。刷新应用并使用打印后再保存样本后，最终浏览器与 Node 的页部件拒绝信息一致；不把早期界面现象作为最终根因。

## 首轮后续计划与边界（历史记录）

1. 兼容 Word 对已识别 Mewoc 页眉、页脚、页码和水印的原生改写，并继续拒绝无法安全解释的未知结构；用本次两份原生样本补回归。
2. 定位水印在 Word 原生屏幕和打印中不可见的原因；XML 存在不能作为显示通过的证据。
3. 处理或明确 Word 与浏览器在 `z` 之后的字母编号规则差异，再复跑原生打开、修改、保存与正式浏览器导回。
4. Word 往返通过后仍需补真实中文输入法和物理指针跨窗口拖选，才能更新 M25 最终收口矩阵。

本轮遇到 Word 窗口控制超时，用户正常退出重开后恢复；Chrome 自动选文件通道未开放本地文件权限，改用系统选择器完成最终操作。上述工具现象没有计为产品通过或产品缺陷。只关闭本轮创建的验收标签及 Word 样本窗口，已停止 4182 验收服务，没有删除已有浏览器文档。

## 原生回存兼容修复与复验（2026-10-29）

修复仅覆盖已确认的 Word 原生改写，保留严格拒绝未知内容的边界：

- 自有页眉页脚允许 Word 添加的控件 ID、段落元数据、拆分文字和完整的 PAGE/NUMPAGES 复杂域。省略的格式只从文档实际 styles 关系指向的已验证默认样式恢复；额外内容、缺失字段边界、错误字体、重复或非法关系继续拒绝。
- 水印识别原生隐藏/可见 VML 配对、325° 等值旋转、16.16 固定点透明度和已确认的尺寸量化；混合多水印按可见形状的原文顺序选择首个。未知形状或不一致配对继续拒绝。
- 仅识别样本中表格行级 `tblPrEx` 的上下零边距，明确提示使用编辑器默认间距；不屏蔽任意 Mammoth 警告，不吞掉未知表格内容。

固定回归直接使用首轮的 `word-resaved.docx` 与 `word-fields-updated.docx`，校验原始 SHA-256、完整正文、表格及合并、48 项编号和起点、89 个代码换行、页面设置及图片原字节，并再次执行 Mewoc 导出/导入。另有原生回存变异测试覆盖未知内容和字段损坏。测试位于 `tests/docx-word-roundtrip.test.js`、`tests/docx-furniture-native.test.js`、`tests/docx-import-watermark-native.test.js`、`tests/docx-import-table-native.test.js`。

复验从同一浏览器正式导出原件的新副本开始，在 Word 16.100.2 中于原末段追加 ` M25_WORD_RECHECK_20261029`，原生另存为 [新的回存文件](m25-word-roundtrip-evidence/recheck/word-resaved.docx)。保存先落到临时目录，再逐字节复制归档；未用脚本改写 DOCX。新文件为 27115 字节，SHA-256 `7012942741f34e65e52d343b94ce8872fc7eb8c8e08d19278275f75a9806e7c4`。见 [Word 编辑画面](m25-word-roundtrip-evidence/recheck/word-edit.png)与[另存画面](m25-word-roundtrip-evidence/recheck/word-resaved.png)。这次 Word 窗口显示 40 页；未取得新的原生 PDF，故不将首轮 30 页视觉检查算作本次排版通过。

通过内置浏览器的正式「导入 Word」文件选择、预览和「导入为新文档」完成导回，保存后刷新恢复；最终代码重新导入后的名称为「M25 Word 原生回存修复复验（最终）」。Chrome 的扩展文件权限与原生窗口控制未能完成本次选文件，改用内置浏览器；没有通过隐藏状态或直接数据库写入代替产品流程。图片在浏览器实际解码为 240 × 120。正式下载的 [Mewoc 备份](m25-word-roundtrip-evidence/recheck/browser-imported.mewoc.json)用于核对保存内容；分页产生的重复表头与列表装饰不计入正文。

正文、表格、编号、图片字节和页面设置的核对见[内容复验](m25-word-roundtrip-evidence/recheck/content-verification.json)，辅助生产转换结果见 [Node 记录](m25-word-roundtrip-evidence/recheck/node-import.json)，正式界面见[导入预览](m25-word-roundtrip-evidence/recheck/browser-import-preview.png)及[保存恢复截图](m25-word-roundtrip-evidence/recheck/browser-import-success.png)。透明度保留 Word 固定点值 `0.1199951171875`，与原 `0.12` 的差异小于 `1/65536`，不伪装为无损精度。

最终全量 Node **857/857**、lint、生产构建及 `git diff --check` 通过，23 项内容断言全部通过。最终测试、构建和文件校验见 [复验汇总](m25-word-roundtrip-evidence/recheck/verification-summary.json)。剩余工作是 Word 原生水印显示、字母编号规则差异，以及真实中文输入法和物理指针跨窗口拖选；WPS 仍未验收。本次通过限定为原生回存的数据往返，不代表外部排版已全部一致。

复验清理：已关闭本轮 Word 样本窗口及 Chrome/内置浏览器验收标签，停止 4182 服务；保留已保存的验收文档和证据文件。复验文件的校验值见 [SHA-256 清单](m25-word-roundtrip-evidence/recheck/SHA256.json)。

## 水印与字母编号显示修复复验（2026-10-29）

本轮修复的是 Word 原生显示差异，并保留已完成的回存导入兼容与 NDA 回归。标准 WordArt 136 的完整 VML 形状模板和 `_x0000_t136` 类型引用恢复了原生水印显示；实例 `fitshape` 仍为 `false`，透明度沿用源设置。导入同时识别完整标准模板及 Word 原生改写，保留旧自有格式与隐藏/可见配对兼容，未知同 ID 模板、重复形状和额外内容继续拒绝。

字母列表导出按每 26 项分段，使用实际编号与前缀保持浏览器的进位规则，并以自有段落样式关联原列表。导回依据真实编号定义、前缀和段内计数恢复自动列表，不将编号写进正文。大小写 24–55 的两组原生候选各 **32/32** 正确；旧 `lowerLetter` 和 `custom=a` 候选均从第 28 项起偏离；[候选原生 DOCX](m25-word-roundtrip-evidence/display-fix/letter-candidates-word-resaved.docx)、[候选 PDF](m25-word-roundtrip-evidence/display-fix/letter-candidates-native.pdf)和[独立标签核对](m25-word-roundtrip-evidence/display-fix/letter-candidate-review.json)保留了修复前后的对照。最终混合长文的 **48/48** 项依次为 `g…z、aa、ab…az、ba、bb`。在 Word 中跨分段增删项目后应从 Mewoc 重新导出，正式导出提示已说明这一边界；段内计数超过 26 时导回明确拒绝，避免恢复错误标签。

### 正式往返路径

1. 从更新后的正式浏览器工具栏重新下载 [本轮 DOCX](m25-word-roundtrip-evidence/display-fix/browser-export.docx)，未复用旧导出文件。该文件为 17604 字节，SHA-256 `b2e07f970029f47343144dc8dca6c7ae9f39912a1b6faddf068395ebca3f1261`。
2. Word 16.100.2 打开临时副本，在原末段仅追加一次 ` M25_WORD_FINAL_20261029`，通过 Cmd-S 原生保存，再逐字节复制为 [原生回存文件](m25-word-roundtrip-evidence/display-fix/word-resaved.docx)。文件为 27656 字节，SHA-256 `cf1ce811cc900a654074c70dd8a2bd5c44498a4a33690648b22255aa6637cc73`。见 [Word 首页](m25-word-roundtrip-evidence/display-fix/word-first-page.png)与[保存画面](m25-word-roundtrip-evidence/display-fix/word-resaved.png)。
3. 从 Word 原生打印，在「预览」中打开打印结果并保存 [30 页原生 PDF](m25-word-roundtrip-evidence/display-fix/m25-display-native-layout.pdf)。保存窗口曾受前台状态影响，用户将窗口前置后成功完成；PDF 文件及后续解析确认保存成功，不将工具等待计为产品排版耗时。该 PDF 的元数据 Title 沿用了旧值 `m25-letter-tagged-resaved`，Creator 为 Word；样本身份以文件 SHA-256、30 页实际正文和唯一最终标记核对，不按元数据标题判断。
4. 在内置浏览器正式首页通过「导入 Word」选择原生回存文件，导入为新文档「M25 Word 水印与编号复验」，保存并重载后正式下载 [Mewoc 备份](m25-word-roundtrip-evidence/display-fix/browser-imported.mewoc.json)。这条路径未通过数据库写入或隐藏状态代替导入。见[保存恢复截图](m25-word-roundtrip-evidence/display-fix/browser-import-success.png)。

### 内容和视觉结果

[内容核对](m25-word-roundtrip-evidence/display-fix/content-verification.json) **24/24** 通过：原生 XML 正文只增加唯一验收标记，段落、表格、行列与换行数量保持；生产导入和正式浏览器备份的正文、列表类型与起点、逐项内容、表格合并、页面设置及图片字节一致。历史 DOCX 样本保持原 SHA-256；原始 NDA 未修改。Word 颜色大小写与 16.16 透明度量化仍按已记录的容差比较。

[PDF 内容检查](m25-word-roundtrip-evidence/display-fix/pdf-verification.json) **16/16** 通过：30 页 A5，页眉页脚当前页/总页数连续正确，长段落、表格正文 47 行两列、48 项字母列表、24 项待办和 90 行代码保持完整。独立标签期望按浏览器字母进位规则计算，不依赖导出实现。已逐张查看全部 30 页渲染，记录见[逐页视觉检查](m25-word-roundtrip-evidence/display-fix/visual-review.json)。逐页联系表为[第 1–10 页](m25-word-roundtrip-evidence/display-fix/word-pages-01-10.png)、[第 11–20 页](m25-word-roundtrip-evidence/display-fix/word-pages-11-20.png)、[第 21–30 页](m25-word-roundtrip-evidence/display-fix/word-pages-21-30.png)，另保留[第 16 页编号](m25-word-roundtrip-evidence/display-fix/word-page-16.png)及[第 30 页](m25-word-roundtrip-evidence/display-fix/word-page-30.png)单页图。未见正文裁切、页脚重叠或新增空白页；表格跨页重复表头，列表在分段处显示连续。

水印的通过范围按实际视觉结果记录：**第 1–19 页和第 30 页可见，第 29 页部分可见，第 20–28 页被正文不透明底色遮挡。** 水印仍位于正文背后，表格、容器或代码的底色可覆盖它；这是该层叠方式的显示边界，不能写成「30 页均可见」。与首轮所有页面都无水印不同，本轮已证明原生 Word 能正确绘制水印。

最终全量 Node **883/883**、lint、生产构建及 `git diff --check` 全部通过。新增标准水印模板、原生回存样本和字母分段回归保留严格拒绝未知结构的边界，既有 NDA 导入回归仍通过。汇总见[本轮验收结果](m25-word-roundtrip-evidence/display-fix/verification-summary.json)，文件校验见 [SHA-256 清单](m25-word-roundtrip-evidence/display-fix/SHA256.json)。

本轮 Word 显示修复和往返验收已完成。后续真实中文输入与物理跨窗口拖选亦已通过，WPS 原生往返按用户决定排除，M25 最终状态为已收口。编辑器、Chrome 打印和 Word 各自排版，不以页数相同作为通过条件。

本轮清理：夹具文档 `91f37117-bf3e-4edb-97bc-1d7d2aba9827` 已通过「结束原生混合长文补验」回到等待运行，见[界面记录](m25-word-roundtrip-evidence/display-fix/cleanup-ax.txt)，临时验收标签已关闭。独立正式导入文档再次重载后仍保存，保留其页面和 4182 服务供复核；「预览」保留已保存 PDF。最终应用清单显示 Word 未运行，只记录这一状态，不据此推断由本轮操作关闭。NDA 原件 SHA-256 再次核对未变。
