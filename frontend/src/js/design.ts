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

// ---- Optional curated targets (emitted by the fixture generator) -----------

interface DesignTargets {
   savedDeletedChron?: number // a saved article whose feed was removed (tombstone)
   ferrToken?: string // a feed id (as string) whose ferr is set
   longTitlePos?: number // chronIdx of the deliberately long-titled article
   sampleTag?: string // a tag that groups multiple feeds
}

async function loadTargets(): Promise<DesignTargets> {
   try {
      const res = await fetch("design.json", { cache: "no-store" })
      if (!res.ok) return {}
      return (await res.json()) as DesignTargets
   } catch {
      return {}
   }
}

// ---- Panel -----------------------------------------------------------------

function go(s: DesignState): void {
   clearTransients(document)
   location.hash = stateHash(s)
}

function button(label: string, onClick: () => void): HTMLButtonElement {
   const b = document.createElement("button")
   b.type = "button"
   b.className = "srr-design-btn"
   b.textContent = label
   b.addEventListener("click", onClick)
   return b
}

function group(title: string, ...kids: HTMLElement[]): HTMLElement {
   const g = document.createElement("div")
   g.className = "srr-design-group"
   const h = document.createElement("div")
   h.className = "srr-design-group-title"
   h.textContent = title
   g.append(h, ...kids)
   return g
}

function setTheme(mode: "auto" | "light" | "dark"): void {
   // Explicit override: set color-scheme on the root and record the choice in a
   // data attr. "auto" clears the override and defers to prefers-color-scheme.
   const root = document.documentElement
   root.style.colorScheme = mode === "auto" ? "" : mode
   root.dataset.designTheme = mode
}

export function buildPanel(targets: DesignTargets): HTMLElement {
   const panel = document.createElement("div")
   panel.className = "srr-design-inner"

   const surfaces = group(
      "Surfaces",
      button("List", () => go({ kind: "list" })),
      button("Reader (newest)", () => go({ kind: "reader", pos: 2147483647 })), // clamps to last
      button("★ Saved", () => go({ kind: "saved" })),
      button("Search 'a'", () => go({ kind: "search", query: "a" })),
   )

   const curated = group("Curated states")
   if (targets.sampleTag)
      curated.append(button(`Tag: ${targets.sampleTag}`, () => go({ kind: "filter", token: targets.sampleTag! })))
   if (targets.ferrToken)
      curated.append(button("Feed w/ error", () => go({ kind: "filter", token: targets.ferrToken! })))
   if (targets.longTitlePos != null)
      curated.append(button("Long title", () => go({ kind: "reader", pos: targets.longTitlePos! })))
   if (targets.savedDeletedChron != null)
      curated.append(
         button("Saved (deleted feed)", () => {
            seedSaved(targets.savedDeletedChron!)
            go({ kind: "saved" })
         }),
      )
   if (curated.childElementCount === 1) curated.append(disabledNote("run `make design-fixture`"))

   const transients = group(
      "Transient",
      ...TRANSIENTS.map((t) => button(t.label, () => forceTransient(t.id, document))),
   )
   transients.append(button("Clear", () => clearTransients(document)))

   const theme = group(
      "Theme",
      button("Auto", () => setTheme("auto")),
      button("Light", () => setTheme("light")),
      button("Dark", () => setTheme("dark")),
   )

   panel.append(surfaces, curated, transients, theme)
   return panel
}

function disabledNote(text: string): HTMLElement {
   const n = document.createElement("span")
   n.className = "srr-design-note"
   n.textContent = text
   return n
}

// Seed the device-local saved set so the ★ Saved view shows a tombstoned row.
function seedSaved(chron: number): void {
   try {
      const raw = localStorage.getItem("srr-saved")
      const set = new Set<number>(raw ? (JSON.parse(raw) as number[]) : [])
      set.add(chron)
      localStorage.setItem("srr-saved", JSON.stringify([...set]))
   } catch {}
}

// ---- Boot ------------------------------------------------------------------

async function mount(): Promise<void> {
   const host = document.getElementById("srr-design-panel")
   if (!host) return
   const targets = await loadTargets()
   host.replaceChildren(buildPanel(targets))
}

// app.ts dispatches srr:ready after init(). Mount on that event; also mount on
// DOMContentLoaded / immediately as a fallback so the theme + transient controls
// still work if the app errored before srr:ready. mount() is idempotent
// (replaceChildren), so a double-fire is harmless.
if (typeof document !== "undefined" && document.getElementById("srr-design-panel")) {
   document.addEventListener("srr:ready", () => void mount())
   if (document.readyState !== "loading") void mount()
   else document.addEventListener("DOMContentLoaded", () => void mount())
}
