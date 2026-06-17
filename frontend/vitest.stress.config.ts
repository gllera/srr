import { defineConfig } from "vitest/config"

// Stress e2e layer: drive the REAL data-layer modules (idx/data/nav/search)
// against a LARGE (>50,000-article, multi-idx-pack, multi-meta-shard) synthetic
// store and measure navigation / filtering / query cost at scale. Heavy by
// design — it generates (or reuses) a ~60k store via the gated Go generator
// (genbig_test.go) — so it runs via `make test-stress`, NOT `make verify`.
//
// jsdom + the same SRR_CDN_URL define as the unit/contract configs so data.ts's
// URL math resolves; the contract fetch shim (e2e/contract/mount.ts) serves the
// on-disk pack bytes, so the request budget the reader incurs is observable.
export default defineConfig({
   define: {
      SRR_CDN_URL: JSON.stringify("http://localhost:3000"),
   },
   test: {
      environment: "jsdom",
      environmentOptions: { jsdom: { url: "http://localhost:3000/" } },
      include: ["e2e/stress/**/*.stress.test.ts"],
      // This layer's product IS its console output (the PERF table + budgets);
      // let logs pass straight to the terminal instead of being buffered/hidden.
      disableConsoleIntercept: true,
      // Generation of a fresh store (first run / a new SRR_STRESS_N) happens in
      // a beforeAll and can take a while for large N — give the hooks room.
      testTimeout: 180000,
      hookTimeout: 1800000,
      // One shared store fixture; keep files serial so concurrent generation /
      // module-registry resets don't race.
      fileParallelism: false,
   },
})
