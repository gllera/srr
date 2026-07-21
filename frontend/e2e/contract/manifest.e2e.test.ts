import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, readDb, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// The S33 reader dual-path over REAL srr bytes (docs/MANIFEST-SPEC.md §8.1):
// the same store must read identically through today's legacy root and through
// the v2 {v, m, t} root the S34 cutover will shrink it to.
//
// ⚠ THE v2 ROOT IS SYNTHESIZED. S34 has not landed, so no writer emits that
// shape yet: `writeManifestRoot` below strips the manifest-sourced fields off
// the db.gz the writer really produced, leaving exactly {v:2, m, t}. Everything
// it points at — manifest/<m>.gz, the name lists inside it, every pack — is
// genuine S32 writer output. Replace the synthesis with a plain second store
// once S34 emits the shape for real.
//
// The store is built to hit the richest layout in one go: cycle 1 runs with
// SRR_MAX_DELTAS=0 so it CONSOLIDATES (real idx/data/meta tail packs), cycle 2
// runs at the delta default so a live segment rides on top — so the fixture
// covers the tail names, the delta chain and the pack↔delta seam together.
//
// DELIBERATE DEVIATION from the independent-case sibling suites (the
// refresh.e2e.test.ts / delta.e2e.test.ts precedent): the `it`s form an ordered
// legacy-root → swap-the-root → grow-the-store sequence, because "the same
// bytes read identically through both roots" only means something when it is
// literally the same store read twice in a row.

const batch1 = nItems(3, "manifest-a")
const batch2 = nItems(3, "manifest-b", 0, 3)

// Store-relative path of one shim fetch call (mirrors mount.ts's hrefOf).
function calledPaths(fetchMock: { mock: { calls: unknown[][] } }): string[] {
   return fetchMock.mock.calls.map(([input]) => {
      const obj = input as { href?: string; url?: string }
      return new URL(obj.href ?? obj.url ?? String(input)).pathname.replace(/^\/+/, "")
   })
}

interface Root {
   v?: number
   m?: number
   t?: number
   fetched_at?: number
   total_art?: number
}

// The last legacy db.gz bytes the writer produced. The S32 BINARY still
// refuses to open a v2 root (dbFormatVersion is 1 until S34), so any further
// `srr` invocation has to run against the real root — restore, fetch,
// re-synthesize.
let legacyRootBytes: Buffer | null = null

// Rewrite db.gz as the v2 pointer the S34 cutover emits: the version, the
// manifest number the writer already publishes, and the root copy of
// fetched_at. Nothing else — every manifest-sourced field is deliberately
// dropped, which is exactly what makes the reader take the indirection branch.
function writeManifestRoot(store: string): { m: number; t: number } {
   const path = join(store, "db.gz")
   const legacy = readDb<Root>(store)
   const m = legacy.m ?? 0
   const t = legacy.fetched_at ?? 0
   expect(m).toBeGreaterThan(0) // the S32 writer must have published one
   legacyRootBytes = readFileSync(path)
   writeFileSync(path, gzipSync(JSON.stringify({ v: 2, m, t })))
   return { m, t }
}

function restoreLegacyRoot(store: string): void {
   if (legacyRootBytes) writeFileSync(join(store, "db.gz"), legacyRootBytes)
   legacyRootBytes = null
}

