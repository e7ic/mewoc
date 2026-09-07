import { defineConfig } from "@rsbuild/core"
import { pluginReact } from "@rsbuild/plugin-react"
import { pluginSass } from "@rsbuild/plugin-sass"
import * as sass from "sass"

export default defineConfig(({ command }) => ({
  plugins: [pluginReact(), pluginSass({ sassLoaderOptions: { implementation: sass } })],
  source: {
    entry: {
      index: "./src/main.jsx",
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
    strictPort: true
  }
}))
