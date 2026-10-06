/** JavaScript/JSX 的统一静态检查：覆盖应用、工具脚本和测试，构建产物与依赖目录除外。 */
import react from "eslint-plugin-react"
import hooks from "eslint-plugin-react-hooks"
import globals from "globals"

export default [
  { ignores: ["node_modules/**", "dist/**"] },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      // 工程同时包含浏览器应用与 Node 验证脚本；均使用 ES Module，React 17 使用 JSX 语法。
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { react, "react-hooks": hooks },
    settings: { react: { version: "17.0" } },
    rules: {
      // Hooks 规则约束调用位置和依赖数组，其他规则检查未定义变量、危险执行与基础一致性。
      ...hooks.configs.recommended.rules,
      "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-var": "error",
      "no-eval": "error",
      "no-console": "error",
      "eqeqeq": "error",
      "prefer-const": "error",
      "semi": ["error", "never"],
      "quotes": ["error", "double", { avoidEscape: true }],
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      // JSX 变量引用参与未使用检查；列表 key 和重复属性检查防止渲染语义错误。
      "react/jsx-uses-vars": "error",
      "react/jsx-key": "error",
      "react/jsx-no-duplicate-props": "error"
    }
  }
]
