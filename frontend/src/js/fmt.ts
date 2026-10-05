import { PACK_BASE } from "./base"
import { IMG_PROXY_KEY } from "./keys"
import { ASSET_KEY_SRC } from "./sw-grammar"
import { HTTP_RE, isValidHttpish, normalizeHttpish, URL_DENY } from "./urlish"

// URL_DENY (imported from its side-effect-free home, urlish.ts) guards only
// URL-BEARING attributes — applying it to every attribute silently strips
// benign text (a title/alt/download that merely starts with a scheme-like
// word). These are the URL attributes that survive on the allowed element set
// below (dangerous elements are removed wholesale first).
const URL_ATTRS = new Set([
   "href",
   "src",
   "poster",
   "srcset",
   "cite",
   "formaction",
   "action",
   "data",
   "longdesc",
   "xlink:href",
])
// URL attributes dropped whatever their value. The browser fetches each one
// against the document base — ping POSTs to every URL it lists when the link is
// followed, background loads an image on render — and in the self-hosted layout
// that base is the origin root the admin API shares. The reader routes neither
// (nothing here resolves them the way resolvePackRelative resolves media), and
// the writer's allowlist keeps neither, so content carrying one skipped #sanitize.
const DROP_ATTRS = new Set(["ping", "background"])
// Absolute <a>/<area> href schemes the backend bluemonday allowlist keeps
// (mailto/http/https + the user-actionable tel/geo/magnet — click-to-call, map,
// torrent); any other absolute scheme (blob:, ftp:, intent:, …) is dropped to
// mirror the writer. Kept in lockstep with sanitize.go's AllowURLSchemes — a
// scheme added/removed here must move there too. javascript:/data:/… are already
// caught by URL_DENY in the attribute loop; a relative href survives only as an
// asset key (resolvePackRelative) or an in-page fragment (FRAGMENT_HREF).
const ANCHOR_ABS_OK = /^(?:https?|mailto|tel|geo|magnet):/i
// A bare-"#" href is an IN-PAGE fragment — a footnote marker, a "back to text"
// return link, a table-of-contents entry. It is the one relative href kept that
// is not an asset key, and it must NOT resolve against the pack base: doing so
// turns it into an absolute CDN URL that <base target="_blank"> then opens in a
// dead new tab, which is how every longform/academic/newsletter article's
// footnotes have been broken. Kept verbatim it names this document, so following
// it requests nothing whatever it spells. Empty "#" counts (the "scroll to top"
// idiom) — it is still same-document.
const FRAGMENT_HREF = /^#/
// The conservative `id` token the reader honours on content elements. Content
// ids exist so fragment links have something to land on, and the writer's
// allowlist (backend/mod/sanitize.go) is kept to the same shape — but the
// reader adds ONE rule the writer cannot: an id may not start with "srr-",
// because that prefix names the reader's own chrome (the dialogs' aria-labelledby
// targets), and a feed that shipped `id="srr-info-title"` would silently
// re-point a dialog's accessible name at article text.
const ID_TOKEN = /^(?!srr-)[A-Za-z][\w:.-]{0,63}$/
// SVG/MATH carry their own script + foreign-content surface; bluemonday strips
// them server-side, so mirror that here. <template> is included because its
// content lives in a DocumentFragment the sanitizer's TreeWalker never descends
// into — removing the element removes that unwalked subtree with it. <track> and
// <input> are the elements left that fetch a src the attribute pass below does
// not route (a caption file, an image button), against the document base — the
// writer strips both too. CSS selector — querySelectorAll matches
// case-insensitively for HTML and matches SVG/MathML by their normalized names,
// so we don't need a separate case-folding pass.
const DANGEROUS_SELECTOR = "script,style,iframe,embed,object,form,link,meta,base,svg,math,template,track,input"

