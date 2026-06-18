import { defineConfig } from "vitest/config"

// Opt-in config for the design-state screenshotter (puppeteer). Node env, only
// this file, long timeout (it builds the bundle + drives headless Chrome).
// Excluded from `npm test` because vitest.config.ts only scans src/**.
export default defineConfig({
   test: {
      include: ["e2e/design/shoot.e2e.test.ts"],
      environment: "node",
      testTimeout: 180_000,
      hookTimeout: 180_000,
   },
})
