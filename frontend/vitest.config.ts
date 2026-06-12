import { defineConfig, configDefaults } from "vitest/config"

export default defineConfig({
   define: {
      SRR_CDN_URL: JSON.stringify("http://localhost:3000"),
   },
   test: {
      environment: "jsdom",
      // e2e specs (e2e/**/*.e2e.test.ts) match the default test glob; keep the
      // unit run (`npm test`) fast by excluding them. They run via the dedicated
      // contract/browser configs.
      exclude: [...configDefaults.exclude, "e2e/**"],
   },
})