// A reference carrying a URL scheme (http:, mailto:, the URL_DENY set, …) is
// absolute; everything else is a relative reference. ABS_SCHEME detects the
// scheme so isRelative can route relative refs to the pack base below.
const ABS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
// Content URLs are relative to the pack base (where the article was stored), not
// the reader page, so a relative ref resolves against PACK_BASE (base.ts; the
// same base data.ts addresses packs with) instead of the SPA origin or the image
// proxy — and only when it is this: the store-relative content-hash asset key,
// exactly as the writer emits it into article content (backend assets.go
// contentHashKey). Anchored at both ends, it is the whole of what may resolve
// against a store base (resolvePackRelative) and of what can be pinned
// (extractAssetKeys) — an external URL that merely CONTAINS such a path is not a
// key of this store. Case-insensitive like the service worker's RE_ASSET: the
// writer's grammar allows an upper-case extension, and no spelling this admits
// can leave base/assets/.
const ASSET_KEY = new RegExp(`^${ASSET_KEY_SRC}$`, "i")

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
// the stored value must be an absolute http(s) URL — the shared urlish rules
// (scheme optional, https default; see urlish.ts), with the trailing "/"
// appended because the value is a prefix imgProxy() joins the encoded URL onto.
// setImgProxy stays a dumb setter; the UI validates + normalizes before storing.
export function isValidProxy(v: string): boolean {
   return isValidHttpish(v)
}

export function normalizeProxy(v: string): string {
   return normalizeHttpish(v, true)
}

export function imgProxy(url: string, prefix: string): string {
   return prefix ? prefix + encodeURIComponent(url) : url
}

// isRelative reports whether v is a relative reference — one with no URL scheme
// (e.g. "assets/ab/cd.jpg", "/img/x.jpg", "#frag"). A protocol-relative "//host"
// ref counts as relative too: it has no scheme, and resolvePackRelative then
// drops it, since it is not an asset key.
export function isRelative(v: string): boolean {
   return !ABS_SCHEME.test(v)
}

// resolvePackRelative resolves a relative reference against the article's store
// base — and only an asset key, matched whole. Anything else returns null, so the
// caller drops the attribute. Staying inside the base is not enough: in the
// self-hosted layout the store base IS the origin root, shared with the admin
// API, so "assets/../api/…" (like "/api/…" or "api/…") normalizes onto a
// same-origin endpoint the browser requests with the session cookie — and the
// neighbour prefetch requests images before the article is even opened. The key
// grammar admits no dot segment, query, fragment or escape, so a key can only
// name an object under base/assets/; and a "//host" or "../" ref cannot leave the
// base at all. Dropping the rest loses no working link: the writer absolutizes a
// feed's own relative refs against the item's link at ingest, so the one store
// object a relative ref in content can mean is an asset. The base is the
// ARTICLE'S OWN store base (threaded from the caller): under multi-store a peer
// article must resolve against its own store, never the home base
// (docs/MULTI-STORE-SPEC.md MS7) — resolving a peer ref against home would let a
// peer address the home origin.
export function resolvePackRelative(v: string, base: URL): string | null {
   if (!ASSET_KEY.test(v)) return null
   const resolved = new URL(v, base).href
   // A store base is a directory; one missing its trailing slash would resolve
   // the key beside it rather than under it, so that is refused, not followed.
   return resolved.startsWith(base.href) ? resolved : null
}

// setPackRelative resolves a relative reference and sets it on node[attr],
// dropping the attribute when the ref is not an asset key (see
// resolvePackRelative). Reports whether it dropped it.
function setPackRelative(node: Element, attr: string, base: URL, v: string): boolean {
   const resolved = resolvePackRelative(v, base)
   if (resolved) node.setAttribute(attr, resolved)
   else node.removeAttribute(attr)
   return !resolved
}

// resolveMediaAttr routes one URL-bearing attribute on a sanitized node: a
// relative reference resolves against the pack base (an asset key only, dropped
// otherwise), and — when proxy is set — an external http(s) reference goes
// through the image proxy. Other values (absolute non-http, or already stripped
// by the attribute loop) are left untouched. Centralizes the branch shared by
// <img src>, <video src>, <video poster>, <audio src> and <source src>. Reports
// whether it dropped a relative ref, so the caller can collapse the element.
function resolveMediaAttr(node: Element, attr: string, base: URL, proxyPrefix: string, proxy: boolean): boolean {
   const v = node.getAttribute(attr)
   if (!v) return false
   if (isRelative(v)) return setPackRelative(node, attr, base, v)
   if (proxy && HTTP_RE.test(v)) node.setAttribute(attr, imgProxy(v, proxyPrefix))
   return false
}

// <template> parses HTML without executing scripts, unlike a div
const tmpl = document.createElement("template")

