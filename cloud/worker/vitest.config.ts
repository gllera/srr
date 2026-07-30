import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

// The test SESSION_SECRET is a fixed known value so tests can forge tokens
// (test/helpers.ts signs with it; the real secret is a wrangler secret).
export default defineWorkersConfig({
   test: {
      poolOptions: {
         workers: {
            // Per-test isolated storage is OFF: the worker's post-auth edge
            // cache uses the canonical ctx.waitUntil(cache.put(stream)) shape,
            // and the pool's storage-pop races that in-flight put (known
            // pool-workers isolated-storage issue). The suites are written
            // order-independent instead — every test seeds what it reads.
            isolatedStorage: false,
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: { bindings: { SESSION_SECRET: "test-secret" } },
         },
      },
   },
})
