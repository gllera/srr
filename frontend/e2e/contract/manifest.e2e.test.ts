import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, readDb, readRoot, srr, storeNames, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// The generation-manifest root over REAL srr bytes (docs/MANIFEST-SPEC.md §4.1,
// §4.5, §8.1): the writer publishes a ~60-byte pointer at db.gz, an immutable
// manifest that LISTS every live object by opaque stem, and a backend-only
// config sidecar — and the reader boots through that indirection to exactly the
// state the store holds.
//
// Every byte here is genuine writer output: the root, the manifest, the name
// lists inside it, and every pack. (An earlier revision of this suite had to
// SYNTHESIZE the pointer root by rewriting db.gz, because no writer emitted the
// shape yet. One does now.)
//
// The store is built to hit the richest layout in one go: cycle 1 runs with
// SRR_MAX_DELTAS=0 so it CONSOLIDATES (real idx/data/meta tail packs), cycle 2
// runs at the delta default so a live segment rides on top — so the fixture
// covers the tail names, the delta chain and the pack↔delta seam together.
//
// DELIBERATE DEVIATION from the independent-case sibling suites (the
// refresh.e2e.test.ts / delta.e2e.test.ts precedent): the `it`s form an ordered
// publish → read → grow sequence, because "the reader observes exactly what the
// writer published" only means something read in that order.

const batch1 = nItems(3, "manifest-a")
const batch2 = nItems(3, "manifest-b", 0, 3)

// Store-relative path of one shim fetch call (mirrors mount.ts's hrefOf).
function calledPaths(fetchMock: { mock: { calls: unknown[][] } }): string[] {
   return fetchMock.mock.calls.map(([input]) => {
      const obj = input as { href?: string; url?: string }
      return new URL(obj.href ?? obj.url ?? String(input)).pathname.replace(/^\/+/, "")
   })
}

