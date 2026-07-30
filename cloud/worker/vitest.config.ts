import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

// The test SESSION_SECRET is a fixed known value so tests can forge tokens
// (test/helpers.ts signs with it; the real secret is a wrangler secret).
export default defineWorkersConfig({
   test: {
      poolOptions: {
         workers: {
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: { bindings: { SESSION_SECRET: "test-secret" } },
         },
      },
   },
})
