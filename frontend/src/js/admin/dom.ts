// DOM + formatting primitives shared across the console. This is the port of
// app.js's `el()`/icon/`srcColorIndex`/`relTime` helpers, with the SEC3 change
// baked in: `el()` no longer has the `html:` innerHTML escape hatch (the strict
// CSP has no inline anything to grandfather), and the four Feather icons are
// real elements referencing an inline <symbol> sprite in admin.html instead of
// raw SVG strings.

type Attrs = Record<string, unknown>
type Kid = Node | string

// el(tag, attrs, ...kids) builds an element. `class` sets className, an `on*`
// key adds an event listener, anything else is a plain attribute (skipped when
// null/undefined). The generic return type gives element-specific properties
// (.value, .checked, .open, .selected, …) without a cast at the call site.
export function el<K extends keyof HTMLElementTagNameMap>(
   tag: K,
   attrs?: Attrs | null,
   ...kids: Kid[]
): HTMLElementTagNameMap[K] {
   const e = document.createElement(tag)
   for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = String(v)
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v as EventListener)
      else if (v !== null && v !== undefined) e.setAttribute(k, String(v))
   }
   for (const kid of kids) if (kid !== "") e.append(kid) // "" = no child — keeps :empty selectors honest
   return e
}

const SVGNS = "http://www.w3.org/2000/svg"

// icon(name) returns a 16px SVG referencing the "#i-<name>" symbol defined in
// admin.html's inline sprite. Stroke presentation attributes ride the outer
// <svg> and inherit into the <use>d shapes (currentColor picks up the button's
// text color). Replaces app.js's ICON_* raw-innerHTML strings (SEC3).
export function icon(name: string): SVGSVGElement {
   const svg = document.createElementNS(SVGNS, "svg")
   svg.setAttribute("class", "icon")
   svg.setAttribute("width", "16")
   svg.setAttribute("height", "16")
   // No viewBox here — the referenced <symbol> carries viewBox="0 0 24 24", which
   // governs the coordinate mapping into this 16px <use> viewport. The stroke
   // presentation attributes below inherit into the symbol's shapes.
   svg.setAttribute("fill", "none")
   svg.setAttribute("stroke", "currentColor")
   svg.setAttribute("stroke-width", "2")
   svg.setAttribute("stroke-linecap", "round")
   svg.setAttribute("stroke-linejoin", "round")
   svg.setAttribute("aria-hidden", "true")
   const use = document.createElementNS(SVGNS, "use")
   use.setAttribute("href", "#i-" + name)
   svg.append(use)
   return svg
}

// Source-color slot for a feed id. Mirrors the reader's fmt.ts srcColorIndex
// (feed_id % 8, normalized non-negative) so a feed's rail color in the console
// matches the color it carries in the reader. Re-implemented rather than
// imported from fmt.ts to keep the admin bundle fully isolated from the reader
// modules (importing fmt.ts drags in base.ts's module-load side effect and the
// sanitizer) — the formula is fixed by the shared [data-src] ramp in tokens.css.
const SRC_COLORS = 8
export const srcColorIndex = (id: number): number => ((id % SRC_COLORS) + SRC_COLORS) % SRC_COLORS

// relTime renders a unix-seconds timestamp as a coarse "how long ago" readout
// ("3h ago"); 0 = "never". Coarse on purpose — exact instants ride titles.
export function relTime(sec: number): string {
   if (!sec) return "never"
   const s = Math.max(0, Math.floor(Date.now() / 1000 - sec))
   if (s < 60) return "just now"
   if (s < 3600) return Math.floor(s / 60) + "m ago"
   if (s < 86400) return Math.floor(s / 3600) + "h ago"
   if (s < 604800) return Math.floor(s / 86400) + "d ago"
   return Math.floor(s / 604800) + "w ago"
}
