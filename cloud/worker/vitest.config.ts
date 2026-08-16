import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"
import { TEST_OIDC, TEST_ROSTER } from "./test/fixture-env"

// ROSTER and the OIDC four are bound here rather than left to the local
// configuration, because they are the operator's in production (.dev.vars /
// wrangler.toml, both gitignored) and the suites must run against a synthetic
// set instead of whatever the machine happens to hold. These bindings OVERRIDE
// the wrangler config's, and they have to be set here rather than in a
// beforeAll — `env` mutations from a test are invisible to the worker
// `SELF.fetch` runs.
//
// SESSION_HMAC_SECRET is a fixed known value so test/helpers.ts can mint a
// session the worker will accept; in production it is a wrangler secret.
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
                  ...TEST_OIDC,
                  ROSTER: JSON.stringify(TEST_ROSTER),
               },
            },
         },
      },
   },
})
