import { defineConfig } from "@rsbuild/core"
import createConfig from "../rsbuild.config.js"

// 验收仍使用应用同一构建配置；提前编译异步模块，避免多浏览器等待懒编译代理。
// 关闭热更新只冻结验收页面，产品的动态 import 与生产分包策略保持原配置。
export default defineConfig(params => ({
  ...createConfig(params),
  dev: { lazyCompilation: false, hmr: false, liveReload: false },
  server: { host: "127.0.0.1", port: 4182, strictPort: true }
}))
