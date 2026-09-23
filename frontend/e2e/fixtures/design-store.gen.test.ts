// design-store.gen.test.ts — GATED generator (not a real test). Builds a small,
// curated srr store that exercises the harness's visual edge cases, then writes
// a design.json sidecar of curated targets design.ts reads. Run via
// `make design-fixture`; excluded from `npm test` (vitest.config.ts only scans
// src/**) and gated on SRR_DESIGN_GEN so an accidental run is a no-op.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync, gunzipSync } from "node:zlib"

import { describe, expect, it } from "vitest"

import { srr, feedServer, inspectValidate, readDb, storeNames } from "../harness"

// Pin the pre-delta tail so the store consolidates into one data pack, which is
// what makes "row index == chronIdx" below true. The pack is ADDRESSED through
// the manifest (storeNames), never by a derived name: this file used to read
// data/L<seq>.gz directly off a `seq` it read from the manifest — a field the
// manifest does not carry — so the fallback made it ask for data/L1.gz, a name
// the writer stopped producing at the cutover, and the generator ENOENT'd on
// every run. There is no computed-name fallback anywhere; ask the manifest.
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

// A real, decodable lead image for the rich article: a 960×540 two-tone
// gradient, encoded by hand (IHDR + one deflated IDAT + IEND) so the fixture
// needs no image dependency. Big enough to exercise the reader's full-width
// image layout and the lightbox; served by the feed server and SELF-HOSTED into
// the store by the feed's #selfhost pipe, so the harness renders it offline.
function gradientPng(w: number, h: number): Buffer {
   const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      return c >>> 0
   })
   const crc = (b: Buffer) => {
      let c = 0xffffffff
      for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
   }
   const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length)
      const td = Buffer.concat([Buffer.from(type, "ascii"), data])
      const c = Buffer.alloc(4)
      c.writeUInt32BE(crc(td))
      return Buffer.concat([len, td, c])
   }
   const ihdr = Buffer.alloc(13)
   ihdr.writeUInt32BE(w, 0)
   ihdr.writeUInt32BE(h, 4)
   ihdr[8] = 8 // bit depth
   ihdr[9] = 2 // truecolor RGB
   const raw = Buffer.alloc((w * 3 + 1) * h)
   for (let y = 0; y < h; y++) {
      const row = y * (w * 3 + 1) // filter byte 0 at row start
      for (let x = 0; x < w; x++) {
         const t = x / w
         const u = y / h
         raw[row + 1 + x * 3] = Math.round(40 + 170 * t)
         raw[row + 2 + x * 3] = Math.round(90 + 80 * u)
         raw[row + 3 + x * 3] = Math.round(150 + 60 * (1 - t))
      }
   }
   return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
   ])
}

const RICH_TITLE = "How a small team rebuilt its reading app around one idea"
const RTL_TITLE = "مستقبل القراءة على الشاشات الصغيرة"

