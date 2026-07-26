import { execFileSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { makeStore, readDb } from "../harness"
import { mountReader } from "./mount"

// The reader half of the seeded chaos-store driver (TST6 — the writer half is
// backend/chaos_test.go, `make chaos-be`).
//
// Every other suite in this directory reads a CURATED store: a shape somebody
// thought of, three or four articles wide. This one reads a store nobody
// designed — one seeded random walk over the axes where the real bugs live
// (batch size, the pack<->delta seam, per-feed expiration, feed add/remove
// churn with id reuse, the GC keep-window, physical compaction, process
// restarts) — and asserts the reader agrees with the WRITER's own record of
// what it wrote at every chron a reader can reach.
//
// The oracle is the point. The Go driver drops `chaos-oracle.json` beside
// db.gz listing every LIVE chron (feed still subscribed, chron at or above its
// add_idx) with the feed, title, link and published time the script wrote
// there. Comparing the reader against THAT — rather than against the store's
// own idx, which is what the reader already reads — is what makes this a
// writer<->reader check instead of a store-agrees-with-itself one.
//
// Gated: SRR_CHAOS must be set, so `make verify` (which runs the whole contract
// layer) never pays for it. The nightly .github/workflows/chaos.yml does.
//
//   SRR_CHAOS=1 npm run test-contract -- chaos          # a random seed
//   SRR_CHAOS=1 SRR_CHAOS_SEED=8143766251288091 \
//     npm run test-contract -- chaos                    # replay one
//
// The seed is printed by the Go driver (stdio is inherited) and again by every
// assertion message here, so a nightly red replays with one command.

const HERE = dirname(fileURLToPath(import.meta.url)) // frontend/e2e/contract
const BACKEND = resolve(HERE, "../../..", "backend")

// One seed is the right budget here: this layer is not searching the axis space
// (chaos-be does that, with far more seeds per unit of wall clock) — it is
// proving the reader can read whatever that search produced.
const ARTICLES = process.env.SRR_CHAOS_ARTICLES ?? "400"

interface OracleEntry {
   c: number // chronIdx
   f: number // feed id
   t: string // title
   l: string // link
   p: number // published, unix seconds
}

interface Oracle {
   seed: number
   articles: number
   total_art: number
   feeds: Record<string, number> // live entry count per feed id
   live: OracleEntry[]
}

describe.skipIf(!process.env.SRR_CHAOS)("contract: seeded chaos store", () => {
   let dir: string
   let oracle: Oracle
   let reader: Awaited<ReturnType<typeof mountReader>>
   let seed: string

   beforeAll(async () => {
      dir = makeStore()
      // The driver walks its whole assertion set on the Go side too, so a store
      // that reaches this point has already passed inspect --validate, chron
      // permanence and consolidation equivalence — a failure below is the READER
      // disagreeing with a store the writer certified.
      execFileSync("go", ["test", "-run", "TestChaosStore", "-count=1", "-timeout", "1800s", "-v", "."], {
         cwd: BACKEND,
         stdio: "inherit",
         env: {
            ...process.env,
            SRR_CHAOS: "1",
            SRR_CHAOS_SEEDS: "1",
            SRR_CHAOS_ARTICLES: ARTICLES,
            SRR_CHAOS_OUT: dir,
         },
      })
      oracle = JSON.parse(readFileSync(join(dir, "chaos-oracle.json"), "utf8")) as Oracle
      seed = String(oracle.seed)
      reader = await mountReader(dir)
   }, 1_800_000)

   afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
   })

   it("the reader boots on the store the walk produced", () => {
      // Non-vacuity first: a driver that silently wrote nothing would make every
      // assertion below pass by having nothing to check.
      expect(oracle.total_art, `seed ${seed}`).toBe(Number(ARTICLES))
      expect(oracle.live.length, `seed ${seed}: no chron survived the walk`).toBeGreaterThan(0)
      expect(reader.data.db.total_art, `seed ${seed}`).toBe(oracle.total_art)
   })

   it("every live chron resolves to the article the writer wrote there", async () => {
      for (const want of oracle.live) {
         const where = `seed ${seed}, chron ${want.c}`
         expect(await reader.data.getFeedId(want.c), `${where}: getFeedId`).toBe(want.f)
         const got = await reader.data.loadArticle(want.c)
         expect(got.f, `${where}: feed`).toBe(want.f)
         expect(got.t, `${where}: title`).toBe(want.t)
         expect(got.l, `${where}: link`).toBe(want.l)
         expect(got.p, `${where}: published`).toBe(want.p)
      }
   })

   it("published time is chron-ascending across the whole walk", () => {
      // The order contract cmd_fetch.go establishes (articles sorted ascending
      // before storage, one fetched_at per cycle) has to survive every
      // consolidation, expiration and compaction the walk performed.
      for (let i = 1; i < oracle.live.length; i++) {
         const prev = oracle.live[i - 1]
         const cur = oracle.live[i]
         expect(cur.c, `seed ${seed}: oracle chrons out of order`).toBeGreaterThan(prev.c)
         expect(cur.p, `seed ${seed}: chron ${cur.c} publishes before chron ${prev.c}`).toBeGreaterThanOrEqual(prev.p)
      }
   })

   it("reader counting matches the writer's live per-feed totals", () => {
      // countAll's map is feed id -> add_idx: exactly the expiration fence the
      // reader applies, so its answer must equal the oracle's own live census —
      // per feed, and for the [ALL] filter over every live feed at once.
      const feeds = reader.data.db.feeds
      const all = new Map<number, number>()
      for (const [idStr, liveCount] of Object.entries(oracle.feeds)) {
         const id = Number(idStr)
         expect(feeds[id], `seed ${seed}: feed ${id} vanished from the reader`).toBeDefined()
         all.set(id, feeds[id].add_idx)
         expect(reader.data.countAll(new Map([[id, feeds[id].add_idx]])), `seed ${seed}: feed ${id} live count`).toBe(
            liveCount,
         )
      }
      expect(reader.data.countAll(all), `seed ${seed}: [ALL] live count`).toBe(oracle.live.length)
   })

   it("the store's own root agrees with what the reader adopted", () => {
      // db.gz is the ~60-byte pointer; the manifest it names is what carries
      // total_art. A walk whose GC ran at keep=0 sweeps everything the current
      // generation does not name, so this also proves the generation the reader
      // booted on was still fully present when it booted.
      const published = readDb<{ total_art: number }>(dir)
      expect(published.total_art, `seed ${seed}`).toBe(oracle.total_art)
   })
})
