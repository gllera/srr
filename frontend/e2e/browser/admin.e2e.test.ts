// The admin page is a static file of the frontend bundle that talks to
// `srr serve` (API-only) on its own origin through a Host-rewriting proxy —
// the production topology in miniature.
import { spawn, type ChildProcess } from "node:child_process"
import { rmSync } from "node:fs"
import { createServer as netServer, type AddressInfo } from "node:net"
import { resolve } from "node:path"
import type { Browser } from "puppeteer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { NO_API_HINT } from "../../src/js/admin/api"
import { rssFeed, nItems } from "../fixtures"
import { feedServer, makeStore, srr, srrBin, type FeedServer } from "../harness"
import { launchBrowser } from "./helpers"
import { startStaticServer, stopStaticServer, type StaticServer } from "../static-serve"

const freePort = () =>
   new Promise<number>((ok) => {
      const s = netServer().listen(0, "127.0.0.1", () => {
         const { port } = s.address() as AddressInfo
         s.close(() => ok(port))
      })
   })

async function waitApi(addr: string): Promise<void> {
   for (let i = 0; i < 100; i++) {
      try {
         const r = await fetch(`http://${addr}/api/overview`)
         if (r.ok) return
      } catch {
         /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100))
   }
   throw new Error(`srr serve never answered on ${addr}`)
}

describe("browser: admin page", () => {
   const appDir = resolve(process.cwd(), "../dist/srrf")
   let browser: Browser
   let store: string
   let feeds: FeedServer
   let serve: ChildProcess
   let withApi: StaticServer
   let noApi: StaticServer

   beforeAll(async () => {
      store = makeStore()
      feeds = await feedServer({ "/admin.xml": rssFeed("Admin E2E Feed", nItems(2, "a")) })
      await srr(store, "feed", "add", "-t", "Admin E2E Feed", "-u", `${feeds.url}/admin.xml`)
      const addr = `127.0.0.1:${await freePort()}`
      serve = spawn(srrBin(), ["-o", store, "serve", "-a", addr], {
         env: { ...process.env, SRR_CONFIG_INLINE: "{}", SRR_ALLOW_PRIVATE_FETCH: "1" },
         stdio: "ignore",
      })
      await waitApi(addr)
      withApi = await startStaticServer({ appDir, packsDir: store, apiTarget: addr })
      noApi = await startStaticServer({ appDir, packsDir: store })
      browser = await launchBrowser()
   })

   afterAll(async () => {
      await browser?.close()
      serve?.kill()
      if (withApi) await stopStaticServer(withApi.server)
      if (noApi) await stopStaticServer(noApi.server)
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("lists the store's feeds through the proxied API", async () => {
      const p = await browser.newPage()
      await p.goto(`${withApi.baseUrl}/admin.html`)
      await p.waitForFunction(() => document.body.textContent?.includes("Admin E2E Feed"), { timeout: 10_000 })
      expect(await p.evaluate(() => document.body.textContent)).not.toContain("needs `srr serve`")
      await p.close()
   })

   it("admin page without an API explains itself", async () => {
      const p = await browser.newPage()
      await p.goto(`${noApi.baseUrl}/admin.html`)
      await p.waitForFunction((hint) => document.body.textContent?.includes(hint), { timeout: 10_000 }, NO_API_HINT)
      await p.close()
   })
})