// The article every typography decision should be judged against: running
// prose long enough to scroll, subheads, a captioned figure, a pull quote,
// both list kinds, inline and block code, a table, a rule and outbound links —
// the elements a one-line "News." body never exercised.
function richBody(img: string): string {
   return [
      "<p>For years the reader did one thing well: it showed you the next article. Everything else — search, saved items, offline copies — grew around that single loop, and the loop itself barely changed. This is the story of what happened when the team finally looked at it again.</p>",
      "<p>The first discovery was that most people never opened the settings at all. Features that lived behind a long-press or a two-finger swipe were, for practical purposes, not there. The second was that nobody had judged the typography against a real article in months.</p>",
      `<figure><img src="${img}" width="960" height="540" alt="A blue-to-rose gradient standing in for a photograph"><figcaption>The lead image, self-hosted into the store and resized to the column.</figcaption></figure>`,
      "<h2>Starting from the column</h2>",
      "<p>A reading column is a small set of numbers: the size of the text, the length of a line, and the space between lines. Get those right and almost everything else is decoration. Get them wrong and no amount of decoration saves it.</p>",
      "<blockquote><p>The measure is the thing. Forty-five to seventy-five characters per line, and the eye stops noticing it is reading at all.</p></blockquote>",
      "<p>The team settled on three rules:</p>",
      "<ol><li>Defaults must work for the median reader on the median screen.</li><li>Every preference must preview itself before you commit to it.</li><li>No preference may change where an article starts.</li></ol>",
      "<h3>What they measured</h3>",
      "<ul><li>Time to the first scroll after opening an article.</li><li>How often people zoomed the whole page instead of the text.</li><li>Articles abandoned in the first screenful.</li></ul>",
      "<table><thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead><tbody><tr><td>Text size</td><td>16.8px</td><td>user choice</td></tr><tr><td>Line length</td><td>680px</td><td>580 – 820px</td></tr><tr><td>Line height</td><td>1.65</td><td>1.5 – 1.85</td></tr></tbody></table>",
      "<p>The implementation was deliberately boring. A handful of CSS custom properties carry the choices, and the stylesheet reads them everywhere the column is drawn:</p>",
      "<pre><code>.srr-content {\n  font-size: var(--prose-size);\n  line-height: var(--prose-leading);\n}</code></pre>",
      "<p>Because the properties live on the root element, every surface that lays out prose — including the page that slides in during a swipe — inherits the same values, and a line never breaks in two different places. Inline code such as <code>--column-w</code> stays in the monospace voice.</p>",
      "<hr>",
      '<p>None of this is new. It is <a href="https://example.com/typography">old typographic advice</a>, applied late. The lesson the team wrote down was simpler: look at the real thing, at real length, before deciding anything about it.</p>',
   ].join("")
}

const RTL_BODY =
   "<p>تتغير طريقة القراءة عندما ينتقل النص من الورق إلى الشاشة. يصبح طول السطر وحجم الخط والمسافة بين الأسطر أهم من أي زخرفة.</p>" +
   "<p>هذه المقالة موجودة لاختبار اتجاه النص من اليمين إلى اليسار، وللتأكد من أن القارئ يعلن لغة المقالة الصحيحة بدلاً من وراثة الإنجليزية.</p>"

interface DbCore {
   total_art: number
   feeds: Record<string, { title?: string; ferr?: string }>
}

