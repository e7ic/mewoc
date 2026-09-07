# AntD 表单控件接入

## 实施前模型

2026-09-07。沿用用户指定的 React 17、AntD 5.29.3、Zustand、Rsbuild、JS/JSX，以及 qucm-code-style / frontend-code-style。

- 标题、缩放、视图开关仍由当前文档的 Zustand store 持有；字体和段落格式仍从 Tiptap 选区派生，不复制到组件 state。
- Select 的 onChange 接收值，不沿用原生 event.target.value；字号保留 pt 字符串，标题级别和行距保留数字。混合格式项只展示并禁选，不能把 mixed 写入文档。
- 颜色受控值仍为文档支持的单色字符串，禁用透明度和渐变。ColorPicker onChange 将颜色转为 HEX 后写入当前选区；不调用 focus，避免用户编辑颜色值时焦点跳回正文。
- 标题 Input 保留 100 字符限制和只读禁用；Slider 使用 50–150 整数百分比，更新时除以 100，关闭适应宽度，保留原缩放边界。
- 样式只调整当前 CSS Modules；下拉浮层保留 AntD 默认 body 挂载，避开工具栏横向 overflow 裁剪。已有弹窗的 AntD Input/InputNumber/Radio 和文件选择器继续沿用。
- 没有请求、存储协议或异步生命周期变化。复核目标为选区、键盘、禁用、颜色面板焦点、缩放和保存恢复。

API 依据：[AntD 5 Select](https://5x.ant.design/components/select-cn/)、[ColorPicker](https://5x.ant.design/components/color-picker-cn/)、[Slider](https://5x.ant.design/components/slider-cn/)，并核对已安装版本的 props 定义。ColorPicker 使用 onChange 受控，避免仅用 onChangeComplete 导致拖动时展示颜色不更新。

## 验证

本轮修改及必要调用链确认风格偏差为零，符合 `$qucm-code-style`，同时完成 `$frontend-code-style` 白盒审查。沿用具名组件、就近领域状态、CSS Modules 和现有命令链；没有新增状态层、依赖或公共包装组件。文件输入仍是隐藏的系统选择器入口，不属于页面表单外观控件。

- `pnpm lint`、17/17 Node 测试、`pnpm build` 通过。最终源码中原生 input 仅剩两处隐藏文件选择器，原生 select 已全部替换。
- Chrome 4179 独立文档验证：选中文字“格式选区验证”，选择等宽字体和 14 pt 后，DOM 保留该选区及对应 font-family/font-size；标题 1 与行距 2 写入正确。
- 键盘打开 ColorPicker，在 HEX 输入框填写 c24d57 / d9f7be，焦点保持在颜色输入框，正文分别得到 rgb(194, 77, 87) / rgb(217, 247, 190)。面板正常开关，截图复核控件排列无裁剪。
- 只读时标题、四个格式 Select、两个颜色按钮及原格式按钮禁用。切回编辑后恢复。
- Slider 的 End / Home 分别到 150 / 50，缩小按钮在下界禁用；“实际大小”恢复 100%。视图 Checkbox 切换大纲和查找面板，状态一致。
- 保存最终测试标题“AntD 控件验收”和等宽字体正文 ab，新页面恢复的标题、正文 HTML 与保存前相同。
- 浏览器无应用错误或 AntD 弃用警告；仅有 locatorjs 浏览器扩展自身提示。本轮没有重复 Edge/Safari 原生 IME 验收；此前 M5 的剩余门槛继续保留。
- 构建总量从 1502.7 kB / gzip 465.4 kB 增至 1596.8 kB / gzip 494.1 kB，来自新增使用的 AntD 控件实现，尤其颜色面板；未新增包依赖。

## 原理复核

1. 为什么 Select 的 onChange 不能继续读取 event.target.value？标题级别的数字 0 与 mixed 字符串分别应如何处理？
2. 为什么 ColorPicker 的 onChange 里调用 editor.focus 会影响颜色输入框？不调用 focus 时，编辑器如何仍保存原来的文档选区？
3. 为什么混合格式只是显示状态，不能作为字体名或行距值写进正文？
4. 为什么 Slider 的 50–150 百分比要在边界转换为 0.5–1.5，而不能直接传给页面缩放状态？
5. 为什么 AntD 复选框接入后，需要收窄原来命中所有 span/input 的工具栏样式？
