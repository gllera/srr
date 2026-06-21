import { defineConfig, mergeConfig } from "vitest/config"
import { jsdomE2EBase } from "./vitest.shared"

// Stress e2e layer: drive the REAL data-layer modules (idx/data/nav/search)
// against a LARGE (>50,000-article, multi-idx-pack, multi-meta-shard) synthetic
// store and measure navigation / filtering / query cost at scale. Heavy by
// design — it generates (or reuses) a ~60k store via the gated Go generator
// (genbig_test.go) — so it runs via `make test-stress`, NOT `make verify`.
//
// Inherits the SRR_CDN_URL define + jsdom origin from jsdomE2EBase; the contract
// fetch shim (e2e/contract/mount.ts) serves the on-disk pack bytes, so the
// request budget the reader incurs is observable.
export default mergeConfig(
   jsdomE2EBase,
   defineConfig({
      test: {
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
   }),
)
