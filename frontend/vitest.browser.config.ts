import { defineConfig } from "vitest/config"

// Browser e2e layer: real built bundle driven in headless Chrome (Puppeteer)
// against real srr packs. Heavier than the contract layer — runs via
// `make test-browser` / `make test-e2e`, not in `make verify`. Serialized: all
// scenarios share one same-origin pack server (built into the bundle).
export default defineConfig({
   test: {
      environment: "node",
      include: ["e2e/browser/**/*.e2e.test.ts"],
      globalSetup: ["./e2e/browser/serve.ts"],
      testTimeout: 120000,
      hookTimeout: 180000,
      // Files run serially: all scenarios share one same-origin pack server +
      // packsDir (serve.ts), so concurrent test files would clobber each other's
      // packs. Not a RAM constraint — keep this even with ample memory.
      fileParallelism: false,
   },
})
