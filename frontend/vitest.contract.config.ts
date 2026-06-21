import { defineConfig, mergeConfig } from "vitest/config"
import { jsdomE2EBase } from "./vitest.shared"

// Contract e2e layer: real srrb output → real data-layer modules, in jsdom.
// Inherits the SRR_CDN_URL define + jsdom origin from jsdomE2EBase.
export default mergeConfig(
   jsdomE2EBase,
   defineConfig({
      test: {
         include: ["e2e/contract/**/*.e2e.test.ts"],
         testTimeout: 60000,
         hookTimeout: 60000,
      },
   }),
)