// Fragment form of the sanitizer: the render path adopts the sanitized nodes
// directly (replaceChildren moves them out of the template), skipping the
// serialize→re-parse round-trip the string form forces — on a 300+-image
// article that re-parse costs as much as the whole sanitize pass, on every
// prev/next step. Moving the nodes also empties the template, so it doesn't
// retain the previous article's tree between renders.
export function sanitizeFragment(html: string, base: URL = PACK_BASE): DocumentFragment {
   tmpl.innerHTML = html
   // Drop dangerous subtrees first so the attribute pass below never visits
   // their (now-detached) descendants — saves work on e.g. <svg><script>...
   for (const n of tmpl.content.querySelectorAll(DANGEROUS_SELECTOR)) n.remove()
   // Demote in-content <h1> to <h2>. The reader's masthead <h1 class="srr-title">
   // is the article's heading; a feed that also opens its body with an <h1>
   // gives assistive tech two competing document titles and a heading outline
   // that starts over mid-page. Visual scale is CSS's job either way, so nothing
   // moves on screen. Done BEFORE the attribute walk (a static NodeList, so
   // replacing as we go is safe) — the copied attributes then get sanitized with
   // everything else, and the TreeWalker never has its current node yanked.
   for (const h1 of tmpl.content.querySelectorAll("h1")) {
      const h2 = document.createElement("h2")
      for (const a of h1.attributes) h2.setAttribute(a.name, a.value)
      h2.replaceChildren(...h1.childNodes)
      h1.replaceWith(h2)
   }
   const walker = document.createTreeWalker(tmpl.content, NodeFilter.SHOW_ELEMENT)
   const proxyPrefix = getImgProxy()
   // Media whose own src was dropped: collapsed after the walk (collapseMedia).
   const dead: Element[] = []
   let node: Element | null
   while ((node = walker.nextNode() as Element | null)) {
      const attrs = node.attributes
      for (let i = attrs.length - 1; i >= 0; i--) {
         const attr = attrs[i]
         if (
            attr.name === "style" ||
            attr.name === "class" ||
            attr.name.startsWith("on") ||
            DROP_ATTRS.has(attr.name) ||
            (attr.name === "id" && !ID_TOKEN.test(attr.value)) ||
            (URL_ATTRS.has(attr.name) && URL_DENY.test(attr.value))
         )
            node.removeAttribute(attr.name)
      }
      const tag = node.tagName
      if (tag === "A" || tag === "AREA") {
         node.setAttribute("rel", "noopener noreferrer")
         // A relative href resolves against the pack base only as an asset key
         // (a self-hosted "assets/…/doc.pdf"); any other relative href is
         // dropped (resolvePackRelative). Absolute hrefs are kept only for the
         // writer's allowlisted schemes (mailto/http/https/tel/geo/magnet — see
         // ANCHOR_ABS_OK); any other absolute scheme (blob:, ftp:, …) is dropped
         // to mirror the backend. URL_DENY href (javascript:/data:/…) was
         // already stripped above.
         const href = node.getAttribute("href")
         if (href) {
            if (FRAGMENT_HREF.test(href)) {
               // Same-document: leave the href verbatim so it keeps meaning
               // "this article", and override <base target="_blank"> — a
               // footnote must not open a new tab. handleFragmentClick does the
               // actual scrolling; this pair is what makes the link honest even
               // before it is clicked (hover URL, middle-click, "open in new
               // tab" all now describe an in-page jump).
               node.setAttribute("target", "_self")
            } else if (isRelative(href)) setPackRelative(node, "href", base, href)
            else if (!ANCHOR_ABS_OK.test(href)) node.removeAttribute("href")
         }
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
         // A relative src resolves against the pack base as an asset key; external
         // http(s) keeps the proxy path (proxy:true) so the user's IP isn't leaked
         // to feed hosts.
         if (resolveMediaAttr(node, "src", base, proxyPrefix, true)) dead.push(node)
      } else if (tag === "VIDEO") {
         // src passes external URLs through (proxy:false — image proxies don't
         // handle video); poster IS an image, so external posters take the proxy
         // path like img.src (leaving them direct would leak the user's IP). A
         // dropped poster only loses the still frame; the video still plays.
         if (resolveMediaAttr(node, "src", base, proxyPrefix, false)) dead.push(node)
         resolveMediaAttr(node, "poster", base, proxyPrefix, true)
         // A feed <video> that omits `controls` renders as a dead frame with no
         // way to play it — the same failure <audio> gets forced controls for.
         // The exception is the GIF idiom (#embed/srr-x emit muted+loop+autoplay
         // video for what used to be a GIF): those are meant to be chrome-less
         // moving images, and bolting a control bar on them would be wrong.
         // playsinline rides along so iOS plays in place instead of taking over
         // the screen the moment the user taps.
         if (!node.hasAttribute("autoplay")) {
            node.setAttribute("controls", "")
            node.setAttribute("playsinline", "")
         }
      } else if (tag === "AUDIO") {
         // A feed <audio> often omits `controls`, which renders the element with
         // no player UI (invisible). Force it — like <img> gets forced lazy/async
         // above — so self-hosted audio is actually playable. src isn't an image:
         // a relative assets/ key resolves against the pack base, an external
         // http(s) src passes through (proxy:false — image proxies don't handle
         // audio), exactly like <video src>.
         node.setAttribute("controls", "")
         if (resolveMediaAttr(node, "src", base, proxyPrefix, false)) dead.push(node)
      } else if (tag === "SOURCE") {
         // srcset is stripped unconditionally: a multi-value descriptor bypasses
         // URL_DENY and the single-src asset-key rule (same reason <img srcset> is
         // stripped). src takes the same relative-ref rule as <video src>
         // (proxy:false — image proxies don't handle video). A <source> left
         // without a src needs no collapse here: the browser's source selection
         // fires `error` at it, which collapseBrokenMedia already answers.
         node.removeAttribute("srcset")
         resolveMediaAttr(node, "src", base, proxyPrefix, false)
      }
   }
   // A media element whose src was dropped has nothing to load, so it never
   // fires the `error` that collapses a dead one — and an archived article's
   // relative figure, which used to resolve onto the store base and 404, would
   // stay a blank box at its width × height with its alt caption lost. It gets
   // the failed load's treatment instead, with no request. After the walk,
   // because the caption is a new sibling the walker would visit and strip.
   for (const m of dead) collapseMedia(m)
   return tmpl.content
}

