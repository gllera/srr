import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { feedServer, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"

import type * as DataModule from "../../src/js/data"
import type * as NavModule from "../../src/js/nav"

// docs/MULTI-STORE-SPEC.md §12 (contract) — two stores written by the REAL srr
// binary, mounted together, read through the REAL data.ts/nav.ts. Pins the core
// multi-store guarantees: both mounts boot, the chron spaces stay SEPARATE (a
// chron in store A resolves to A's article, never B's), setActive switches the
// active lane, and a FAILED mount leaves the other's lanes intact (MS4).
//
// The peer rides a same-origin sub-path base (http://localhost:3000/peer/) — the
// cheap arrangement §12 names — so one fetch shim routes both by URL prefix.

const HOME_BASE = "http://localhost:3000/"
const PEER_BASE = "http://localhost:3000/peer/"

// Route a request to the home or peer store dir by its URL prefix; return RAW
// gzip bytes (no Content-Encoding — data.ts gunzips via DecompressionStream).
function makeTwoStoreShim(homeDir: string, peerDir: string) {
   const serveFrom = (dir: string, rel: string) => {
      const file = join(dir, rel)
      if (!existsSync(file)) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(readFileSync(file)), { status: 200 })
   }
   return vi.fn(async (input: unknown) => {
      const href =
         typeof input === "string" ? input : ((input as { href?: string; url?: string }).href ?? String(input))
      const path = new URL(href).pathname.replace(/^\/+/, "")
      if (path.startsWith("peer/")) return serveFrom(peerDir, path.slice("peer/".length))
      return serveFrom(homeDir, path)
   })
}

// mountId mirror (mounts.ts FNV-1a-32) so the test knows the peer's mid without
// importing base.ts eagerly here — the value is deterministic from the URL.
function midOf(url: string): string {
   let h = 0x811c9dc5
   const bytes = new TextEncoder().encode(url)
   for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i]
      h = Math.imul(h, 0x01000193) >>> 0
   }
   return "s" + h.toString(16).padStart(8, "0")
}
const PEER_MID = midOf(PEER_BASE)

describe("contract: multi-store mounting", () => {
   let homeFeeds: FeedServer
   let peerFeeds: FeedServer
   let homeDir: string
   let peerDir: string
   let data: typeof DataModule
   let nav: typeof NavModule

   beforeAll(async () => {
      // Home store: 2 feeds. Peer store: 1 DIFFERENT feed, distinct titles.
      homeFeeds = await feedServer({
         "/alpha.xml": rssFeed("Alpha", nItems(3, "alpha", 0, 0)),
         "/beta.xml": rssFeed("Beta", nItems(2, "beta", 0, 10)),
      })
      peerFeeds = await feedServer({ "/gamma.xml": rssFeed("Gamma", nItems(4, "gamma", 0, 20)) })

      homeDir = makeStore()
      await srr(homeDir, "feed", "add", "-t", "Alpha", "-u", `${homeFeeds.url}/alpha.xml`)
      await srr(homeDir, "feed", "add", "-t", "Beta", "-u", `${homeFeeds.url}/beta.xml`)
      await srr(homeDir, "art", "fetch")

      peerDir = makeStore()
      await srr(peerDir, "feed", "add", "-t", "Gamma", "-u", `${peerFeeds.url}/gamma.xml`)
      await srr(peerDir, "art", "fetch")

      // Mount table: home (bare) + the peer at its sub-path base. Written BEFORE
      // the data module is imported, so data.init() adopts it.
      localStorage.clear()
      localStorage.setItem(
         "srr-mounts",
         JSON.stringify([
            { id: "0", url: HOME_BASE, label: "", ord: 0, role: "home", cred: false, added: 0, ts: 0, del: false },
            {
               id: PEER_MID,
               url: PEER_BASE,
               label: "Peer",
               ord: 10,
               role: "peer",
               cred: false,
               added: 1,
               ts: 1,
               del: false,
            },
         ]),
      )

      vi.unstubAllGlobals()
      vi.stubGlobal("fetch", makeTwoStoreShim(homeDir, peerDir))
      vi.resetModules()
      data = (await import("../../src/js/data")) as typeof DataModule
      nav = (await import("../../src/js/nav")) as typeof NavModule
      await data.init()
   })

   afterAll(async () => {
      vi.unstubAllGlobals()
      await homeFeeds.close()
      await peerFeeds.close()
      rmSync(homeDir, { recursive: true, force: true })
      rmSync(peerDir, { recursive: true, force: true })
   })

   it("boots BOTH mounts; home is active", () => {
      const stores = data.mountedStores()
      expect(stores.map((s) => s.mid).sort()).toEqual(["0", PEER_MID].sort())
      expect(data.mountStatus("0").state).toBe("ok")
      expect(data.mountStatus(PEER_MID).state).toBe("ok")
      expect(data.activeStore().mid).toBe("0")
   })

   it("keeps each store's article count separate", () => {
      const home = data.mountStore("0")!
      const peer = data.mountStore(PEER_MID)!
      expect(home.db.total_art).toBe(5) // 3 alpha + 2 beta
      expect(peer.db.total_art).toBe(4) // 4 gamma
   })

   it("setActive switches the active lane + the db mirror; chron 0 resolves to the ACTIVE store's article", async () => {
      // Home chron 0 is an Alpha/Beta article; the peer's chron 0 is a Gamma one.
      data.setActive("0")
      const homeArt = await data.loadArticle(0)
      expect(data.feedTitle(homeArt.f)).toMatch(/Alpha|Beta/)
      expect(data.db.total_art).toBe(5)

      expect(data.setActive(PEER_MID)).toBe(true)
      expect(data.activeStore().mid).toBe(PEER_MID)
      expect(data.db.total_art).toBe(4) // the mirror re-pointed
      const peerArt = await data.loadArticle(0)
      expect(data.feedTitle(peerArt.f)).toBe("Gamma")
      // The SAME chron index resolves to DIFFERENT articles per store — the
      // chron spaces never bleed (MS1).
      expect(homeArt.t).not.toBe(peerArt.t)
      data.setActive("0")
   })

   it("the @<mid> hash grammar round-trips to the peer lane", () => {
      data.setActive(PEER_MID)
      nav.filter.clear()
      // A peer [ALL] emits a bare @<mid> marker; parseHashMount reads it back.
      expect(nav.tokensSuffix()).toBe("!@" + PEER_MID)
      expect(nav.parseHashMount(nav.parseHashTokens("#2!@" + PEER_MID))).toEqual({ mid: PEER_MID, tokens: [] })
      data.setActive("0")
   })
})

