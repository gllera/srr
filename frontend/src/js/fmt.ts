import { PACK_BASE } from "./base"
import { IMG_PROXY_KEY } from "./keys"

// Mirror the backend bluemonday allowlist (mailto, http, https) for defense-in-depth.
// data:/vbscript:/javascript:/file: in href or src are XSS or info-leak vectors
// (data:text/html executes script; data:image/svg+xml runs <script> in SVG).
export const URL_DENY = /^\s*(?:javascript|data|vbscript|file)\s*:/i
// SVG/MATH carry their own script + foreign-content surface; bluemonday strips
// them server-side, so mirror that here. CSS selector — querySelectorAll matches
// case-insensitively for HTML and matches SVG/MathML by their normalized names,
// so we don't need a separate case-folding pass.
const DANGEROUS_SELECTOR = "script,style,iframe,embed,object,form,link,meta,base,svg,math"

const HTTP_RE = /^https?:\/\//i
// A reference carrying a URL scheme (http:, mailto:, the URL_DENY set, …) is
// absolute; everything else is a relative reference. ABS_SCHEME detects the
// scheme so isRelative can route relative refs to the pack base below.
const ABS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
// Content URLs are relative to the pack base (where the article was stored), not
// the reader page, so relative refs — the self-hosted "assets/" keys and any
// other relative URL the feed carried — resolve against PACK_BASE (base.ts; the
// same base data.ts addresses packs with) instead of the SPA origin or the
// image proxy.
// Prefix is the URL-encoded-source-appender shape (wsrv.nl, imgproxy, imagor).
// Configured per-user via localStorage `srr-img-proxy`; empty/absent = passthrough.
export function getImgProxy(): string {
   try {
      return localStorage.getItem(IMG_PROXY_KEY) ?? ""
   } catch {
      return ""
   }
}

export function setImgProxy(value: string): void {
   try {
      localStorage.setItem(IMG_PROXY_KEY, value)
   } catch {}
}

// A proxy prefix is concatenated straight before the URL-encoded image URL, so
// the stored value must be an absolute http(s) URL. The scheme is OPTIONAL in the
// UI: normalizeProxy supplies https:// when none is typed. isValidProxy therefore
// accepts the empty string (disables proxying), an explicit http(s):// prefix, or
// a schemeless host/path — and rejects only an explicit non-http(s) scheme
// (ftp://, javascript:, data:, …) that we must not silently rewrite to https.
// setImgProxy stays a dumb setter; the UI validates + normalizes before storing.
export function isValidProxy(v: string): boolean {
   const s = v.trim()
   if (s === "") return true
   if (HTTP_RE.test(s)) return true
   if (URL_DENY.test(s)) return false
   return !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)
}

// normalizeProxy canonicalises a user-entered prefix for storage: trim it, supply
// the default https:// scheme when absent (folding a leading "//host" in too), and
// append "/" when it ends in an alphanumeric char — a bare host or path segment
// needs that boundary before imgProxy() appends the encoded URL, while a value
// already ending in "=", "?", "/", … is a ready join point. Empty → empty
// (disabled). Idempotent: normalizeProxy(normalizeProxy(x)) === normalizeProxy(x).
export function normalizeProxy(v: string): string {
   let s = v.trim()
   if (s === "") return ""
   if (!HTTP_RE.test(s)) s = "https://" + s.replace(/^\/+/, "")
   if (/[a-z0-9]$/i.test(s)) s += "/"
   return s
}

export function imgProxy(url: string, prefix: string): string {
   return prefix ? prefix + encodeURIComponent(url) : url
}

// isRelative reports whether v is a relative reference — one with no URL scheme
// (e.g. "assets/ab/cd.jpg", "/img/x.jpg", "#frag"). A protocol-relative "//host"
// ref counts as relative too: it has no scheme, and resolvePackRelative's bounds
// check then drops it because it resolves to a foreign origin.
function isRelative(v: string): boolean {
   return !ABS_SCHEME.test(v)
}

// resolvePackRelative resolves a relative reference against the pack base, but
// only if the result stays inside that base. Without the bounds check, a crafted
// ref like "../../x" (or "assets/../../x") would traverse off the pack subtree
// onto an arbitrary path on the CDN origin — and "//host/x" onto a foreign one —
// a credentialed-GET info-leak vector. Returns null when the ref escapes, so the
// caller drops the attribute.
function resolvePackRelative(v: string): string | null {
   const resolved = new URL(v, PACK_BASE).href
   return resolved.startsWith(PACK_BASE.href) ? resolved : null
}

