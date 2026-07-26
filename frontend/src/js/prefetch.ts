// Neighbor media prefetch — the ONE DOM-touching half of navigation, split out
// of nav.ts (finding ENG3) so nav itself stays DOM-free: everything here
// constructs `Image`/`<video>` elements, which is exactly why it did not belong
// beside the filter state machine.
//
// After each left()/right(), nav's speculative neighbor lookup resolves to a
// chronIdx and hands it to schedulePrefetch: the neighbor's article is loaded on
// requestIdleCallback and its media warmed, so stepping onto it finds the
// connection already primed. The abort / freshness / arrival discipline below is
// load-bearing — see each docblock before editing.
import * as data from "./data"
import { extractPrefetchMedia } from "./fmt"

// Caps on the neighbor prefetch. Uncapped, an image-stuffed neighbor (live
// store measured articles with 300+ <img> tags) floods the connection with
// low-priority downloads that split bandwidth so thin none completes before
// the user steps — and competes with the on-screen article's own lazy loads.
// The rendered article only needs its first viewport immediately (its images
// are loading=lazy), so warm just that many; a capped prefetch actually
// finishes within a normal reading dwell. Videos are metadata-only fetches
// (duration/dimensions/first frame — cheap for faststart assets), 2 is plenty.
const PREFETCH_IMAGES = 6
const PREFETCH_VIDEOS = 2

// Holds refs to the last neighbor's prefetched media so we can both abort
// their in-flight loads (src = "" — the WHATWG image-update steps for <img>,
// the media-load algorithm's abort for <video>) and drop the references,
// bounding memory to one neighbor at a time. `target` lets nav's resolve() tell
// arrival at the prefetched article apart from navigating elsewhere. Object
// identity also acts as the freshness token: a pending idle callback that
// finds `my !== currentPrefetch` bails instead of pushing into a stale record.
interface Prefetch {
   target: number
   imgs: HTMLImageElement[]
   vids: HTMLVideoElement[]
}
let currentPrefetch: Prefetch | null = null

// The chron the in-flight prefetch is warming (undefined = none). Read by nav's
// resolve() to tell "we arrived at the article we were prefetching" from any
// other navigation — the ONE case that must NOT abort.
export function prefetchTarget(): number | undefined {
   return currentPrefetch?.target
}

// Drop the refs WITHOUT cancelling the loads: arriving at the prefetched
// article means its in-flight loads are exactly what the rendered content is
// about to attach to (same-URL image loads coalesce within a document —
// aborting there restarted every image from scratch, which made the prefetch
// useless for any neighbor whose images hadn't all finished). The rendered
// elements own the loads from here.
export function releasePrefetch(): void {
   currentPrefetch = null
}

export function abortPrefetch() {
   if (currentPrefetch) {
      for (const img of currentPrefetch.imgs) img.src = ""
      for (const vid of currentPrefetch.vids) vid.src = ""
   }
   currentPrefetch = null
}

export function schedulePrefetch(target: number) {
   if (target === -1) return
   const my: Prefetch = { target, imgs: [], vids: [] }
   currentPrefetch = my
   const run = async () => {
      if (my !== currentPrefetch) return
      try {
         const art = await data.loadArticle(target)
         if (my !== currentPrefetch) return
         const media = extractPrefetchMedia(art.c, data.activeStore().base)
         for (const url of media.images.slice(0, PREFETCH_IMAGES)) {
            const img = new Image()
            img.fetchPriority = "low"
            img.decoding = "async"
            img.src = url
            my.imgs.push(img)
         }
         for (const url of media.videos.slice(0, PREFETCH_VIDEOS)) {
            // preload must be set before src: assigning src invokes the media
            // load algorithm, which reads the preload hint.
            const vid = document.createElement("video")
            vid.preload = "metadata"
            vid.src = url
            my.vids.push(vid)
         }
      } catch {
         // Best-effort; errors surface on user nav.
      }
   }
   // WebKit has no requestIdleCallback — without the timeout fallback every
   // iOS reader would stall at each data-pack boundary instead of prefetching.
   if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 500 })
   else setTimeout(run, 200)
}