describe("contract: generation-manifest root", () => {
   let feeds: FeedServer
   let store: string
   let m = 0

   beforeAll(async () => {
      feeds = await feedServer({ "/a.xml": rssFeed("Manifest", batch1) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Manifest", "-g", "news", "-u", `${feeds.url}/a.xml`)
      // Cycle 1: consolidate, so the store really has tail packs.
      process.env.SRR_MAX_DELTAS = "0"
      await srr(store, "art", "fetch")
      // Cycle 2: the delta default, so a live segment rides on the tail.
      delete process.env.SRR_MAX_DELTAS
      feeds.set("/a.xml", rssFeed("Manifest", [...batch2, ...batch1]))
      await srr(store, "art", "fetch")
   })

   afterAll(async () => {
      await feeds?.close()
      delete process.env.SRR_MAX_DELTAS
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("the root is a pointer and nothing else", () => {
      const root = readRoot(store) as unknown as Record<string, unknown>
      m = (root.m as number) ?? 0
      expect(m).toBeGreaterThan(0)
      expect(Object.keys(root).sort()).toEqual(["m", "t", "v"])
      expect(root.v).toBe(3)
      expect(existsSync(join(store, "manifest", `${m}.gz`))).toBe(true)
      // The operator's configuration lives beside it, never inside it.
      expect(existsSync(join(store, "config.gz"))).toBe(true)
   })

   it("the manifest carries the state and lists every live object by opaque stem", () => {
      const man = readDb<{ total_art: number; na?: number; names: Record<string, unknown> }>(store)
      expect(man.total_art).toBe(6)
      expect(man.na).toBe(3)

      const names = storeNames(store)
      // A consolidated tail PLUS a live delta segment — every name a bare stem.
      for (const list of [names.idx, names.data, names.meta]) {
         expect(list.tail).toBeGreaterThanOrEqual(0)
         const key = list.keys[list.tail]
         expect(key).toMatch(/^(idx|data|meta)\/\d+\.gz$/)
         expect(existsSync(join(store, key))).toBe(true)
      }
      expect(names.deltas).toHaveLength(1)
      expect(names.deltas[0]).toMatch(/^data\/\d+\.gz$/)
      expect(existsSync(join(store, names.deltas[0]))).toBe(true)
      // Not one retired kind letter anywhere in the published names.
      const raw = gunzipSync(readFileSync(join(store, "manifest", `${m}.gz`))).toString()
      expect(raw).not.toMatch(/\/L\d|\/d\d|\/h\d|\/s\d/)
      // The per-series stem counters ride along (invariant M3).
      expect((man.names.next as Record<string, number>).data).toBeGreaterThan(0)
   })

   it("srr inspect --validate passes on the published store", async () => {
      await expect(inspectValidate(store)).resolves.toContain("OK: all checks passed")
   })

   it("boots through the indirection: root, manifest, then only what it needs", async () => {
      const reader = await mountReader(store)
      const boot = calledPaths(reader.fetchMock)
      const names = storeNames(store)
      expect(new Set(boot)).toEqual(
         new Set(["db.gz", `manifest/${m}.gz`, names.idx.keys[names.idx.tail], ...names.deltas]),
      )
      expect(boot.indexOf(`manifest/${m}.gz`)).toBe(1) // straight after the root
      // The backend-only sidecar is never fetched by a reader.
      expect(boot.some((p) => p === "config.gz")).toBe(false)

      expect(reader.data.db.total_art).toBe(6)
      expect(reader.data.db.m).toBe(m)
      expect(reader.data.db.fetched_at).toBe(readRoot(store).t) // the root's own `t`
      expect(reader.data.tailCovered()).toBe(3)
      expect(reader.data.deltaArticles()).toHaveLength(3)
      expect(reader.data.metaReady()).toBe(true)
      expect(reader.data.feedTitle(0)).toBe("Manifest")
      expect(reader.data.countAll(new Map([[0, 0]]))).toBe(6)
      expect(reader.reloads).not.toHaveBeenCalled()

      const titles: string[] = []
      for (let chron = 0; chron < 6; chron++) titles.push((await reader.data.loadArticle(chron)).t ?? "")
      expect(titles).toEqual([...batch1, ...batch2].map((i) => i.title))

      const search = await import("../../src/js/search")
      expect((await search.loadHits("manifest-b", 50)).chrons).toEqual([3, 4, 5])
   })

   it("addresses packs through the LISTED names, not derived ones", async () => {
      const reader = await mountReader(store)
      const names = reader.data.storeNames()
      expect(names).toEqual(storeNames(store))
      // A pack-region chron resolves content through the data tail name.
      const before = reader.fetchMock.mock.calls.length
      expect((await reader.data.loadArticle(0)).t).toBe(batch1[0].title)
      expect(calledPaths(reader.fetchMock).slice(before)).toContain(names.data.keys[names.data.tail])
      // A delta-region chron costs nothing — it is resident.
      const after = reader.fetchMock.mock.calls.length
      expect((await reader.data.loadArticle(5)).t).toBe(batch2[2].title)
      expect(reader.fetchMock.mock.calls.length).toBe(after)
   })

   it("the offline pin enumerates exactly the listed names", async () => {
      const reader = await mountReader(store)
      const names = reader.data.storeNames()
      const pins = await reader.data.packNamesForFilter(new Map())
      for (const key of [...names.idx.keys, ...names.data.keys, ...names.meta.keys, ...names.deltas]) {
         if (key) expect(pins, `pin set must name ${key}`).toContain(key)
      }
   })

   it("adopts a newer generation in place", async () => {
      const reader = await mountReader(store)
      expect(await reader.data.refresh()).toBe("unchanged")

      const extra = nItems(2, "manifest-c", 0, 6)
      feeds.set("/a.xml", rssFeed("Manifest", [...extra, ...batch2, ...batch1]))
      await srr(store, "art", "fetch")
      const grown = (readRoot(store).m as number) ?? 0
      expect(grown).toBeGreaterThan(m)

      expect(await reader.data.refresh()).toBe("updated")
      expect(reader.data.db.total_art).toBe(8)
      expect(reader.data.db.m).toBe(grown)
      expect(reader.data.storeNames().deltas).toHaveLength(2)
      expect((await reader.data.loadArticle(7)).t).toBe(extra[1].title)
   })

   it("a root whose manifest is gone fails loudly instead of misreading", async () => {
      const gone = (readRoot(store).m as number) ?? 0
      const path = join(store, "manifest", `${gone}.gz`)
      const saved = readFileSync(path)
      rmSync(path)
      try {
         await expect(mountReader(store)).rejects.toThrow(new RegExp(`manifest/${gone}\\.gz fetch failed: 404`))
      } finally {
         writeFileSync(path, saved)
      }
   })
})
