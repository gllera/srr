// article-view.ts — the PURE article fill: masthead fields and content nodes, for
// a caller-supplied set of DOM nodes.
//
// It exists because there are now TWO article surfaces: the real reader
// (index.html's .srr-reader, filled by reader.ts) and the pager's preview page
// (built in JS by pager.ts). Both must produce byte-identical layout — same
// classes, same lang stamp, same sanitizer — because the carousel's handoff
// swaps one for the other and any difference shows up as a visible jump.
// One function each, so there is one place for that to be true.
//
// A LEAF module by the els.ts/urlish.ts rule: it takes its nodes as arguments
// rather than importing `el`, which is exactly what makes it reusable for a
// surface index.html never declared. No controller imports.
import * as data from "./data"
import { readerDateline, sanitizeFragment, srcColorIndex } from "./fmt"
import { type IArticleWire } from "./format.gen"
import { URL_DENY } from "./urlish"

// The nodes one article surface owns. The real reader passes its `el` refs; the
// pager passes the ones it built. Same shape, same classes, same CSS.
export interface ArticleRefs {
   root: HTMLElement
   titleRow: HTMLAnchorElement
   source: HTMLElement
   desk: HTMLElement
   date: HTMLElement
   title: HTMLElement
   content: HTMLElement
}

export function paintMasthead(refs: ArticleRefs, article: IArticleWire, feed: IFeed | undefined): void {
   // Titleless feeds (Telegram-style: the title is just the content's first line)
   // hide the <h1> so the body isn't shown twice; the masthead permalink stands
   // in for the hidden title's link.
   refs.root.classList.toggle("srr-reader-titleless", !!feed?.nt)
   // Key the masthead to the article's source color (same ramp as the list rails).
   refs.root.dataset.src = String(srcColorIndex(article.f))
   refs.source.textContent = data.feedTitle(article.f)
   // Desk/section: the feed's tag as a hashtag ("#" is real text so it shares the
   // tag's ink; the "·" separator is CSS). Empty for an untagged feed → the
   // .srr-desk row is hidden (:not(:empty)).
   refs.desk.textContent = feed?.tag ? "#" + feed.tag : ""
   // t/l are omitempty on the wire — an untitled article must not render "undefined"
   refs.title.textContent = article.t ?? ""

   // Reject javascript:/data:/vbscript:/file: in case the writer pipeline let one
   // through. The whole masthead row is the one permalink; an href makes it a
   // link, its absence leaves it inert chrome.
   const safeLink = article.l && !URL_DENY.test(article.l) ? article.l : ""
   if (safeLink) refs.titleRow.href = safeLink
   else refs.titleRow.removeAttribute("href")

   // p is omitted (=> undefined) when the writer couldn't parse a date.
   const published = article.p ?? 0
   const dateline = published ? readerDateline(published) : null
   refs.date.textContent = dateline ? dateline.text : ""
   refs.date.title = dateline ? dateline.title : ""
   // Hide the date (and its leading "·" separator) when undated, so the source
   // name doesn't trail a dangling middot.
   refs.date.hidden = !published
}

// The article's own language (`g` on the wire). Without it the surface inherits
// <html lang="en">: a screen reader pronounces a Spanish body in an English
// voice, and `hyphens: auto` (styles.css, active on .srr-content) applies English
// patterns. The fallback is lang="" — which declares the language UNKNOWN, not
// "inherit"; REMOVING the attribute would inherit and do exactly that.
//
// dir=auto lets the browser infer direction from the first strong character,
// which is the only honest answer when the feed declares none — without it an
// undeclared-RTL body renders LTR.
//
// This is separate from buildContent because it stamps the HOST, which each
// surface owns, and because both surfaces must apply it identically: different
// hyphenation means different line breaking, which means the carousel handoff
// would shift text under the reader's eye.
export function stampContentHost(host: HTMLElement, article: IArticleWire): void {
   host.lang = article.g ?? ""
   host.dir = "auto"
}

// The content nodes. Adopting sanitized nodes directly (rather than an innerHTML
// string round-trip) is what keeps a prev/next step from re-parsing the article.
export function buildContent(article: IArticleWire, base: URL, opts: { inert: boolean }): DocumentFragment {
   const frag = document.createDocumentFragment()
   // §9.3 (docs/MANIFEST-SPEC.md): `srr store compact` replaces an expired
   // article's payload with a tombstone keeping f/a/p and DROPPING c/t/l, so `c`
   // is absent at runtime despite its string type. Reachable only via a ★-Saved /
   // deep-linked expired chron (normal nav filters chron < add_idx), and the
   // explicit state below is what stops the literal "undefined"
   // sanitizeFragment(undefined) would otherwise produce.
   if (article.c == null) frag.append(expiredTombstone())
   else frag.append(sanitizeFragment(article.c, base))
   if (opts.inert) makeMediaInert(frag)
   return frag
}

// Replace every <audio>/<video> with a same-box stub. THREE independent reasons,
// any one sufficient (spec §2):
//   - FEB2's harvest/restore and player.ts's adopt/rehome pair state to elements
//     BY INDEX over querySelectorAll("audio,video"), and player.ts claims
//     playback from ONE capture-phase `play` listener on the document. A live
//     duplicate in a second surface is exactly the hazard the original
//     masthead-only pane avoided by previewing nothing at all.
//   - A page you may abandon must not open a second media stream. On mobile data
//     that is the difference between a gesture and a download.
//   - Swiping back toward a playing episode would otherwise build a duplicate of
//     a node that currently lives in .srr-player-media.
// Images stay real: prefetch.ts already warmed them, and they are the article's
// visual substance — a preview without them would not be the article.
//
// The stub takes the element's RESTING BOX, not just its place: the handoff in
// pager.ts swaps this surface for the real one, so a stub of the wrong size would
// reflow everything below it at exactly the moment the design exists to smooth.
function makeMediaInert(frag: DocumentFragment): void {
   for (const m of [...frag.querySelectorAll("audio, video")]) {
      const stub = document.createElement("div")
      stub.className = "srr-media-stub"
      stub.setAttribute("aria-hidden", "true")
      const w = Number(m.getAttribute("width"))
      const h = Number(m.getAttribute("height"))
      if (m.tagName === "AUDIO") stub.classList.add("srr-media-stub-audio")
      else if (w > 0 && h > 0) stub.style.aspectRatio = `${w} / ${h}`
      else stub.style.aspectRatio = "16 / 9"
      const poster = m.getAttribute("poster")
      // The poster is already sanitizer-approved: sanitizeFragment resolved and
      // bounds-checked it on the way in, so this re-reads a trusted value.
      if (poster) stub.style.backgroundImage = `url("${poster}")`
      m.replaceWith(stub)
   }
}

// The §9.3 compaction tombstone body: an expired article whose payload `srr
// compact` reclaimed. A sibling of the "[DELETED]" feed tombstone (feedTitle) —
// the source · date masthead still renders correctly, only the content is gone.
export function expiredTombstone(): HTMLElement {
   const p = document.createElement("p")
   p.className = "srr-expired-note"
   p.textContent = "This article is no longer stored"
   return p
}
