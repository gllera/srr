import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import prettierConfig from "eslint-config-prettier"

export default tseslint.config(
   { ignores: ["dist/"] },
   eslint.configs.recommended,
   ...tseslint.configs.recommended,
   prettierConfig,
   { rules: { "no-empty": ["error", { allowEmptyCatch: true }], radix: "error" } },
)
