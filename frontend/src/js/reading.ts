// reading.ts — the reader's typography preferences: text size, column width,
// line spacing and the prose typeface.
//
// A LEAF beside pane.ts (imports keys + storage only). It writes custom
// properties on <html> — `--prose-size`, `--prose-leading`, `--prose-font` and
// `--column-w` — that tokens.css defaults and styles.css reads, so every surface
// that lays out prose picks them up with no JS of its own. That includes the
// pager's preview page, which must break every line exactly where the real
// reader does (article-view.ts): both inherit the same properties from <html>,
// so a preference can never make the two diverge.
//
// A default value REMOVES its property rather than writing the default, so
// tokens.css stays the one place the defaults are spelled.
//
// Persisted globally in `srr-reading` — a property of this SCREEN and of the
// person holding it, like the pane width, and deliberately outside the portable
// profile: a phone's large text synced onto a 27" monitor is a worse default
// than the monitor's own.
import { READING_KEY } from "./keys"
import { lsGet, lsSet } from "./storage"

export type Width = "narrow" | "normal" | "wide"
export type Leading = "compact" | "normal" | "relaxed"
export type Font = "sans" | "serif"

export interface ReadingPrefs {
   size: number // index into SIZES
   width: Width
   leading: Leading
   font: Font
}

// Prose sizes in rem. Index 1 is tokens.css's --prose-size default.
export const SIZES: readonly number[] = [0.95, 1.05, 1.15, 1.275, 1.4]
export const DEFAULT_SIZE = 1

const WIDTHS: Record<Width, string> = { narrow: "580px", normal: "", wide: "820px" }
const LEADINGS: Record<Leading, string> = { compact: "1.5", normal: "", relaxed: "1.85" }
const FONTS: Record<Font, string> = { sans: "", serif: "var(--font-serif)" }

export const DEFAULTS: Readonly<ReadingPrefs> = { size: DEFAULT_SIZE, width: "normal", leading: "normal", font: "sans" }

const oneOf = <T extends string>(v: unknown, table: Record<T, string>, fallback: T): T =>
   typeof v === "string" && Object.hasOwn(table, v) ? (v as T) : fallback

// Tolerant read: an absent, corrupt or partial blob yields the defaults for
// whatever it does not validly carry — a device-local convenience must never
// break a render.
export function readPrefs(): ReadingPrefs {
   let raw: Record<string, unknown> = {}
   try {
      const parsed: unknown = JSON.parse(lsGet(READING_KEY) || "{}")
      if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>
   } catch {
      /* corrupt → defaults */
   }
   const size = typeof raw.size === "number" && Number.isInteger(raw.size) ? raw.size : DEFAULT_SIZE
   return {
      size: Math.min(SIZES.length - 1, Math.max(0, size)),
      width: oneOf(raw.width, WIDTHS, DEFAULTS.width),
      leading: oneOf(raw.leading, LEADINGS, DEFAULTS.leading),
      font: oneOf(raw.font, FONTS, DEFAULTS.font),
   }
}

const isDefault = (p: ReadingPrefs): boolean =>
   p.size === DEFAULTS.size && p.width === DEFAULTS.width && p.leading === DEFAULTS.leading && p.font === DEFAULTS.font

export function applyPrefs(p: ReadingPrefs, root: HTMLElement = document.documentElement): void {
   const set = (prop: string, value: string) => {
      if (value) root.style.setProperty(prop, value)
      else root.style.removeProperty(prop)
   }
   set("--prose-size", p.size === DEFAULT_SIZE ? "" : `${SIZES[p.size]}rem`)
   set("--column-w", WIDTHS[p.width])
   set("--prose-leading", LEADINGS[p.leading])
   set("--prose-font", FONTS[p.font])
}

// Persist and apply. The all-default state removes the key entirely, so a
// device that never touched the dialog carries nothing.
export function setPrefs(p: ReadingPrefs): void {
   lsSet(READING_KEY, isDefault(p) ? null : JSON.stringify(p))
   applyPrefs(p)
}

// One step of the text size (the reader's +/- keys). Returns whether it moved,
// so a key at either end of the scale does nothing rather than rewriting.
export function stepSize(dir: 1 | -1): boolean {
   const p = readPrefs()
   const size = Math.min(SIZES.length - 1, Math.max(0, p.size + dir))
   if (size === p.size) return false
   setPrefs({ ...p, size })
   return true
}

// Boot: apply whatever is stored, before the first paint of an article.
export function initReading(): void {
   applyPrefs(readPrefs())
}
