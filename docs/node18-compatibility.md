# Node 18 兼容调整

## 实施前白盒模型

用户要求支持 Node 18+。最低基线为 Node 18.18.0，来自现有 ESLint 9 的运行契约；支持范围沿用 ESLint 的 `^18.18.0 || ^20.9.0 || >=21.1.0`，不把早期 Node 20/21 误计为支持。

- 调整安装与构建链路：pnpm 11 → 10，Rsbuild core 与 React/Sass 插件一起回到兼容的 1.x。KaTeX 使用仍依赖 commander 8 的 0.18.4，不强行覆盖 commander 的不兼容大版本。
- 审计 Sass 插件的传递依赖及跨平台 fallback；在其声明范围内锁定支持 Node 18 的 sass-embedded，防止未来安装解析到要求 Node 20 的版本。
- 测试通过 `--import` 预载 Node 原生 `buffer.File` 与 `crypto.webcrypto`，仅补齐测试进程中缺失的浏览器全局。业务代码、文件 schema、状态流和 UI 生命周期保持现有所有权，不注入浏览器 polyfill。
- 使用官方 Node 18.18.0 临时二进制，不更改系统默认 Node；验证冻结安装、完整测试、lint、构建、开发/预览服务和浏览器回归。检查更高 Node 版本仍可执行脚本。
- Rsbuild 降级会影响打包与 CSS，显式保持现有浏览器编译目标；重点检查 CSS Modules、HTML/打印内联样式与按需公式包。
- 依赖变化后重新生成运行依赖许可清单及构建产物。M5 继续暂缓。