describe("contract: generation-manifest root", () => {
   let feeds: FeedServer
   let store: string
   let m = 0

   beforeAll(async () => {
      feeds = await feedServer({ "/a.xml": rssFeed("Manifest", batch1) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Manifest", "-g", "news", "-u", `${feeds.url}/a.xml`)
      // Cycle 1: consolidate, so the store really has L<tailGen> tail packs.
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

   it("the writer dual-writes a manifest beside an unchanged legacy root", () => {
      const legacy = readDb<Root & { seq?: number; nd?: number; na?: number }>(store)
      m = legacy.m ?? 0
      expect(m).toBeGreaterThan(0)
      expect(existsSync(join(store, "manifest", `${m}.gz`))).toBe(true)
      // Still v1 with the full field set — S34 is what shrinks it.
      expect(legacy.v).toBe(1)
      expect(legacy.total_art).toBe(6)
      // The layout under test: a consolidated tail PLUS a live delta segment.
      expect(existsSync(join(store, "idx", "L1.gz"))).toBe(true)
      expect(existsSync(join(store, "data", "L1.gz"))).toBe(true)
      expect(existsSync(join(store, "meta", "L1.gz"))).toBe(true)
      expect(existsSync(join(store, "data", "d2.gz"))).toBe(true)
      expect(legacy.na).toBe(3)
   })

   it("the manifest lists exactly the names the legacy root derives", () => {
      const man = JSON.parse(gunzipSync(readFileSync(join(store, "manifest", `${m}.gz`))).toString()) as {
         names: Record<string, unknown>
      }
      expect(man.names).toMatchObject({
         idx: { t: "idx/L1.gz" },
         data: { b: 1, t: "data/L1.gz" },
         meta: { t: "meta/L1.gz" },
         deltas: ["data/d2.gz"],
      })
   })

   it("srr inspect --validate passes on the dual-written store", async () => {
      await expect(inspectValidate(store)).resolves.toBeTruthy()
   })

   // --- the two root shapes, read back by the REAL reader ------------------

   // Everything a reader observes about the store, gathered the same way from
   // whichever root it booted through.
   async function readEverything(reader: Awaited<ReturnType<typeof mountReader>>) {
      const titles: string[] = []
      const cards: string[] = []
      for (let chron = 0; chron < 6; chron++) {
         titles.push((await reader.data.loadArticle(chron)).t ?? "")
         cards.push((await reader.data.loadMeta(chron)).t ?? "")
      }
      const search = await import("../../src/js/search")
      const hits = await search.loadHits("manifest-b", 50)
      return {
         total: reader.data.db.total_art,
         fetchedAt: reader.data.db.fetched_at,
         tailCovered: reader.data.tailCovered(),
         deltas: reader.data.deltaArticles().length,
         metaReady: reader.data.metaReady(),
         feedTitle: reader.data.feedTitle(0),
         count: reader.data.countAll(new Map([[0, 0]])),
         names: reader.data.storeNames(),
         pins: (await reader.data.packNamesForFilter(new Map([[0, 0]]))).sort(),
         allPins: (await reader.data.packNamesForFilter(new Map())).sort(),
         titles,
         cards,
         hits: hits.chrons,
      }
   }

   let viaLegacy: Awaited<ReturnType<typeof readEverything>>

   it("reads the store through the legacy root (today's path, unchanged)", async () => {
      const reader = await mountReader(store)
      const boot = new Set(calledPaths(reader.fetchMock))
      // No manifest fetch: a legacy-complete root answers every question
      // itself, so S32's "delete every manifest/*" rollback costs nothing.
      expect([...boot].some((p) => p.startsWith("manifest/"))).toBe(false)
      expect(boot).toEqual(new Set(["db.gz", "idx/L1.gz", "data/d2.gz"]))
      viaLegacy = await readEverything(reader)
      expect(viaLegacy.titles).toEqual([...batch1, ...batch2].map((i) => i.title))
      expect(viaLegacy.total).toBe(6)
      expect(viaLegacy.tailCovered).toBe(3)
      expect(viaLegacy.hits).toEqual([3, 4, 5])
   })

   it("reads the same store through the synthesized v2 manifest root", async () => {
      const { m: rootM, t } = writeManifestRoot(store)
      const reader = await mountReader(store)
      const boot = calledPaths(reader.fetchMock)
      // The one extra hop, and it is the immutable one: everything else is
      // fetched exactly as before.
      expect(new Set(boot)).toEqual(new Set(["db.gz", `manifest/${rootM}.gz`, "idx/L1.gz", "data/d2.gz"]))
      expect(boot.indexOf(`manifest/${rootM}.gz`)).toBe(1) // straight after the root

      const viaManifest = await readEverything(reader)
      expect(viaManifest).toEqual(viaLegacy)
      expect(reader.data.db.fetched_at).toBe(t) // the root's own `t`
      expect(reader.data.db.m).toBe(rootM)
      expect(reader.reloads).not.toHaveBeenCalled()
   })

   it("addresses packs through the LISTED names, not derived ones", async () => {
      const reader = await mountReader(store)
      const names = reader.data.storeNames()
      expect(names.idx.keys[names.idx.tail]).toBe("idx/L1.gz")
      expect(names.data.keys[names.data.tail]).toBe("data/L1.gz")
      expect(names.meta.keys[names.meta.tail]).toBe("meta/L1.gz")
      expect(names.deltas).toEqual(["data/d2.gz"])
      // A pack-region chron resolves content through the data tail name.
      const before = reader.fetchMock.mock.calls.length
      expect((await reader.data.loadArticle(0)).t).toBe(batch1[0].title)
      expect(calledPaths(reader.fetchMock).slice(before)).toContain("data/L1.gz")
      // A delta-region chron costs nothing — it is resident.
      const after = reader.fetchMock.mock.calls.length
      expect((await reader.data.loadArticle(5)).t).toBe(batch2[2].title)
      expect(reader.fetchMock.mock.calls.length).toBe(after)
   })

   it("adopts a newer generation in place from a v2 root", async () => {
      const reader = await mountReader(store)
      expect(await reader.data.refresh()).toBe("unchanged")

      const extra = nItems(2, "manifest-c", 0, 6)
      feeds.set("/a.xml", rssFeed("Manifest", [...extra, ...batch2, ...batch1]))
      restoreLegacyRoot(store)
      await srr(store, "art", "fetch")
      const grown = writeManifestRoot(store)
      expect(grown.m).toBeGreaterThan(m)

      expect(await reader.data.refresh()).toBe("updated")
      expect(reader.data.db.total_art).toBe(8)
      expect(reader.data.db.m).toBe(grown.m)
      expect(reader.data.storeNames().deltas).toEqual(["data/d2.gz", "data/d3.gz"])
      expect((await reader.data.loadArticle(7)).t).toBe(extra[1].title)
   })

   it("a v2 root whose manifest is gone fails loudly instead of misreading", async () => {
      const gone = readDb<Root>(store).m ?? 0
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
