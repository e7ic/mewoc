# M10 · 文档模板

日期：2026-10-01。顶部「模板」提供会议纪要、项目周报和工作报告，也支持将当前文档保存为自定义模板。

## 使用与保存

打开「模板」，在「内置模板」或「我的模板」选择预览，再点击「用此模板新建」。预览是独立只读编辑器，不会修改当前正文或触发保存。新建前完成当前文档的保存；保存失败时保留当前会话并显示错误。新文档使用新的 ID、时间与独立资源副本，可继续编辑并使用现有导出流程。

「将当前文档保存为模板」接受 1–100 个字符的名称。保存前提交当前正文，模板保留文字格式、段落、列表、表格、纸张设置、图片和附件；批注内容与定位不进入模板，界面在保存时说明。来源正文与批注保持原样。自定义模板可以搜索、重命名和删除；删除模板不影响已经创建的文档。

模板是当前浏览器的本地数据，与本地文档库分开存放。清除站点数据会删除模板。模板自身没有单独导出格式；需要备份时先用模板新建文档，再导出 Mewoc 文件。内置模板不能重命名或删除；自定义模板列表读取失败时保留内置入口并显示错误，仍可只读预览，创建新文档依然需要本地存储可写。

## 存储与会话

沿用 IndexedDB v1 的 `assets` store。模板元信息使用 `template:<templateId>`，资源使用 `template-asset:<templateId>:<assetId>`；活跃文档与历史版本的键空间保持独立。保存模板在同一事务核对源文档版本、读取资源和写入快照；新建、重命名、删除也核对模板版本。资源缺失、版本冲突或写入失败时事务整体回滚。

模板快照与实例均校验现有文档 Schema。去批注使用独立 JSON 克隆，移除根节点 `commentThreads` 与文字 `commentAnchor`，保留其他内容与格式。预览资源 URL 按预览生命周期创建和释放；迟到的读取结果不覆盖后续选择。

保存和新建接入文件操作的共用锁。当前文档保存完成后，仓库原子创建新文档和资源，随后直接切换编辑会话，避免旧编辑器再次保存到新实例。

## 验证

Node 24.13.1 全量测试 285/285、lint（零警告）、生产构建与 `git diff --check` 通过。新增 23 项 Node 检查覆盖内置结构、去批注克隆、元信息与资源校验、来源及实例隔离、版本冲突、配额和异步请求错误回滚、删除游标失败回滚。

内置浏览器模板专项 10/10、常规编辑 62/62、文档库 8/8、历史版本 11/11、批注 8/8。专项使用真实 Provider、FileActions、弹窗、只读 Tiptap 和 IndexedDB，覆盖最新正文保存后新建、快速双击仅创建一份、保存模板保留格式并剥离批注、资源独立、重命名删除保留实例、关闭及迟到读取资源释放、来源保存冲突保留草稿、模板陈旧版本拒绝新建、缺失资源拒绝预览，以及损坏自定义元信息时保留内置入口。仅清理本轮随机 fixture ID，未清空数据库或删除既有文档与模板。

首轮专项 8/9：最后一条使用纯文字全等断言，却没有计入附件卡片的正文说明。修正为核对首段，同时保留编辑器身份与资源字节断言，最终 10/10 通过。完整页面发现新建按钮位于预览正文末尾，长模板使用不便，已移至预览标题旁并再次通过 10/10。

隔离端口 4181 的完整页面已从内置会议纪要新建「会议纪要 · 模板演示」，保存为「会议纪要 · 演示模板」，刷新后恢复文档与模板，再新建「会议纪要 · 模板实例」。实际下载的 4137 字节 Mewoc 文件通过 Schema 校验与重新读取，正文完整保留、读取生成新的文档 ID。浏览器下载事件监听未返回，最终以实际落盘文件核验。没有编辑 4177 端口上的用户文档。本批没有重做 Node 18、Safari 物理鼠标或 Chrome 真实输入法验收。

证据：[结果汇总](m10-document-templates-evidence/checks.json)、[模板专项](m10-document-templates-evidence/browser-templates.json)、[编辑回归](m10-document-templates-evidence/browser-regression.json)、[文档库](m10-document-templates-evidence/browser-library.json)、[历史版本](m10-document-templates-evidence/browser-history.json)、[批注](m10-document-templates-evidence/browser-comments.json)、[导出往返](m10-document-templates-evidence/export-roundtrip.json)、[自定义模板截图](m10-document-templates-evidence/templates-custom.jpg)、[新建文档截图](m10-document-templates-evidence/template-created.jpg)。

## 实现入口

- [内置模板与去批注](../src/pages/editor/tools/document-templates.js)、[模板仓库](../src/pages/editor/tools/document-template-repository.js)
- [模板界面](../src/pages/editor/components/DocumentTemplatesAction.jsx)、[会话接入](../src/pages/editor/components/FileActions.jsx)
- [浏览器专项](../tests/document-template-checks.jsx)

上一批见[本地批注](m9-comments.md)。
