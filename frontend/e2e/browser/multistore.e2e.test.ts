import { createServer, type Server } from "node:http"
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Browser } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { clearDir, launchBrowser, waitList } from "./helpers"

// The multi-store SW test PWA0 explicitly needs (docs/MULTI-STORE-SPEC.md §5.2,
// §12): a store served from a SECOND ORIGIN, with CORS. This is the case
// production runs — the deployed reader's home base (cdn.llera.eu) is
// cross-origin to its shell origin — and the one no test covered, which is why
// the SW-inert-in-production regression (PWA0) was invisible. With the fix, the
// SW routes + caches cross-origin packs of a mounted root; here we assert a
// cross-origin peer pack lands in srr-packs-v4.
//
// The existing e2e serves packs same-origin under /packs/ (that stays the home
// store). This adds a peer on its own port (a distinct origin) with an explicit
// Access-Control-Allow-Origin so its responses are non-opaque and cacheable.

process.env.SRR_MAX_DELTAS = "0" // consolidated tail, like reader.e2e.test.ts

const baseUrl = inject("baseUrl") // the reader origin, e.g. http://127.0.0.1:PORT/
const packsDir = inject("packsDir") // the same-origin HOME store dir (served at /packs/)

const MIME: Record<string, string> = {
   ".gz": "application/octet-stream",
}

// A minimal CORS pack server: serves peerDir at its root, allowing the reader
// origin. Connection:close so close() doesn't stall on Chrome keep-alive sockets.
function startCorsServer(peerDir: string, allowOrigin: string): Promise<{ server: Server; base: string }> {
   const server = createServer((req, res) => {
      res.setHeader("Connection", "close")
      res.setHeader("Access-Control-Allow-Origin", allowOrigin)
      res.setHeader("Access-Control-Expose-Headers", "ETag")
      const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "")
      const file = join(peerDir, normalize(rel).replace(/^(\.\.([/\\]|$))+/, ""))
      if (!file.startsWith(peerDir) || !existsSync(file) || !statSync(file).isFile()) {
         res.statusCode = 404
         res.end("not found")
         return
      }
      res.setHeader("Content-Type", MIME[".gz"] ?? "application/octet-stream")
      createReadStream(file).pipe(res)
   })
   return new Promise((rs) => {
      server.listen(0, "127.0.0.1", () => {
         const port = (server.address() as AddressInfo).port
         rs({ server, base: `http://127.0.0.1:${port}/` })
      })
   })
}

describe("browser: multi-store — SW caches a cross-origin peer (PWA0 fix)", () => {
   let browser: Browser
   let peerFeeds: FeedServer
   let peerServer: Server
   let peerBase = ""
   let peerDir = ""
   let homeFeeds: FeedServer

   beforeAll(async () => {
      // The same-origin HOME store, served at /packs/ by the shared static server.
      clearDir(packsDir)
      homeFeeds = await feedServer({ "/home.xml": rssFeed("Home", nItems(3, "home", 0, 10)) })
      await srr(packsDir, "feed", "add", "-t", "Home", "-u", `${homeFeeds.url}/home.xml`)
      await srr(packsDir, "art", "fetch")

      // The cross-origin PEER store, on its own port + CORS.
      peerDir = mkdtempSync(join(tmpdir(), "srr-e2e-peer-"))
      peerFeeds = await feedServer({ "/gamma.xml": rssFeed("Gamma", nItems(3, "gamma", 0, 0)) })
      await srr(peerDir, "feed", "add", "-t", "Gamma", "-u", `${peerFeeds.url}/gamma.xml`)
      await srr(peerDir, "art", "fetch")
      // Allow the reader origin (strip the trailing slash — an Origin header has none).
      const readerOrigin = new URL(baseUrl).origin
      ;({ server: peerServer, base: peerBase } = await startCorsServer(peerDir, readerOrigin))
      browser = await launchBrowser()
   }, 60000)

   afterAll(async () => {
      await browser?.close()
      peerServer?.closeAllConnections?.()
      await new Promise<void>((rs) => peerServer?.close(() => rs()))
      await peerFeeds?.close()
      await homeFeeds?.close()
      rmSync(peerDir, { recursive: true, force: true })
   })

   it("routes + caches a cross-origin mounted peer's packs (not just the same-origin home)", async () => {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      try {
         // Cold load: the SW registers, activates, claims control.
         await page.goto(baseUrl, { waitUntil: "load" })
         await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20000 })

         // Mount the peer at its cross-origin base. Written before the reload so
         // data.init() adopts it and the page posts it to the (now controlling)
         // SW before the peer's boot fetches.
         await page.evaluate((base: string) => {
            localStorage.setItem(
               "srr-mounts",
               JSON.stringify([
                  { id: "0", url: location.origin + "/packs/", label: "", ord: 0, role: "home", cred: false, ts: 0 },
                  { id: "sPEER0001", url: base, label: "Peer", ord: 10, role: "peer", cred: false, ts: 1 },
               ]),
            )
            localStorage.setItem("srr-unread-only", "0")
         }, peerBase)

         await page.reload({ waitUntil: "load" })
         await waitList(page)

         // The reader booted BOTH stores. The peer's db.gz + packs are
         // cross-origin (peerBase). Wait until the SW has cached at least one
         // object on the peer origin — the PWA0 fix (before it, the SW's
         // origin-equality gate never cached a cross-origin pack).
         const peerOrigin = new URL(peerBase).origin
         await page.waitForFunction(
            async (origin: string) => {
               const packs = await caches.open("srr-packs-v4")
               const keys = await packs.keys()
               return keys.some((r) => new URL(r.url).origin === origin)
            },
            { timeout: 20000 },
            peerOrigin,
         )

         // Confirm concretely: both the home (same-origin) AND the peer
         // (cross-origin) have cached objects — the multi-root routing works.
         const origins = await page.evaluate(async () => {
            const packs = await caches.open("srr-packs-v4")
            const keys = await packs.keys()
            return [...new Set(keys.map((r) => new URL(r.url).origin))]
         })
         expect(origins).toContain(peerOrigin) // the cross-origin peer — the PWA0 fix
         expect(origins).toContain(new URL(baseUrl).origin) // the same-origin home
      } finally {
         await ctx.close()
      }
   }, 60000)
})