// setPackRelative resolves a relative reference and sets it on node[attr],
// dropping the attribute when the ref escapes the pack base (see
// resolvePackRelative).
function setPackRelative(node: Element, attr: string, v: string): void {
   const resolved = resolvePackRelative(v)
   if (resolved) node.setAttribute(attr, resolved)
   else node.removeAttribute(attr)
}

// resolveMediaAttr routes one URL-bearing attribute on a sanitized node: a
// relative reference resolves against the pack base (bounds-checked, dropped if
// it escapes), and — when proxy is set — an external http(s) reference goes
// through the image proxy. Other values (absolute non-http, or already stripped
// by the attribute loop) are left untouched. Centralizes the branch shared by
// <img src>, <video src>, <video poster> and <a href>.
function resolveMediaAttr(node: Element, attr: string, proxyPrefix: string, proxy: boolean): void {
   const v = node.getAttribute(attr)
   if (!v) return
   if (isRelative(v)) setPackRelative(node, attr, v)
   else if (proxy && HTTP_RE.test(v)) node.setAttribute(attr, imgProxy(v, proxyPrefix))
}

// <template> parses HTML without executing scripts, unlike a div
const tmpl = document.createElement("template")

// Fragment form of the sanitizer: the render path adopts the sanitized nodes
// directly (replaceChildren moves them out of the template), skipping the
// serialize→re-parse round-trip the string form forces — on a 300+-image
// article that re-parse costs as much as the whole sanitize pass, on every
// prev/next step. Moving the nodes also empties the template, so it doesn't
// retain the previous article's tree between renders.
export function sanitizeFragment(html: string): DocumentFragment {
   tmpl.innerHTML = html
   // Drop dangerous subtrees first so the attribute pass below never visits
   // their (now-detached) descendants — saves work on e.g. <svg><script>...
   for (const n of tmpl.content.querySelectorAll(DANGEROUS_SELECTOR)) n.remove()
   const walker = document.createTreeWalker(tmpl.content, NodeFilter.SHOW_ELEMENT)
   const proxyPrefix = getImgProxy()
   let node: Element | null
   while ((node = walker.nextNode() as Element | null)) {
      const attrs = node.attributes
      for (let i = attrs.length - 1; i >= 0; i--) {
         const attr = attrs[i]
         if (attr.name === "style" || attr.name === "class" || attr.name.startsWith("on") || URL_DENY.test(attr.value))
            node.removeAttribute(attr.name)
      }
      const tag = node.tagName
      if (tag === "A" || tag === "AREA") {
         node.setAttribute("rel", "noopener noreferrer")
         // Relative hrefs (self-hosted "assets/…/doc.pdf", or any relative link
         // the feed carried) resolve against the pack base, bounds-checked so they
         // can't traverse off it. Absolute hrefs (http(s), mailto:, …) stay as-is:
         // user-initiated navigation, not an auto-loaded resource, so no
         // proxy/IP-leak concern (proxy:false). URL_DENY-matching href was already
         // stripped by the attribute loop above.
         resolveMediaAttr(node, "href", proxyPrefix, false)
      } else if (tag === "IMG") {
         node.removeAttribute("srcset")
         // lazy+async: a long article's images must not compete with first render
         // (or the neighbor prefetch) for bandwidth the user may never need.
         // no-referrer: links already carry rel=noreferrer; without it every image
         // fetch tells the feed host where this reader lives — the same leak the
         // optional proxy exists to prevent, and proxying is off by default.
         // (<video>/<source> take no referrerpolicy attribute, so media stays as-is.)
         node.setAttribute("loading", "lazy")
         node.setAttribute("decoding", "async")
         node.setAttribute("referrerpolicy", "no-referrer")
         // Relative src resolves against the pack base; external http(s) keeps the
         // proxy path (proxy:true) so the user's IP isn't leaked to feed hosts.
         resolveMediaAttr(node, "src", proxyPrefix, true)
      } else if (tag === "VIDEO") {
         // src passes external URLs through (proxy:false — image proxies don't
         // handle video); poster IS an image, so external posters take the proxy
         // path like img.src (leaving them direct would leak the user's IP).
         resolveMediaAttr(node, "src", proxyPrefix, false)
         resolveMediaAttr(node, "poster", proxyPrefix, true)
      } else if (tag === "AUDIO") {
         // A feed <audio> often omits `controls`, which renders the element with
         // no player UI (invisible). Force it — like <img> gets forced lazy/async
         // above — so self-hosted audio is actually playable. src isn't an image:
         // a relative assets/ key resolves against the pack base, an external
         // http(s) src passes through (proxy:false — image proxies don't handle
         // audio), exactly like <video src>.
         node.setAttribute("controls", "")
         resolveMediaAttr(node, "src", proxyPrefix, false)
      } else if (tag === "SOURCE") {
         // srcset is stripped unconditionally: a multi-value descriptor bypasses
         // URL_DENY and the single-src bounds check (same reason <img srcset> is
         // stripped). src gets the same relative/protocol-relative bounds-check
         // as <video src> (proxy:false — image proxies don't handle video).
         node.removeAttribute("srcset")
         resolveMediaAttr(node, "src", proxyPrefix, false)
      }
   }
   return tmpl.content
}