// String form of sanitizeFragment (serializes the sanitized tree back out of
// the template). The tests' round-trip surface; production rendering adopts
// the fragment instead.
export function sanitizeHtml(html: string, base: URL = PACK_BASE): string {
   sanitizeFragment(html, base)
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
   const victim =
      t.tagName === "SOURCE"
         ? (t.closest("video") ?? t.closest("audio"))
         : t.tagName === "IMG" || t.tagName === "VIDEO" || t.tagName === "AUDIO"
           ? t
           : null
   if (victim) collapseMedia(victim)
}

// The collapse itself, shared with sanitizeFragment, which applies it to media
// whose src it dropped.
function collapseMedia(victim: Element): void {
   victim.classList.add("srr-broken")
   // An <img alt="…"> whose bytes are gone still carries what the picture SAID.
   // Collapsing it discards the only surviving description — worst exactly where
   // it matters most, an old article whose chart or diagram carried the point.
   // Swap in a small caption so the article reads as "a picture was here, of
   // this" instead of silently skipping a paragraph. Media with no alt (and
   // <video>/<audio>, which have no alt at all) keep the plain collapse: an
   // empty alt is the author's own "decorative, ignore me".
   const alt = victim.tagName === "IMG" ? victim.getAttribute("alt")?.trim() : ""
   if (!alt || victim.nextElementSibling?.classList.contains("srr-broken-alt")) return
   const note = document.createElement("p")
   note.className = "srr-broken-alt"
   note.textContent = alt
   victim.after(note)
}

