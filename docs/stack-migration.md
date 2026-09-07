# Ant Design v5 / Rsbuild 迁移

2026-09-08 更新：为支持 Node 18.18+，构建链现使用 Rsbuild 1.7.6、React 插件 1.4.6、Sass 插件 1.5.2，AntD 仍为 5.29.3。详见 [Node 18 兼容记录](node18-compatibility.md)。以下是先前从 Vite 迁移时的历史记录。

## 实施前白盒审计

- 用户本轮指定 AntD v5、以 Rsbuild 替换 Vite；该要求优先于首期方案与 frontend-code-style 中的 AntD 4 示例。保留 React 17、JS/JSX、Tiptap 3、Zustand 与 pnpm。
- 状态仍由原所有者管理：Tiptap 管正文与选区，实例 Zustand 管纸张/标题/视图，弹窗组件管表单。构建入口与 UI 库迁移不修改文档 schema、IndexedDB 名称、版本或资源键。
- 构建数据流改为显式 source.entry → React/Sass 插件 → HTML 注入脚本与样式。HTML 模板移除源码 script，避免重复挂载。开发态额外注册三张已有验收页，生产态仅注册应用入口。
- AntD v5 按需注入组件样式；入口只引入 reset.css，并让项目 common.scss 在其后。中文与项目主题同时应用到组件树和静态 message / Modal.confirm 的独立容器。
- 四处弹窗的 destroyOnClose 迁为 destroyOnHidden；继续由现有取消处理清空表单、书签与错误。已有异步取消、卸载保护、资源清理和保存失败路径不迁移到新 Provider。
- 没有后端请求契约变化。安装版本必须满足 React 17 peer 约束。启动绑定原 127.0.0.1:4177，端口占用直接失败，避免自动换端口使用户看不到原站点文档。功能验证在独立 4179 源进行。
- 风险集中在 Sass CSS Modules 导出、组件样式优先级、弹窗/下拉/消息、生产脚本注入、开发验收页入口。按 lint、Node 测试、生产构建与真实浏览器回归验证。

## 官方契约

- [Rsbuild 的 Vite 迁移说明](https://rsbuild.dev/guide/migration/vite)：将 HTML 中源码脚本移为 source.entry。
- [Rsbuild React 插件](https://rsbuild.dev/plugins/list/plugin-react)：提供 JSX 自动运行时与开发热更新。
- [Rsbuild HTML 模板](https://rsbuild.dev/config/html/template)：按入口名选择模板并注入构建资源。
- [AntD v4 → v5](https://5x.ant.design/docs/react/migration-v5/)：移除 v4 CSS，引入按需 CSS-in-JS。
- [AntD ConfigProvider](https://5x.ant.design/components/config-provider/)：holderRender 为静态消息/确认框提供主题与中文配置。

## 验证记录

初次回归：lint、17 项 Node 测试、构建通过，Chrome 功能记录 34/34、生命周期计数 30/30。但 Rsbuild 浏览器日志暴露快速卸载时 ResizeObserver 回调读取空 ref；原生命周期计数未捕获全局运行时错误。

修复前补充推演：React 提交卸载先清空 DOM ref，普通 effect 的 disconnect 可能稍后发生。纸张高度和适应宽度的观察回调将测量与状态写入延至下一动画帧；执行前核对 ref 仍指向该 DOM，清理时断开观察并取消帧。这样也避免在 ResizeObserver 的同轮布局通知中再次改变尺寸。生命周期验收在运行期间监听 window error，检查异常后再确认该轮通过，并在 finally 移除监听。

入口组件还发现 AntD v5 的 Spin 不在嵌套/全屏模式时忽略 tip 并报警。按已安装组件源码契约，保留现有居中布局，将提示作为 role=status 中的文本渲染；加载、失败与重试状态仍由 EditorPage 管理。

最终版本：AntD 5.29.3、@ant-design/icons 5.6.1、Rsbuild 2.2.3、React 插件 2.1.0、Sass 插件 2.0.1。Sass 编译器沿用 1.93.2；Rsbuild 依赖要求 Node ^20.19.0 或 >=22.12.0，已同步 engines。严格 peer 检查通过，React/ReactDOM 17.0.2、Tiptap 3.31.3、Zustand 4.5.7 保持原锁定版本。

2026-09-06，在现有 macOS / Chrome / Safari 环境验证：

- pnpm lint、17/17 Node 测试、pnpm build 通过；生产 HTML 正确注入编译后资源，没有源码脚本或验收入口。
- Chrome / Safari 各 34/34 浏览器记录（33 项功能与 1 条计时记录），修复后各 30/30 生命周期检查，未捕获 window error。每轮仍检查对象 URL、尺寸观察器、指定窗口事件释放。
- Chrome 核对纸张、链接、图片说明弹窗的取消/重开：边距恢复为 20，链接为空，图片仍为原说明；非法链接出现校验提示。最近文档列表和导出菜单可用。
- 4178 生产预览通过页面、正文输入、标题保存/刷新恢复、插入表格；静态删除确认框中文正常，取消后保留表格。Chrome 扩展 locatorjs 对 React 17 生产 renderer 的警告来自扩展自身，不是应用依赖。
- 用户原 4177 预览已切换为 Rsbuild 并重新载入。端口严格绑定，不更换站点存储源。
- pnpm licenses:collect 重新生成 127 项运行依赖；产物复制的 THIRD_PARTY_NOTICES 与源文件一致。剩余缺失许可全文为 toggle-selection；array-tree-filter 已退出当前运行依赖图。
- 源码和锁文件中已无 Vite、Rollup、esbuild 构建依赖。文档中的原方案与旧构建结果作为历史记录保留。

本轮未重复原生文件导入、系统打印和三组大型压力测试。真实 IME、Edge 与长期堆内存观察仍按 M5 待办执行，本轮通过不意味着整个 M5 关闭。

风格审计范围为本轮配置、入口、四处弹窗、PaperCanvas 与生命周期验收及必要调用链；沿用既有命名、状态所有者、CSS Modules 与取消处理。AntD 版本选择以用户本轮指令为准；确认风格偏差为零。

## 原理自查

1. 为什么保留 HTML 中的源码 script，同时再配置 source.entry，可能导致加载失败或重复挂载？
2. 为什么组件树外创建的 message / Modal.confirm 需要 holderRender，才能继承中文和主题？
3. destroyOnHidden 销毁弹窗内容后，Form.useForm 持有的字段是否会自动消失？现有 resetFields 在何时起作用？
4. 端口自动递增为什么会改变 IndexedDB 可见的文档，而不仅是更换访问地址？
5. 开发验收入口如何避免进入生产包，为什么仅隐藏入口按钮不能达到同样效果？
6. ResizeObserver 中排入的动画帧为什么仍需核对 ref，并在 effect 清理时同时取消帧与断开观察？
