import { defineConfig } from "vitest/config"

// Contract e2e layer: real srrb output → real data-layer modules, in jsdom.
// Same SRR_CDN_URL define as the unit config so data.ts's URL math resolves.
export default defineConfig({
   define: {
      SRR_CDN_URL: JSON.stringify("http://localhost:3000"),
   },
   test: {
      environment: "jsdom",
      environmentOptions: { jsdom: { url: "http://localhost:3000/" } },
      include: ["e2e/contract/**/*.e2e.test.ts"],
      testTimeout: 60000,
      hookTimeout: 60000,
   },
})