// A separate mount: the PEER's origin is unreachable (404 on its db.gz). The
// home store must still boot and be active; the peer degrades to an error state
// (MS4 — one bad mount never blanks the reader).
describe("contract: multi-store — one mount down degrades gracefully", () => {
   let homeFeeds: FeedServer
   let homeDir: string
   let data: typeof DataModule

   beforeAll(async () => {
      homeFeeds = await feedServer({ "/alpha.xml": rssFeed("Alpha", nItems(2, "alpha", 0, 0)) })
      homeDir = makeStore()
      await srr(homeDir, "feed", "add", "-t", "Alpha", "-u", `${homeFeeds.url}/alpha.xml`)
      await srr(homeDir, "art", "fetch")

      localStorage.clear()
      localStorage.setItem(
         "srr-mounts",
         JSON.stringify([
            { id: "0", url: HOME_BASE, label: "", ord: 0, role: "home", cred: false, added: 0, ts: 0, del: false },
            {
               id: PEER_MID,
               url: PEER_BASE,
               label: "Down",
               ord: 10,
               role: "peer",
               cred: false,
               added: 1,
               ts: 1,
               del: false,
            },
         ]),
      )

      // The peer dir does not exist → every peer/* fetch 404s.
      vi.unstubAllGlobals()
      vi.stubGlobal("fetch", makeTwoStoreShim(homeDir, "/nonexistent-peer-store"))
      vi.resetModules()
      data = (await import("../../src/js/data")) as typeof DataModule
      await data.init() // must NOT throw — home booted
   })

   afterAll(async () => {
      vi.unstubAllGlobals()
      await homeFeeds.close()
      rmSync(homeDir, { recursive: true, force: true })
   })

   it("home boots + is active; the peer is in an error state; init did not throw", () => {
      expect(data.activeStore().mid).toBe("0")
      expect(data.mountStatus("0").state).toBe("ok")
      expect(data.mountStatus(PEER_MID).state).toBe("error")
      expect(data.mountStore("0")!.db.total_art).toBe(2)
   })

   it("a peer with no usable db cannot become active", () => {
      expect(data.setActive(PEER_MID)).toBe(false)
      expect(data.activeStore().mid).toBe("0")
   })
})
