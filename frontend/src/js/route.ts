// Hash routing — the `#pos[!tokens]` grammar, in one place. Split out of nav.ts
// (finding ENG3): encoding a filter into the fragment and parsing one back is
// pure string work over the token list, so it needs none of nav's state. nav
// passes its current tokens (and cursor) in; app.ts's route() and boot
// foreign-hash guard classify through the parse half.
//
// Multi-store (docs/MULTI-STORE-SPEC.md §6.3): the active mount rides IN the
// token grammar — see tokensSuffix/parseHashMount below.
import * as data from "./data"
import { HOME_MID } from "./keys"

const encTok = (t: string): string => encodeURIComponent(t).replaceAll("+", "%2B")

// The `!tokens` hash suffix for the given filter tokens ("" when there are none)
// — shared by updateHash (reader `#pos!tokens`) and the list surface
// (`#!tokens`, no pos).
// `+` joins tokens, so a literal `+` inside one (e.g. a search query "c++") is
// escaped to %2B — encodeURIComponent leaves `+` alone — and decoded back after
// the split on the read side (route/fromHash).
//
// Multi-store (docs/MULTI-STORE-SPEC.md §6.3): the active mount rides IN the
// token grammar. The HOME mount emits BARE tokens exactly as before, so every
// existing deep link and stored srr-hash keeps working untouched; a PEER mount
// prefixes each token with `@<mid>:`, and a peer [ALL] (no tokens) emits a bare
// `@<mid>` marker so the mount survives.
export function tokensSuffix(tokens: string[]): string {
   // An empty token list IS an inactive filter ([ALL]) — the same predicate
   // nav's filter.active getter is.
   const active = tokens.length > 0
   const mid = data.activeStore().mid
   if (mid === HOME_MID) {
      return active ? "!" + tokens.map(encTok).join("+") : ""
   }
   if (!active) return "!@" + mid
   return "!" + tokens.map((t) => "@" + mid + ":" + encTok(t)).join("+")
}

// Extract the mount + the bare filter tokens from a hash's decoded token list
// (§6.3). All-bare tokens ⇒ the home mount. A peer token is `@<mid>` ([ALL]) or
// `@<mid>:<token>`. All tokens must share ONE mount prefix; a MIXED hash keeps
// the first mount's tokens and drops the rest (the same forgiving posture as a
// malformed escape). The `@`/`:` are literal in the fragment; the token VALUE
// after the first `:` is already decoded, so a token containing `:` (a search
// `q:…`, a tag with a colon) survives — only the FIRST colon splits.
export function parseHashMount(rawTokens: string[]): { mid: string; tokens: string[] } {
   if (rawTokens.length === 0 || !rawTokens[0].startsWith("@")) {
      return { mid: HOME_MID, tokens: rawTokens }
   }
   const parseTok = (t: string): { mid: string; tok: string } => {
      const colon = t.indexOf(":")
      return colon === -1 ? { mid: t.slice(1), tok: "" } : { mid: t.slice(1, colon), tok: t.slice(colon + 1) }
   }
   const mid = parseTok(rawTokens[0]).mid
   const tokens: string[] = []
   for (const raw of rawTokens) {
      if (!raw.startsWith("@")) break // a bare token after a peer prefix — mixed, stop
      const p = parseTok(raw)
      if (p.mid !== mid) break // a different mount — first mount wins, drop the rest
      if (p.tok) tokens.push(p.tok)
   }
   return { mid, tokens }
}

// The position part of a `#pos[!tokens]` hash — everything before the first
// `!` (the whole hash when there is none). "" means no position (a list hash);
// an integer routes to the reader; anything else is a foreign hash (app.ts's
// boot guard drops those). parseHashTokens below is the suffix half.
export function hashPos(hash: string): string {
   const bang = hash.indexOf("!")
   return bang === -1 ? hash : hash.substring(0, bang)
}

// Parse the `!tokens` segment of a hash into an array of decoded token strings.
// Called by both app.ts route() (the list path) and fromHash() (the reader path).
// A malformed %-escape passes through verbatim rather than crashing navigation.
export function parseHashTokens(hash: string): string[] {
   const bang = hash.indexOf("!")
   if (bang === -1) return []
   return hash
      .substring(bang + 1)
      .split("+")
      .filter((t) => t.length > 0)
      .map((t) => {
         try {
            return decodeURIComponent(t)
         } catch {
            return t
         }
      })
}

// Write the reader's cursor + filter into the fragment. `pos` < 0 (no article on
// screen — the placeholder states) emits the filter alone.
export function updateHash(pos: number, tokens: string[], replace = false) {
   const hash = pos >= 0 ? `#${pos}${tokensSuffix(tokens)}` : `#${tokensSuffix(tokens)}`
   history[replace ? "replaceState" : "pushState"](null, "", hash)
}