// Decode the latest data pack (the only one for a tiny store) into ordered
// {f,t} rows. Line position == chron offset within the latest pack, and with a
// single pack the latest starts at chron 0 — so the row index IS the chronIdx.
function readLatestData(dir: string): { f: number; t?: string }[] {
   const names = storeNames(dir)
   const buf = gunzipSync(readFileSync(join(dir, names.data.keys[names.data.tail])))
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
         "/lead.png": { body: gradientPng(960, 540), type: "image/png" },
         "/gone.xml": rss("Soon Deleted", [{ title: "Vanishing source", body: "<p>Gone.</p>", guid: "g1", ageH: 28 }]),
         // /broken.xml resolves validly (empty) at `feed add` time — the backend
         // rejects an unresolvable add — then gets removed below so `srr fetch`
         // 404s and records the ferr.
         "/broken.xml": rss("Broken Feed", []),
      })
      // The long-read feed references the image by the feed server's URL, which
      // is only known once the server is up; #selfhost then copies it into the
      // store's assets/ so the harness never depends on the server again.
      feeds.set(
         "/longreads.xml",
         rss("Long Reads", [
            { title: RICH_TITLE, body: richBody(`${feeds.url}/lead.png`), guid: "l1", ageH: 6 },
            { title: RTL_TITLE, body: RTL_BODY, guid: "l2", ageH: 9 },
         ]),
      )

      try {
         // tech + food share a tag (a multi-feed tag group); news untagged; gone
         // gets removed below; broken 404s → ferr.
         await srr(OUT, "feed", "add", "-t", "Tech Daily", "-g", "topics", "-u", `${feeds.url}/tech.xml`)
         await srr(OUT, "feed", "add", "-t", "World News", "-u", `${feeds.url}/news.xml`)
         await srr(OUT, "feed", "add", "-t", "Cooking Weekly", "-g", "topics", "-u", `${feeds.url}/food.xml`)
         await srr(OUT, "feed", "add", "-t", "Soon Deleted", "-u", `${feeds.url}/gone.xml`)
         await srr(OUT, "feed", "add", "-t", "Broken Feed", "-u", `${feeds.url}/broken.xml`)
         await srr(
            OUT,
            "feed",
            "add",
            "-t",
            "Long Reads",
            "-u",
            `${feeds.url}/longreads.xml`,
            "-p",
            "#default",
            "-p",
            "#selfhost",
         )
         feeds.remove("/broken.xml") // now 404s → srr fetch records the ferr
         await srr(OUT, "fetch")

         // Validate the fully-consistent store BEFORE the deletion (feed rm only
         // edits db.gz; the immutable packs are unchanged after it).
         expect(await inspectValidate(OUT)).toContain("OK: all checks passed")

         const db = readDb<DbCore>(OUT)
         const idByTitle = (t: string) => Object.entries(db.feeds).find(([, f]) => f.title === t)?.[0]
         const ferrToken = Object.entries(db.feeds).find(([, f]) => f.ferr)?.[0]
         const goneId = idByTitle("Soon Deleted")

         const rows = readLatestData(OUT)
         const longTitlePos = rows.findIndex((r) => r.t === LONG_TITLE)
         const savedDeletedChron = goneId != null ? rows.findIndex((r) => r.f === Number(goneId)) : -1
         const richPos = rows.findIndex((r) => r.t === RICH_TITLE)
         const rtlPos = rows.findIndex((r) => r.t === RTL_TITLE)

         // Diagnostics (streamed during the gated run) so the derivation is auditable.
         console.log("[design-fixture] feeds:", JSON.stringify(db.feeds))
         console.log(
            "[design-fixture] rows:",
            rows.map((r, i) => `${i}:f${r.f}:${(r.t ?? "").slice(0, 18)}`).join(" | "),
         )
         console.log("[design-fixture] derived:", {
            ferrToken,
            goneId,
            longTitlePos,
            savedDeletedChron,
            richPos,
            rtlPos,
         })

         expect(db.total_art).toBeGreaterThanOrEqual(7)
         expect(ferrToken).toBeTruthy()
         expect(goneId).toBeTruthy()
         expect(longTitlePos).toBeGreaterThanOrEqual(0)
         expect(savedDeletedChron).toBeGreaterThanOrEqual(0)
         expect(richPos).toBeGreaterThanOrEqual(0)
         expect(rtlPos).toBeGreaterThanOrEqual(0)
         // The lead image must actually have been self-hosted — a rich article
         // whose image points back at a dead feed server grounds nothing.
         const rich = JSON.parse(
            gunzipSync(readFileSync(join(OUT, storeNames(OUT).data.keys[storeNames(OUT).data.tail])))
               .toString("utf8")
               .split("\n")[richPos],
         ) as { c: string }
         expect(rich.c).toMatch(/src="assets\/[0-9a-f]{2}\/[0-9a-f]{16}\.png"/)

         // Remove the "gone" feed: its articles stay in the immutable pack (chronIdx
         // is permanent) but feedTitle now tombstones to [DELETED].
         // --force: the feed has stored articles, the guarded irreversible case.
         await srr(OUT, "feed", "rm", goneId!, "--force")

         const targets = { sampleTag: "topics", ferrToken, longTitlePos, savedDeletedChron, richPos, rtlPos }
         writeFileSync(join(OUT, "design.json"), JSON.stringify(targets, null, 2))
         expect(existsSync(join(OUT, "design.json"))).toBe(true)
      } finally {
         await feeds.close()
      }
   })
})
