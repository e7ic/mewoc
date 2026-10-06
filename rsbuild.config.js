/**
 * 应用与开发验收页面的构建入口；开发、预览和生产共用浏览器目标与 Sass 实现。
 * command 决定是否增加测试入口，生产分发只包含正文编辑器。
 */
import { defineConfig } from "@rsbuild/core"
import { pluginReact } from "@rsbuild/plugin-react"
import { pluginSass } from "@rsbuild/plugin-sass"
import * as sass from "sass"

export default defineConfig(({ command }) => ({
  // React 负责 JSX 转换，Sass 明确使用项目安装版本，避免构建环境选择不同实现。
  plugins: [pluginReact(), pluginSass({ sassLoaderOptions: { implementation: sass } })],
  source: {
    entry: {
      index: "./src/main.jsx",
      // 浏览器验收入口只在开发服务提供，生产构建不包含会创建测试文档的页面。
      ...(command === "dev" && {
        "tests/browser": "./tests/BrowserVerification.jsx",
        "tests/lifecycle": "./tests/LifecycleVerification.jsx",
        "tests/pointer": ["./src/main.jsx", "./tests/pointer-trace.js", "./tests/input-trace.js"]
      })
    }
  },
  output: {
    // 转译目标与项目验收的浏览器能力对齐；运行时依赖仍需满足对应 Web API 要求。
    overrideBrowserslist: ["chrome >= 107", "edge >= 107", "firefox >= 104", "safari >= 16"]
  },
  html: {
    // 主入口使用 index.html，带 tests/ 前缀的开发入口映射到同目录下的专用 HTML。
    template: ({ entryName }) => `./${entryName}.html`
  },
  server: {
    // 默认仅监听本机，端口固定以维持本地 IndexedDB 的访问源；局域网预览可由 CLI 指定。
    host: "127.0.0.1",
    port: 4177,
    // 本地文档按访问源隔离，端口被占用时直接报错，避免自动换端口后误以为文档丢失。
    strictPort: true
  }
}))