// The in-page half of FRAGMENT_HREF: a delegated click handler the render host
// registers (app.ts, beside collapseBrokenMedia) so footnote round-trips work.
//
// It scrolls rather than navigates, and that is the whole design. The reader
// OWNS location.hash — it is the router (`#pos!tokens`) and the resume-position
// store — so letting a footnote link write "#fn1" into it would fire a
// hashchange that route() reads as a nonsense position. Intercepting keeps the
// jump purely visual: the URL never moves, so back/forward still walk articles
// and a reload still lands where the reader was.
//
// Modified clicks (new tab/window, download) are left to the browser. An
// UNRESOLVABLE fragment is still swallowed, and that is deliberate: "the
// browser's default" for a same-document fragment is not "nothing", it is
// writing location.hash — which is precisely the router write this handler
// exists to prevent. So the preventDefault comes BEFORE the target lookup, and
// a fragment naming nothing simply does nothing (no scroll, no focus move, no
// hash write). The unresolvable case is not exotic: the writer-side `id`
// allowlist (backend/mod/sanitize.go) is newer than most of the archive and
// packs are immutable, so every article written before it has footnote anchors
// with nothing to land on — and a numeric one ("#2") parses as a position.
export function handleFragmentClick(e: MouseEvent): void {
   if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
   const a = (e.target as Element | null)?.closest?.("a[href^='#']") as HTMLAnchorElement | null
   if (!a) return
   const host = e.currentTarget as Element
   if (!host.contains(a)) return
   const raw = a.getAttribute("href")!.slice(1)
   // Browsers match a fragment against the DECODED id; a malformed escape is
   // just taken literally rather than throwing out of a click handler.
   let id = raw
   try {
      id = decodeURIComponent(raw)
   } catch {}
   // A bare "#" is the scroll-to-top idiom; an id is looked up INSIDE the
   // article, never document-wide, so content can't aim at reader chrome. The
   // scan avoids building a selector out of attacker-supplied text entirely (no
   // escaping to get wrong, and an article carries a handful of ids at most).
   const target = id ? ([...host.querySelectorAll("[id]")].find((n) => n.id === id) ?? null) : host
   // Claim the click before deciding whether there is anywhere to go: letting an
   // unresolvable fragment through hands location.hash to the browser, and the
   // reader's own hashchange handler reads that as a route.
   e.preventDefault()
   if (!target) return
   target.scrollIntoView({ block: "start", behavior: "auto" })
   // Move focus too, so a keyboard/screen-reader user actually arrives at the
   // footnote instead of just seeing the page move. tabindex=-1 makes a plain
   // <li>/<p> focusable without entering the tab order.
   const el = target as HTMLElement
   if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1")
   el.focus({ preventScroll: true })
}

// The neighbor-prefetch's media lists (nav.ts schedulePrefetch). Every URL is
// routed exactly as sanitizeHtml's render path routes it (resolveMediaAttr) —
// a relative ref resolves against the pack base only as an asset key (dropped
// otherwise: this list loads before the article is opened),
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
export function extractPrefetchMedia(html: string, base: URL = PACK_BASE): IPrefetchMedia {
   const images = new Set<string>()
   const videos = new Set<string>()
   if (html) {
      tmpl.innerHTML = html
      const proxyPrefix = getImgProxy()
      const add = (set: Set<string>, v: string | null, proxy: boolean) => {
         if (!v) return
         if (isRelative(v)) {
            const resolved = resolvePackRelative(v, base)
            if (resolved) set.add(resolved)
         } else if (HTTP_RE.test(v)) set.add(proxy ? imgProxy(v, proxyPrefix) : v)
      }
      for (const img of tmpl.content.querySelectorAll("img")) add(images, img.getAttribute("src"), true)
      for (const vid of tmpl.content.querySelectorAll("video")) {
         add(images, vid.getAttribute("poster"), true)
         add(videos, vid.getAttribute("src") ?? vid.querySelector("source")?.getAttribute("src") ?? null, false)
      }
      // The neighbour's whole parsed DOM would otherwise sit in the shared
      // template until the next parse — and this runs off an idle callback after
      // every step, over the 300-image articles the prefetch caps exist for.
      tmpl.innerHTML = ""
   }
   return { images: [...images], videos: [...videos] }
}

