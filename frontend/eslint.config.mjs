import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import prettierConfig from "eslint-config-prettier"

export default tseslint.config(
   { ignores: ["dist/"] },
   eslint.configs.recommended,
   ...tseslint.configs.recommended,
   prettierConfig,
   { rules: { "no-empty": ["error", { allowEmptyCatch: true }], radix: "error" } },
   // Node scripts (e.g. e2e/boot-smoke.mjs) run under Node, not the browser, so
   // give them Node globals — the TS parser already turns off no-undef for .ts.
   { files: ["**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly" } } },
)
