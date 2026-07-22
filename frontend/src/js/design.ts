// design.ts — a dev-only control panel that drives the REAL app (booted by
// design-boot.ts) so Claude can see every visual state. It imports no app module
// (so the unit tests can import it without self-booting app.ts): it navigates by
// setting location.hash (the app's hashchange router reacts) and forces
// transient/interaction-only states by toggling the SAME CSS classes
// app.ts/list.ts use. So what the harness shows is the real rendering — no mock
// components, nothing to drift.
//
// keys.ts is side-effect-free (like the app modules this harness avoids, it
// pulls in no db.gz fetch), so importing the key helper is safe here.
import { HOME_MID, savedKey } from "./keys"

// The harness is single-store by construction, so its seed writes the HOME
// store's saved key (bare `srr-saved`) — finding ENG5's dev-harness bypasser.
const SAVED_KEY = savedKey(HOME_MID)

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

// Each transient is the real class(es) the app would add for that state, plus an
// optional text fill. The table drives both forcing and clearing — adding a
// state is one entry, never a switch arm + a separate class list to keep in sync.
export interface Transient {
   id: string
   label: string
   apply: { sel: string; cls: string }[]
   text?: { sel: string; value: string }
}

export const TRANSIENTS: Transient[] = [
   {
      id: "error",
      label: "Error popup",
      apply: [{ sel: ".srr-popup", cls: "srr-open" }],
      text: { sel: ".srr-popup-text", value: "Sample error: failed to load db.gz (HTTP 503)." },
   },
   {
      id: "bell-left",
      label: "Reader edge bell ◀",
      apply: [
         { sel: ".srr-reader", cls: "srr-bell-left" },
         { sel: ".srr-prev", cls: "srr-edge-pulse" },
      ],
   },
   {
      id: "bell-right",
      label: "Reader edge bell ▶",
      apply: [
         { sel: ".srr-reader", cls: "srr-bell-right" },
         { sel: ".srr-next", cls: "srr-edge-pulse" },
      ],
   },
   {
      id: "broken-media",
      label: "Collapsed broken media",
      apply: [{ sel: ".srr-content img, .srr-content video", cls: "srr-broken" }],
   },
]

export function forceTransient(id: string, root: Document): void {
   const t = TRANSIENTS.find((x) => x.id === id)
   if (!t) return
   if (t.text) {
      const el = root.querySelector(t.text.sel)
      if (el) el.textContent = t.text.value
   }
   for (const a of t.apply) root.querySelector(a.sel)?.classList.add(a.cls)
}

export function clearTransients(root: Document): void {
   const classes = new Set(TRANSIENTS.flatMap((t) => t.apply.map((a) => a.cls)))
   for (const c of classes) root.querySelectorAll("." + c).forEach((el) => el.classList.remove(c))
}

// ---- Optional curated targets (emitted by the fixture generator) -----------

export interface DesignTargets {
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
   // Explicit override via color-scheme on the root; "auto" clears it and defers
   // back to prefers-color-scheme.
   document.documentElement.style.colorScheme = mode === "auto" ? "" : mode
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
      const raw = localStorage.getItem(SAVED_KEY)
      const set = new Set<number>(raw ? (JSON.parse(raw) as number[]) : [])
      set.add(chron)
      localStorage.setItem(SAVED_KEY, JSON.stringify([...set]))
   } catch {}
}

// ---- Boot ------------------------------------------------------------------

async function mount(): Promise<void> {
   const host = document.getElementById("srr-design-panel")
   if (!host) return
   const targets = await loadTargets()
   host.replaceChildren(buildPanel(targets))
}

// app.ts dispatches srr:ready after init(). Mount on that event, and once now as
// a fallback so the theme + transient controls still work if the app errored
// before srr:ready (this module is a deferred entry, so the DOM is already
// parsed). mount() is idempotent (replaceChildren), so the double-fire is fine.
// The `typeof document` guard lets node-env importers (the screenshotter) load
// this module for its exports without tripping over the boot block.
if (typeof document !== "undefined" && document.getElementById("srr-design-panel")) {
   document.addEventListener("srr:ready", () => void mount())
   void mount()
}
