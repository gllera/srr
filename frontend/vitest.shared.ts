import { defineConfig } from "vitest/config"

// Shared vitest atoms, single-sourced so the unit + e2e layer configs don't
// copy-paste them. Each layer mergeConfig's its own include/timeouts on top.
const CDN_URL = "http://localhost:3000"

// data.ts/base.ts read SRR_CDN_URL at build time; every layer that loads the
// real data layer needs this define. SRR_VERSION rides along (config.ts's
// version label) with a fixed test value.
export const cdnDefine = { SRR_CDN_URL: JSON.stringify(CDN_URL), SRR_VERSION: JSON.stringify("test") }

// jsdom origin for the layers that fetch same-origin pack bytes (contract,
// stress) so data.ts's URL math resolves against a real origin. Internal — only
// jsdomE2EBase consumes it.
const jsdomLocalhost = { jsdom: { url: `${CDN_URL}/` } }

// Base for the jsdom e2e layers (contract, stress): real data layer over
// same-origin pack bytes. mergeConfig the layer's include/timeouts onto it.
export const jsdomE2EBase = defineConfig({
   define: cdnDefine,
   test: {
      environment: "jsdom",
      environmentOptions: jsdomLocalhost,
   },
})
