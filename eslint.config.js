import react from "eslint-plugin-react"
import hooks from "eslint-plugin-react-hooks"
import globals from "globals"

export default [
  { ignores: ["node_modules/**", "dist/**"] },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { react, "react-hooks": hooks },
    settings: { react: { version: "17.0" } },
    rules: {
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
      "react/jsx-uses-vars": "error",
      "react/jsx-key": "error",
      "react/jsx-no-duplicate-props": "error"
    }
  }
]