// The self-hosted asset keys an article references, for the ★-Saved pin path
// (app.ts). Mirrors the backend's own asset attribute set (mod/helper_assets.go
// assetAttrs): media sources, the video poster, and <a href> — a self-hosted PDF
// is as much part of a saved article as its images.
//
// Deliberately the RAW relative values, not extractPrefetchMedia's resolved (and
// possibly proxied) URLs: the service worker resolves names against the store
// base itself, and an image-proxy URL is not a store object at all.
export function extractAssetKeys(html: string): string[] {
   const keys = new Set<string>()
   if (html) {
      tmpl.innerHTML = html
      for (const [sel, attr] of [
         ["img[src]", "src"],
         ["video[src]", "src"],
         ["video[poster]", "poster"],
         ["audio[src]", "src"],
         ["source[src]", "src"],
         ["a[href]", "href"],
      ] as const) {
         for (const n of tmpl.content.querySelectorAll(sel)) {
            const v = n.getAttribute(attr)
            if (v && ASSET_KEY.test(v)) keys.add(v)
         }
      }
      tmpl.innerHTML = ""
   }
   return [...keys]
}

// Seconds since `unix`, never negative. The ONE clock basis every age readout
// shares (timeAgo, timeAgoProse, readerDateline) — the comment on timeAgoProse
// already asked for that ("the same clock basis as timeAgo so tests can control
// 'now' uniformly"); this is it, rather than three copies of the expression.
export function ageSince(unix: number): number {
   return Math.max(0, Math.floor(Date.now() / 1000) - unix)
}

export function timeAgo(unix: number): string {
   const sec = ageSince(unix)
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
   const sec = ageSince(unix)
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
export const STALE_AFTER_SEC = 3 * 86400

// Returns true when the last fetch is old enough to suggest something is wrong.
// A fetched_at of 0 (never fetched / absent) is treated as not-stale: there is
// nothing honest to report yet.
export function isStale(unix: number): boolean {
   if (unix <= 0) return false
   return ageSince(unix) >= STALE_AFTER_SEC
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
   let v = n / 1000
   let i = 0
   // Compare against the ROUNDED value: v=999.95 renders "1000.0" at one decimal,
   // so it must roll up to the next unit rather than print "1000 KB".
   while (Number(v.toFixed(1)) >= 1000 && i < units.length - 1) {
      v /= 1000
      i++
   }
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

// Within a week counts as "close to now".
const RELATIVE_DATELINE_SEC = 7 * 86400

// The reader masthead's dateline. A recent article (fetched/published within the
// last week) leads with its compact relative age — "5h ago", "6d ago", "just now"
// — the way you read something that just arrived; an older one leads with the
// absolute date, since for an archived dispatch the real date matters more than
// "how long ago". Whichever form isn't shown becomes the hover `title`, so both
// are always one glance apart. Compact shares the list eyebrow's age vocabulary.
export function readerDateline(unix: number): { text: string; title: string } {
   const sec = ageSince(unix)
   if (sec < RELATIVE_DATELINE_SEC) {
      return { text: sec < 60 ? "just now" : `${timeAgo(unix)} ago`, title: formatDate(unix) }
   }
   return { text: formatDate(unix), title: timeAgo(unix) }
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
// Paint an element with a feed's source tint. `[data-src]` + srcColorIndex was
// spelled out at nine sites across seven modules, every one of them already
// importing this file.
export function stampSrc(node: HTMLElement, feedId: number): void {
   node.dataset.src = String(srcColorIndex(feedId))
}

export function srcColorIndex(feedId: number): number {
   return ((feedId % SRC_COLORS) + SRC_COLORS) % SRC_COLORS
}

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

// The per-call invariants of the day label (current time + its local midnight),
// hoisted so a bulk pass (list.ts relabelDividers walks every loaded row)
// builds them once instead of twice per row.
export interface DayLabelCtx {
   nowYear: number
   midnightNow: number
}

export function dayLabelCtx(): DayLabelCtx {
   const now = new Date()
   return {
      nowYear: now.getFullYear(),
      midnightNow: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
   }
}

// A coarse day label for the list's time strata: TODAY / YESTERDAY for the near
// edge (how you think when catching up), otherwise weekday + day + month, with
// the year appended only when it isn't the current one. Local time (matches the
// per-row age). Math.round on the local-midnight difference stays correct
// across a DST hour.
export function dayLabelWith(unix: number, ctx: DayLabelCtx): string {
   const d = new Date(unix * 1000)
   const diff = Math.round(
      (ctx.midnightNow - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000,
   )
   if (diff === 0) return "TODAY"
   if (diff === 1) return "YESTERDAY"
   const base = `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`
   return d.getFullYear() === ctx.nowYear ? base : `${base} ${d.getFullYear()}`
}