// String form of sanitizeFragment (serializes the sanitized tree back out of
// the template). The tests' round-trip surface; production rendering adopts
// the fragment instead.
export function sanitizeHtml(html: string): string {
   sanitizeFragment(html)
   return tmpl.innerHTML
}

// Articles span years and external images rot — a dead <img> renders as a
// broken-image icon strewn through old content. Collapsing the failed element
// keeps the archive readable. One delegated listener replaces per-element
// handlers, but the error event doesn't bubble: the caller must register this
// on the content container with capture: true. A <video><source> failure
// fires on the <source> child, so the collapse targets its <video> host.
export function collapseBrokenMedia(e: Event): void {
   const t = e.target as Element
   const victim = t.tagName === "SOURCE" ? t.closest("video") : t.tagName === "IMG" || t.tagName === "VIDEO" ? t : null
   victim?.classList.add("srr-broken")
}

// The neighbor-prefetch's media lists (nav.ts schedulePrefetch). Every URL is
// routed exactly as sanitizeHtml's render path routes it (resolveMediaAttr) —
// relative refs resolve against the pack base (dropped when they escape it),
// external http(s) images/posters take the image proxy, video sources pass
// through un-proxied — so a prefetched URL and its rendered element share one
// cache entry; anything else (data:, mailto:, …) is not a warmable fetch and is
// skipped. images = <img src> + <video poster>; videos = <video src>, falling
// back to the first <source> (the one the rendered element would pick). DOM
// parse rather than regex: it runs off the critical path (idle callback),
// template content is inert (nothing loads during the parse), and it natively
// handles the quote-stripped attributes #minify emits. De-duplicated because
// pre-#dedupmedia articles repeat media.
export interface IPrefetchMedia {
   images: string[]
   videos: string[]
}
export function extractPrefetchMedia(html: string): IPrefetchMedia {
   const images = new Set<string>()
   const videos = new Set<string>()
   if (html) {
      tmpl.innerHTML = html
      const proxyPrefix = getImgProxy()
      const add = (set: Set<string>, v: string | null, proxy: boolean) => {
         if (!v) return
         if (isRelative(v)) {
            const resolved = resolvePackRelative(v)
            if (resolved) set.add(resolved)
         } else if (HTTP_RE.test(v)) set.add(proxy ? imgProxy(v, proxyPrefix) : v)
      }
      for (const img of tmpl.content.querySelectorAll("img")) add(images, img.getAttribute("src"), true)
      for (const vid of tmpl.content.querySelectorAll("video")) {
         add(images, vid.getAttribute("poster"), true)
         add(videos, vid.getAttribute("src") ?? vid.querySelector("source")?.getAttribute("src") ?? null, false)
      }
   }
   return { images: [...images], videos: [...videos] }
}

