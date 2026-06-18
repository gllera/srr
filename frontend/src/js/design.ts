// design.ts — a dev-only control panel that drives the REAL app (booted by
// app.ts in design.html) so Claude can see every visual state. It never imports
// app modules: it navigates by setting location.hash (the app's hashchange
// router reacts) and forces transient/interaction-only states by toggling the
// SAME CSS classes app.ts/list.ts use. So what the harness shows is the real
// rendering — no mock components, nothing to drift.

// ---- State jumps -----------------------------------------------------------

export type DesignState =
   | { kind: "list" }
   | { kind: "saved" }
   | { kind: "filter"; token: string }
   | { kind: "search"; query: string }
   | { kind: "reader"; pos: number; token?: string }

// Mirror nav.ts's hash grammar: `#pos[!tokens]`, tokens encodeURIComponent'd,
// the search filter mode riding as the `q:<query>` token.
export function stateHash(s: DesignState): string {
   switch (s.kind) {
      case "list":
         return "#"
      case "saved":
         return "#!" + encodeURIComponent("~saved")
      case "filter":
         return "#!" + encodeURIComponent(s.token)
      case "search":
         return "#!" + encodeURIComponent("q:" + s.query)
      case "reader":
         return "#" + s.pos + (s.token ? "!" + encodeURIComponent(s.token) : "")
   }
}

// ---- Transient / interaction-only states -----------------------------------

export interface Transient {
   id: string
   label: string
}

// Each forcer adds the real class(es) the app would add for that state.
export const TRANSIENTS: Transient[] = [
   { id: "error", label: "Error popup" },
   { id: "bell-left", label: "Reader edge bell ◀" },
   { id: "bell-right", label: "Reader edge bell ▶" },
   { id: "broken-media", label: "Collapsed broken media" },
]

export function forceTransient(id: string, root: Document): void {
   const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)
   switch (id) {
      case "error": {
         const popup = q(".srr-popup")
         const text = q<HTMLElement>(".srr-popup-text")
         if (text) text.textContent = "Sample error: failed to load db.gz (HTTP 503)."
         popup?.classList.add("srr-open")
         break
      }
      case "bell-left": {
         q(".srr-reader")?.classList.add("srr-bell-left")
         q(".srr-prev")?.classList.add("srr-edge-pulse")
         break
      }
      case "bell-right": {
         q(".srr-reader")?.classList.add("srr-bell-right")
         q(".srr-next")?.classList.add("srr-edge-pulse")
         break
      }
      case "broken-media": {
         // Mark the first content image/video collapsed, like collapseBrokenMedia.
         q(".srr-content img, .srr-content video")?.classList.add("srr-broken")
         break
      }
   }
}

export function clearTransients(root: Document): void {
   const cls = ["srr-open", "srr-bell-left", "srr-bell-right", "srr-edge-pulse", "srr-broken"]
   for (const c of cls) root.querySelectorAll("." + c).forEach((el) => el.classList.remove(c))
}
