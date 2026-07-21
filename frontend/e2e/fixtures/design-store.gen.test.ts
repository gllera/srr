// design-store.gen.test.ts — GATED generator (not a real test). Builds a small,
// curated srr store that exercises the harness's visual edge cases, then writes
// a design.json sidecar of curated targets design.ts reads. Run via
// `make design-fixture`; excluded from `npm test` (vitest.config.ts only scans
// src/**) and gated on SRR_DESIGN_GEN so an accidental run is a no-op.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

import { describe, expect, it } from "vitest"

import { srr, feedServer, inspectValidate, readDb } from "../harness"

// Pin the pre-delta tail: readLatestData below reads data/L<seq>.gz directly,
// which an all-delta store (the writer's default since v4.5.0) never writes —
// the fixture generator ENOENT'd on every run from that release until this.
// The six contract suites that pin legacy tail mechanics set the same knob.
process.env.SRR_MAX_DELTAS = "0"

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, "design-store")

const LONG_TITLE =
   "A deliberately very long headline that has to wrap and exercise the toolbar filter-label ellipsis and the reader title layout across multiple lines"

// Items carry a link and a pubDate (ageH hours before generation) — without
// them the reader masthead renders bare (no dateline, no ↗ permalink, no title
// link) and every row lands under one day divider, so design-grounding
// screenshots misrepresent both surfaces.
function rss(title: string, items: { title: string; body: string; guid: string; ageH: number }[]): string {
   const entries = items
      .map(
         (i) =>
            `<item><title>${i.title}</title><guid>${i.guid}</guid>` +
            `<link>https://example.com/${i.guid}</link>` +
            `<pubDate>${new Date(Date.now() - i.ageH * 3600_000).toUTCString()}</pubDate>` +
            `<description><![CDATA[${i.body}]]></description></item>`,
      )
      .join("")
   return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${entries}</channel></rss>`
}

interface DbCore {
   seq?: number
   total_art: number
   feeds: Record<string, { title?: string; ferr?: string }>
}

// Decode the latest data pack (the only one for a tiny store) into ordered
// {f,t} rows. Line position == chron offset within the latest pack, and with a
// single pack the latest starts at chron 0 — so the row index IS the chronIdx.
function readLatestData(dir: string, seq: number): { f: number; t?: string }[] {
   const buf = gunzipSync(readFileSync(join(dir, "data", `L${seq}.gz`)))
   return buf
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { f: number; t?: string })
}

const gen = process.env.SRR_DESIGN_GEN ? it : it.skip

describe("design fixture store", () => {
   gen("generates a curated store + design.json", async () => {
      // Regenerate from scratch — a leftover store from an aborted run would
      // accumulate duplicate feeds/articles and fail inspect --validate.
      rmSync(OUT, { recursive: true, force: true })
      mkdirSync(OUT, { recursive: true })

      const feeds = await feedServer({
         "/tech.xml": rss("Tech Daily", [
            { title: "Compilers are back", body: "<p>Body one.</p>", guid: "t1", ageH: 30 },
            { title: LONG_TITLE, body: "<p>Long.</p>", guid: "t2", ageH: 4 },
         ]),
         "/news.xml": rss("World News", [{ title: "Election results", body: "<p>News.</p>", guid: "n1", ageH: 2 }]),
         "/food.xml": rss("Cooking Weekly", [{ title: "Best bread", body: "<p>Bread.</p>", guid: "f1", ageH: 52 }]),
         "/gone.xml": rss("Soon Deleted", [{ title: "Vanishing source", body: "<p>Gone.</p>", guid: "g1", ageH: 28 }]),
         // /broken.xml resolves validly (empty) at `feed add` time — the backend
         // rejects an unresolvable add — then gets removed below so `art fetch`
         // 404s and records the ferr.
         "/broken.xml": rss("Broken Feed", []),
      })

      try {
         // tech + food share a tag (a multi-feed tag group); news untagged; gone
         // gets removed below; broken 404s → ferr.
         await srr(OUT, "feed", "add", "-t", "Tech Daily", "-g", "topics", "-u", `${feeds.url}/tech.xml`)
         await srr(OUT, "feed", "add", "-t", "World News", "-u", `${feeds.url}/news.xml`)
         await srr(OUT, "feed", "add", "-t", "Cooking Weekly", "-g", "topics", "-u", `${feeds.url}/food.xml`)
         await srr(OUT, "feed", "add", "-t", "Soon Deleted", "-u", `${feeds.url}/gone.xml`)
         await srr(OUT, "feed", "add", "-t", "Broken Feed", "-u", `${feeds.url}/broken.xml`)
         feeds.remove("/broken.xml") // now 404s → art fetch records the ferr
         await srr(OUT, "art", "fetch")

         // Validate the fully-consistent store BEFORE the deletion (feed rm only
         // edits db.gz; the immutable packs are unchanged after it).
         expect(await inspectValidate(OUT)).toContain("OK: all checks passed")

         const db = readDb<DbCore>(OUT)
         const seq = db.seq ?? 1
         const idByTitle = (t: string) => Object.entries(db.feeds).find(([, f]) => f.title === t)?.[0]
         const ferrToken = Object.entries(db.feeds).find(([, f]) => f.ferr)?.[0]
         const goneId = idByTitle("Soon Deleted")

         const rows = readLatestData(OUT, seq)
         const longTitlePos = rows.findIndex((r) => r.t === LONG_TITLE)
         const savedDeletedChron = goneId != null ? rows.findIndex((r) => r.f === Number(goneId)) : -1

         // Diagnostics (streamed during the gated run) so the derivation is auditable.
         console.log("[design-fixture] feeds:", JSON.stringify(db.feeds))
         console.log(
            "[design-fixture] rows:",
            rows.map((r, i) => `${i}:f${r.f}:${(r.t ?? "").slice(0, 18)}`).join(" | "),
         )
         console.log("[design-fixture] derived:", { seq, ferrToken, goneId, longTitlePos, savedDeletedChron })

         expect(db.total_art).toBeGreaterThanOrEqual(5)
         expect(ferrToken).toBeTruthy()
         expect(goneId).toBeTruthy()
         expect(longTitlePos).toBeGreaterThanOrEqual(0)
         expect(savedDeletedChron).toBeGreaterThanOrEqual(0)

         // Remove the "gone" feed: its articles stay in the immutable pack (chronIdx
         // is permanent) but feedTitle now tombstones to [DELETED].
         // --force: the feed has stored articles, the guarded irreversible case.
         await srr(OUT, "feed", "rm", goneId!, "--force")

         const targets = { sampleTag: "topics", ferrToken, longTitlePos, savedDeletedChron }
         writeFileSync(join(OUT, "design.json"), JSON.stringify(targets, null, 2))
         expect(existsSync(join(OUT, "design.json"))).toBe(true)
      } finally {
         await feeds.close()
      }
   })
})
