// The list surface's scroll seam. Below the split breakpoint the list scrolls
// the WINDOW (phone/tablet — today's behavior, byte for byte); in split view it
// scrolls its OWN pane element. Every scroll read/write in list.ts goes through
// one of these, so the mode is decided in exactly one place (list.setScroller,
// driven by app.ts). A leaf module: imports nothing.
export interface Scroller {
   y(): number
   to(y: number): void
   smoothTo(y: number): void
   viewportH(): number
   // Convert a getBoundingClientRect() top (viewport-relative) into the scrolled
   // box's absolute coordinate space — what "scroll position that puts this rect
   // at the top" means for this scroller.
   absTop(rectTop: number): number
   // Total scrollable length of the scrolled box — what a "did content above the
   // viewport grow?" compensation must measure. document scrollHeight for the
   // window, the host's own for a pane.
   extent(): number
   // IntersectionObserver root for the list's sentinels (null = the viewport).
   root(): Element | null
}

export function windowScroller(): Scroller {
   return {
      y: () => window.scrollY,
      to: (y) => window.scrollTo(0, y),
      smoothTo: (y) => window.scrollTo({ top: y, behavior: "smooth" }),
      viewportH: () => window.innerHeight || 900,
      absTop: (rectTop) => rectTop + window.scrollY,
      extent: () => (document.scrollingElement ?? document.documentElement).scrollHeight,
      root: () => null,
   }
}

export function elementScroller(host: HTMLElement): Scroller {
   return {
      y: () => host.scrollTop,
      // Direct scrollTop assignment works in every engine incl. jsdom; the pane
      // needs no clamping help (the browser clamps like window.scrollTo does).
      to: (y) => {
         host.scrollTop = y
      },
      smoothTo: (y) => {
         try {
            host.scrollTo({ top: y, behavior: "smooth" })
         } catch {
            host.scrollTop = y
         }
      },
      viewportH: () => host.clientHeight || window.innerHeight || 900,
      absTop: (rectTop) => rectTop - host.getBoundingClientRect().top + host.scrollTop,
      extent: () => host.scrollHeight,
      root: () => host,
   }
}