export function timeAgo(unix: number): string {
   const sec = Math.max(0, Math.floor(Date.now() / 1000) - unix)
   if (sec < 60) return `${sec}s`
   if (sec < 3600) return `${Math.floor(sec / 60)}m`
   if (sec < 86400) return `${Math.floor(sec / 3600)}h`
   if (sec < 2592000) return `${Math.floor(sec / 86400)}d`
   if (sec < 31536000) return `${Math.floor(sec / 2592000)}mo`
   return `${Math.floor(sec / 31536000)}y`
}

// Prose form of timeAgo: "just now", "1 minute ago", "2 hours ago", etc.
// Uses the same clock basis as timeAgo so tests can control "now" uniformly.
export function timeAgoProse(unix: number): string {
   const sec = Math.max(0, Math.floor(Date.now() / 1000) - unix)
   if (sec < 60) return "just now"
   const n = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`
   if (sec < 3600) return n(Math.floor(sec / 60), "minute")
   if (sec < 86400) return n(Math.floor(sec / 3600), "hour")
   if (sec < 2592000) return n(Math.floor(sec / 86400), "day")
   if (sec < 31536000) return n(Math.floor(sec / 2592000), "month")
   return n(Math.floor(sec / 31536000), "year")
}

// Crude global freshness threshold: 3 days without a successful backend fetch
// is long enough to suggest the backend may be down.
const STALE_AFTER_SEC = 3 * 86400

// Returns true when the last fetch is old enough to suggest something is wrong.
// A fetched_at of 0 (never fetched / absent) is treated as not-stale: there is
// nothing honest to report yet.
export function isStale(unix: number): boolean {
   if (unix <= 0) return false
   return Math.floor(Date.now() / 1000) - unix >= STALE_AFTER_SEC
}

// Compact article-count readout shared by the config unread badges and the
// reader's next-pill count: exact up to 999, then a flat "999+" — a backlog
// past a thousand reads as "a lot" either way, and the cap bounds the width
// inside chrome that can't grow (the badge column, the toolbar pill).
export function countBadge(n: number): string {
   return n > 999 ? "999+" : String(n)
}

// Human-readable byte size for the info cards' storage rows: decimal units
// (KB = 1000 — the consumer-storage convention), one decimal that drops when
// zero ("1.2 MB", "12 MB"). The counters it renders are approximations by
// design (uncompressed content bytes, cross-feed-shared assets), so binary
// precision would be false precision.
export function formatBytes(n: number): string {
   if (n < 1000) return `${n} B`
   const units = ["KB", "MB", "GB", "TB"]
   let v = n
   let i = 0
   for (v /= 1000; v >= 1000 && i < units.length - 1; i++) v /= 1000
   return `${v.toFixed(1).replace(/\.0$/, "")} ${units[i]}`
}

// The caught-up mark — a plain checkmark, the universal "done". One glyph for
// every scale of "nothing left here": the list's reward state (list.ts) and the
// toolbar readout's zero-unread state (app.ts) render this same string.
export const CHECK_SVG =
   '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const pad2 = (n: number) => n.toString().padStart(2, "0")
export function formatDate(unix: number): string {
   const d = new Date(unix * 1000)
   return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// Number of source-color slots. MUST match the `.srr-row[data-src="N"]` rules in
// styles.css (light + dark). The list gives every feed a stable color from
// this ramp so the feed can be triaged by origin at a glance.
export const SRC_COLORS = 8

// Map a feed id to one of SRC_COLORS palette slots — deterministic and fully
// offline (no favicon is ever fetched, keeping the reader zero-network like the
// rest of the app). Feed ids are handed out sequentially, so a plain modulo
// gives every feed a distinct color until a store exceeds SRC_COLORS feeds;
// the double-modulo keeps a stray negative id in range.
export function srcColorIndex(feedId: number): number {
   return ((feedId % SRC_COLORS) + SRC_COLORS) % SRC_COLORS
}

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

// A coarse day label for the list's time strata: TODAY / YESTERDAY for the near
// edge (how you think when catching up), otherwise weekday + day + month, with
// the year appended only when it isn't the current one. Local time (matches the
// per-row age). Math.round on the local-midnight difference stays correct
// across a DST hour.
export function dayLabel(unix: number): string {
   const d = new Date(unix * 1000)
   const now = new Date()
   const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
   const diff = Math.round((midnight(now) - midnight(d)) / 86400000)
   if (diff === 0) return "TODAY"
   if (diff === 1) return "YESTERDAY"
   const base = `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`
   return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`
}
