import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { inspectValidate, makeStore, srr } from "../harness"
import { mountReader } from "./mount"

// Per-feed article expiration end-to-end: the gated Go generator
// (backend/gen_expire_test.go TestGenExpireStore) writes, through the
// production write path, a store whose first batch is 40 days old — feed 0
// carries exp=30 — then a REAL `srrb art fetch` cycle (both feeds
// unreachable, so zero new articles; per-feed fetch errors are non-fatal and
// the cycle exits 0) runs ExpireArticles and commits. The REAL reader +
// inspector then verify every side of the contract: db.gz add_idx/xp bumps,
// asset deletion, countAll subtracting xp, pack immutability (the expired
// article still loads — ★Saved/deep links keep working), search filtering
// expired hits, and `srr inspect --validate` / `--filter` live-count checks.
//
// Chron layout written by the generator:
//   0 = "ancient exquisite zebra"  (feed 0, exp=30, fetched 40d ago) → expired
//   1 = "keeper ancient story"     (feed 1, no expiration)           → kept
//   2 = "fresh flamingo news"      (feed 0, fetched 1d ago)          → kept

const HERE = dirname(fileURLToPath(import.meta.url)) // frontend/e2e/contract
const BACKEND = resolve(HERE, "../../..", "backend")

const ASSET_EXPIRED = "assets/aa/1111111111111111.webp"
const ASSET_KEPT = "assets/bb/2222222222222222.webp"

type SearchModule = typeof import("../../src/js/search")

interface DBFeedJSON {
   add_idx: number
   xp?: number
   total_art: number
}
interface DBJSON {
   total_art: number
   feeds: Record<string, DBFeedJSON>
}

async function collect(gen: AsyncGenerator<import("../../src/js/search").ISearchHit[]>) {
   const out: import("../../src/js/search").ISearchHit[] = []
   for await (const batch of gen) out.push(...batch)
   return out
}

describe("contract: article expiration", () => {
   let dir: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   let search: SearchModule

   beforeAll(async () => {
      dir = makeStore()
      execFileSync("go", ["test", "-run", "TestGenExpireStore", "-count=1", "."], {
         cwd: BACKEND,
         stdio: "inherit",
         env: { ...process.env, SRR_GENEXPIRE_OUT: dir },
      })
      // The REAL cycle: both feeds fail to fetch (ferr), expiration still
      // runs and commits — runFetch treats per-feed errors as non-fatal.
      await srr(dir, "art", "fetch")
      reader = await mountReader(dir)
      // Same fresh module registry as the mounted data/nav (import order
      // matters — after mountReader's resetModules), so search.ts sees the
      // same data.ts instance and the same fetch shim.
      search = await import("../../src/js/search")
   }, 180_000)

   afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
   })

   it("db.gz carries the add_idx/xp bumps for the expiring feed only", () => {
      const db = JSON.parse(gunzipSync(readFileSync(join(dir, "db.gz"))).toString("utf8")) as DBJSON
      expect(db.total_art).toBe(3) // all-time: packs are immutable
      expect(db.feeds[0].add_idx).toBe(1) // bumped past the expired article
      expect(db.feeds[0].xp).toBe(1)
      expect(db.feeds[0].total_art).toBe(2) // all-time, unchanged
      expect(db.feeds[1].add_idx).toBe(0) // keeper untouched
      expect(db.feeds[1].xp).toBeUndefined()
      expect(db.feeds[1].total_art).toBe(1)
   })

   it("deletes the expired article's assets and keeps live ones", () => {
      expect(existsSync(join(dir, ASSET_EXPIRED)), `${ASSET_EXPIRED} should be deleted`).toBe(false)
      expect(existsSync(join(dir, ASSET_KEPT)), `${ASSET_KEPT} should survive`).toBe(true)
   })

   it("reader counting subtracts expired articles", () => {
      const addIdx = reader.data.db.feeds[0].add_idx
      expect(addIdx).toBe(1)
      // Only the fresh article of the expiring feed is visible.
      expect(reader.data.countAll(new Map([[0, addIdx]]))).toBe(1)
      // Both feeds ([ALL]-shaped map): keeper + flamingo.
      expect(
         reader.data.countAll(
            new Map([
               [0, addIdx],
               [1, reader.data.db.feeds[1].add_idx],
            ]),
         ),
      ).toBe(2)
   })

   it("packs are immutable: the expired article still loads by chron", async () => {
      // Logical deletion only — a ★Saved chron or deep link keeps working.
      expect((await reader.data.loadArticle(0)).t).toBe("ancient exquisite zebra")
      expect((await reader.data.loadArticle(1)).t).toBe("keeper ancient story")
      expect((await reader.data.loadArticle(2)).t).toBe("fresh flamingo news")
   })

   it("search filters expired hits", async () => {
      expect(search.available()).toBe(true) // SyncMeta covered every batch
      expect(await collect(search.search("zebra"))).toEqual([]) // expired → filtered
      expect((await collect(search.search("flamingo"))).map((h) => h.t)).toEqual(["fresh flamingo news"])
      expect((await collect(search.search("keeper"))).map((h) => h.t)).toEqual(["keeper ancient story"])
   })

   it("backend inspect validates the expired store and its live counts", async () => {
      expect(await inspectValidate(dir)).toContain("OK: all checks passed")
      // filterReport hard-errors when idx matches != total_art - expired, so a
      // clean exit (srr() throws on non-zero) closes the live-count contract.
      expect(await srr(dir, "inspect", "--filter", "0")).toContain("matches in idx")
   })
})
