import { defineConfig, configDefaults } from "vitest/config"
import { cdnDefine } from "./vitest.shared"

export default defineConfig({
   define: cdnDefine,
   test: {
      environment: "jsdom",
      // e2e specs (e2e/**/*.e2e.test.ts) match the default test glob; keep the
      // unit run (`npm test`) fast by excluding them. They run via the dedicated
      // contract/browser configs.
      exclude: [...configDefaults.exclude, "e2e/**"],
   },
})
