// Canned RSS feed builders for e2e scenarios. Published dates are deterministic
// and all in early 2026 (before the system clock), so the backend's
// published-clamp (pub > fetchedAt → clamped) never rewrites them and chronIdx
// ordering (published-ascending, see cmd_fetch.go) is fully predictable.

const PUB_BASE = Date.UTC(2026, 0, 1, 0, 0, 0) // 2026-01-01T00:00:00Z
const PUB_STEP_MS = 3600 * 1000 // 1h between items

// RFC1123 pubDate string for item index i (e.g. "Thu, 01 Jan 2026 00:00:00 GMT").
export function pubDate(i: number): string {
   return new Date(PUB_BASE + i * PUB_STEP_MS).toUTCString()
}

// The unix-second `published` value the backend will store for item index i —
// what the frontend should read back in IArticle.p.
export function pubUnix(i: number): number {
   return Math.floor((PUB_BASE + i * PUB_STEP_MS) / 1000)
}

function xmlEscape(s: string): string {
   return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export interface FeedItem {
   title: string
   link: string
   guid?: string
   pubDate?: string
   // Raw HTML/text carried verbatim in a CDATA section (becomes article content).
   content: string
}

function renderItem(it: FeedItem): string {
   const guid = it.guid ?? it.link
   const pub = it.pubDate ? `<pubDate>${it.pubDate}</pubDate>` : ""
   return (
      `<item>` +
      `<title>${xmlEscape(it.title)}</title>` +
      `<link>${xmlEscape(it.link)}</link>` +
      `<guid isPermaLink="false">${xmlEscape(guid)}</guid>` +
      pub +
      `<description><![CDATA[${it.content}]]></description>` +
      `</item>`
   )
}

export function rssFeed(title: string, items: FeedItem[]): string {
   return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<rss version="2.0"><feed>` +
      `<title>${xmlEscape(title)}</title>` +
      `<link>http://example.com</link>` +
      `<description>${xmlEscape(title)} feed</description>` +
      items.map(renderItem).join("") +
      `</feed></rss>`
   )
}

// Deterministic high-entropy alphanumeric string (seeded LCG). Data packs split
// on COMPRESSED size (db_pack.go: data.Len() >= PackSize<<10), so filler must be
// incompressible to force splits under a small --pack-size. Pure [A-Za-z0-9] also
// survives the #sanitize/#minify pipeline unchanged, so content round-trips exactly.
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
function randAlnum(seed: number, n: number): string {
   let s = seed >>> 0
   let out = ""
   for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0
      out += ALNUM[s % 62]
   }
   return out
}
function seedFor(prefix: string, i: number): number {
   let h = 2166136261 >>> 0
   for (const c of prefix) h = ((h ^ c.charCodeAt(0)) * 16777619) >>> 0
   return (h + i * 2654435761) >>> 0
}

// `count` simple items with predictable, distinct titles/links/content. `prefix`
// keeps items unique across feeds. `startIdx` offsets the published-date
// index so two feeds can occupy disjoint, non-overlapping time ranges — that
// makes the global published-ascending order (chronIdx) total and assertable.
// `pad` appends `pad` incompressible chars to force data-pack splits under a
// small --pack-size. Each returned item's published unix is `pubUnix(startIdx + i)`.
export function nItems(count: number, prefix: string, pad = 0, startIdx = 0): FeedItem[] {
   return Array.from({ length: count }, (_, i) => ({
      title: `${prefix} title ${i}`,
      link: `http://example.com/${prefix}/${i}`,
      guid: `${prefix}-${i}`,
      pubDate: pubDate(startIdx + i),
      content: `${prefix} body ${i}` + (pad > 0 ? " " + randAlnum(seedFor(prefix, startIdx + i), pad) : ""),
   }))
}

// An item whose content is hostile HTML — for asserting the #sanitize/#minify
// pipeline strips dangerous nodes before the reader ever sees them.
export const HOSTILE_HTML =
   `<p>safe text</p>` +
   `<script>window.__pwned=1</script>` +
   `<img src=x onerror="window.__pwned=1">` +
   `<style>body{display:none}</style>` +
   `<a href="javascript:alert(1)">click</a>` +
   `<b>bold survives</b>`
