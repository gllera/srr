import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, readDb, srr, type FeedServer } from "../harness"
import { pubDate, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// Asset self-hosting end-to-end: a feed-level pipe override adds #selfhost
// (["#default", "#selfhost"] — also exercising the recipe/override resolution
// through the CLI), the REAL fetch downloads the article's remote <img> from
// the feed server, content-hashes it into assets/<2-hex>/<16-hex><ext>, and
// rewrites the content to the RELATIVE key. The real reader then resolves that
// relative ref against PACK_BASE (fmt.ts sanitize path), the resolved URL
// serves the original bytes, and the byte counters (cb/ab) land on the wire.

// 1x1 transparent PNG — real bytes, so the content type / extension are honest.
const PNG = Buffer.from(
   "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
   "base64",
)
// The store key is sha256(file bytes): assets/<hex[0:2]>/<hex[0:16]><ext> —
// stable for given bytes (that's what makes it safe to cache), so the test can
// pin it exactly rather than regex-hunting the content.
const HASH = createHash("sha256").update(PNG).digest("hex")
const KEY = `assets/${HASH.slice(0, 2)}/${HASH.slice(0, 16)}.png`

describe("contract: self-hosted assets round-trip", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>

   beforeAll(async () => {
      feeds = await feedServer({ "/pic.png": { body: PNG, type: "image/png" } })
      feeds.set(
         "/media.xml",
         rssFeed("Media", [
            {
               title: "media title 0",
               link: "http://example.com/media/0",
               guid: "media-0",
               pubDate: pubDate(0),
               content: `<p>hero text</p><img src="${feeds.url}/pic.png">`,
            },
         ]),
      )
      store = makeStore()
      await srr(
         store,
         "feed",
         "add",
         "-t",
         "Media",
         "-u",
         `${feeds.url}/media.xml`,
         "-p",
         "#default",
         "-p",
         "#selfhost",
      )
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("uploads the image under its content-hash key with the original bytes", () => {
      expect(existsSync(join(store, KEY)), `${KEY} should exist`).toBe(true)
      expect(readFileSync(join(store, KEY)).equals(PNG)).toBe(true)
   })

   it("stores the RELATIVE key in the article content", async () => {
      const art = await reader.data.loadArticle(0)
      expect(art.c).toContain(KEY)
      expect(art.c).not.toContain(feeds.url) // the remote URL is gone
      expect(art.c).toContain("hero text")
   })

   it("the reader resolves the relative ref against PACK_BASE and the bytes load", async () => {
      // Same fresh module registry as the mounted data/nav (import after
      // mountReader's resetModules) so fmt/base share the jsdom origin.
      const fmt = await import("../../src/js/fmt")
      const base = await import("../../src/js/base")
      const art = await reader.data.loadArticle(0)

      const resolved = new URL(KEY, base.PACK_BASE).href
      const html = fmt.sanitizeHtml(art.c)
      expect(html).toContain(`src="${resolved}"`) // resolved, in-bounds → kept

      // The resolved URL addresses a real store object (via the fetch shim).
      const res = await fetch(resolved)
      expect(res.status).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
   })

   it("charges the byte counters on the wire", () => {
      const raw = readDb<{ feeds: Record<string, { cb?: number; ab?: number }> }>(store)
      expect(raw.feeds["0"].ab).toBe(PNG.length) // live assets/ footprint
      expect(raw.feeds["0"].cb).toBeGreaterThan(0) // uncompressed JSONL bytes
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
