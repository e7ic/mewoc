import { defineConfig } from "@rsbuild/core"
import { pluginReact } from "@rsbuild/plugin-react"
import { pluginSass } from "@rsbuild/plugin-sass"
import * as sass from "sass"

export default defineConfig(({ command }) => ({
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
    overrideBrowserslist: ["chrome >= 107", "edge >= 107", "firefox >= 104", "safari >= 16"]
  },
  html: {
    template: ({ entryName }) => `./${entryName}.html`
  },
  server: {
    host: "127.0.0.1",
    port: 4177,
    // 本地文档按访问源隔离，端口被占用时直接报错，避免自动换端口后误以为文档丢失。
    strictPort: true
  }
}))
