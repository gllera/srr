import { defineConfig } from "vitest/config"

// Isolated config for the gated design-fixture generator. Node env (it shells
// out to srr + runs an in-process feed server), only the generator file, long
// timeout. Excluded from `npm test` because vitest.config.ts excludes e2e/**.
export default defineConfig({
   test: {
      include: ["e2e/fixtures/design-store.gen.test.ts"],
      environment: "node",
      testTimeout: 120_000,
      hookTimeout: 120_000,
   },
})