依据：[Rsbuild 版本迁移](https://www.rsbuild.dev/guide/upgrade/v1-to-v2)、[pnpm 10 安装要求](https://pnpm.io/10.x/installation)、[Node 18.18 CLI](https://nodejs.org/download/release/v18.18.0/docs/api/cli.html)。具体包版本和 engines 同时核对 npm 官方元数据。

## 结果

2026-09-08 已完成。最低 Node 18.18.0，pnpm 10.34.5；React/ReactDOM 17.0.2、Tiptap 3.31.3、AntD 5.29.3、Zustand 4.5.7 保持既有版本。

| 依赖 | 原版本 | 当前版本 | 原因 |
| --- | --- | --- | --- |
| pnpm | 11.19.0 | 10.34.5 | 支持 Node 18 执行安装与脚本 |
| @rsbuild/core | 2.2.3 | 1.7.6 | v1 保留 Node 18 支持 |
| @rsbuild/plugin-react | 2.1.0 | 1.4.6 | 与 core v1 的 peer 契约匹配 |
| @rsbuild/plugin-sass | 2.0.1 | 1.5.2 | 与 core v1 匹配，并允许 sass-embedded 1.99 |
| sass-embedded（间接） | 1.104.0 | 1.99.0 | 在插件原 `^1.99.0` 范围内锁定，覆盖全部平台 fallback |
| KaTeX | 0.18.7 | 0.18.4 | 保留 commander 8，避免 commander 15 的 Node 22 要求 |

`.npmrc` 的 auto-install-peers 改为 true，与原锁文件实际设置一致，继续严格 peer 校验；新增 engine-strict，安装遇到不支持的 Node 版本直接报错。pnpm 10 重新生成锁文件后，在干净目录冻结安装通过。Sass override 只针对插件依赖，业务使用的 Sass 1.93.2 保持原版本。

`tests/setup-node.js` 通过 Node 18.18 支持的 `--import` 加载，缺少全局 File/Crypto 时使用 Node 自带实现；Node 20+ 已有全局时保留原对象。仅测试脚本使用该入口，不进入应用或导出文件。浏览器编译目标显式设为 Chrome/Edge 107、Firefox 104、Safari 16 起；这是先前 Rsbuild v2 的主流浏览器最低编译目标，不代表这些最低浏览器已完整验收。Rspack v1 无法直接解析新的 baseline 查询，改用明确版本查询后构建通过。

## 验证

- 官方 Node 18.18.0 macOS arm64 包下载到临时目录并核验 SHA-256，没有切换系统默认 Node。
- Node 18.18.0 + pnpm 10.34.5：依赖安装、`pnpm lint`、46 / 46 `pnpm test`、`pnpm licenses:collect`、`pnpm build` 全部通过。Node 18 对原生 buffer.File 输出 ExperimentalWarning，未屏蔽该提示，不影响测试结果。
- 新建临时目录，仅复制 manifest、锁文件和配置，`pnpm install --frozen-lockfile --offline` 使用已下载内容完成全新安装。再复制源码与测试，在该目录执行 46 / 46 测试和生产构建通过，未借用仓库 node_modules。
- 独立审计锁文件 471 个包，其中 273 个声明 Node engines，均接受 18.18.0；包括 40 个带平台限制条目。Sass 的 unknown fallback 使用 Sass 1.99 / Chokidar 4，没有残留 commander 15 或 Rsbuild 2。
- Node 24.13.1 执行相同测试脚本，46 / 46 通过。Node 20/22 及其他操作系统本轮只核对 engines 契约，未宣称全部实机验收。
- Node 18 启动隔离开发服务 4179，内置浏览器常规回归 38 / 38：涵盖图片、表格、存储、粘贴、公式、HTML/打印内联 SCSS。没有运行 M5 压力验收。
- Node 18 启动生产预览 4180，实际页面可新建、编辑、保存；插入分数/根号公式，预览和正文正常显示，CSS Modules、深色外壳与白纸排版正常。公式继续按需分包，生产包无测试入口。
- 生产包总计约 1885.2 kB（gzip 576.3 kB），公式异步包约 263.6 kB（gzip 76.5 kB）。运行许可清单保持 129 包并更新 KaTeX/Commander 版本；toggle-selection 许可全文缺失项保持记录。

## 范围与取舍

Node 18 已结束上游维护；本次提供工程兼容，未更改系统环境，也不意味着恢复其上游维护。新环境可继续使用 Node 22/24。

KaTeX 0.18.4 不包含后续补丁对特殊字符边界、空行标签的修复，以及 0.18.7 新增的 `\\reflectbox` / `\\mapsfrom` 支持。已有基础公式、分数、矩阵和安全边界测试通过；若后续需要这些新增语法，应同时重新评估渲染器与 Node 基线。参考官方 [0.18.5](https://github.com/KaTeX/KaTeX/releases/tag/v0.18.5)、[0.18.6](https://github.com/KaTeX/KaTeX/releases/tag/v0.18.6)、[0.18.7](https://github.com/KaTeX/KaTeX/releases/tag/v0.18.7) 发布记录。

## 风格与原理审计

本轮配置、测试入口及必要调用链确认风格偏差为零，符合 `$qucm-code-style`，同时执行 `$frontend-code-style` 的白盒与验证规则。两空格、双引号、无分号沿用现有模块；兼容处理集中在测试入口与依赖配置，没有复制业务状态或添加浏览器补丁层。

1. 为什么只改 engines 无法支持 Node 18？engines 只是运行契约，pnpm、构建器及传递依赖仍有自己的 API 与版本边界；必须在兼容图上安装并执行。
2. 为什么 sass-embedded 父包支持 Node 16 仍不足够？其 unknown 平台 fallback 会加载同版本 Sass；Sass 1.100 已要求 Node 20，故需连同 optional 依赖图检查。
3. 为什么测试用 preload 补全 File/Crypto？应用依赖浏览器全局，而 Node 18 只在模块里暴露对应实现；预加载使测试模块执行前就具备 API，且不向浏览器增加第二套实现。
4. 为什么保持显式浏览器目标？构建进程的 Node 版本和产物运行的浏览器版本是不同维度；降级构建器不应顺带改变目标浏览器编译范围。
