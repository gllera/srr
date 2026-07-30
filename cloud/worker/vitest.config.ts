import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"
import { TEST_LOGIN_URL, TEST_ROSTER } from "./test/fixture-env"

// The test SESSION_SECRET is a fixed known value so tests can forge tokens
// (test/helpers.ts signs with it; the real secret is a wrangler secret).
//
// ROSTER and LOGIN_URL are bound here for a stricter reason: they are the
// operator's config in production (.dev.vars / wrangler.toml, both gitignored),
// so the suites must run against a synthetic pair instead of whatever the local
// machine happens to hold. These bindings OVERRIDE the wrangler config's, and
// they have to be set here rather than in a beforeAll — `env` mutations from a
// test are invisible to the worker `SELF.fetch` runs.
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
            miniflare: {
               bindings: {
                  SESSION_SECRET: "test-secret",
                  ROSTER: JSON.stringify(TEST_ROSTER),
                  LOGIN_URL: TEST_LOGIN_URL,
               },
            },
         },
      },
   },
})
