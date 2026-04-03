import { defineConfig } from "vitest/config"

export default defineConfig({
   define: {
      SRR_CDN_URL: JSON.stringify("http://localhost:3000"),
   },
   test: {
      environment: "jsdom",
   },
})
