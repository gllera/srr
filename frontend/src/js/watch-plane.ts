// watch-plane.ts — one keyword-watchlist bitmap object, decoded
// (docs/MANIFEST-SPEC.md §4.8; the writer is backend/watch.go watchDoc). A LEAF:
// bytes and bits only, so the arithmetic unit-tests without data.ts's fetch.
//
// The object at position p covers chrons [base, base+n) with base = p·50000. Each
// rule with at least one hit carries a base64 plane of ceil(n/8) bytes, LSB-first:
// chron base+i is byte i>>3, bit i&7. A rule with no hit in the region is absent.
import { WATCH_DOC_VERSION } from "./format.gen"

export interface WatchPlane {
   base: number
   n: number
   bits: ReadonlyMap<string, Uint8Array>
   // Set bits per rule over the whole region, counted once at decode.
   pop: ReadonlyMap<string, number>
}

interface WatchDocWire {
   v?: number
   base?: number
   n?: number
   bits?: Record<string, string>
}

export function emptyPlane(base: number, n: number): WatchPlane {
   return { base, n, bits: new Map(), pop: new Map() }
}

// STRICT, like the writer's parseWatchDoc: a body that cannot prove which chrons
// it describes is worse than no body. `maxN` is the region's size in the
// snapshot reading it — a plane never covers more chrons than the store holds
// there (the tail region only grows).
export function parseWatchPlane(doc: unknown, wantBase: number, maxN: number): WatchPlane {
   if (!doc || typeof doc !== "object") throw new Error("watch bitmap: not an object")
   const d = doc as WatchDocWire
   if (d.v !== WATCH_DOC_VERSION) throw new Error(`watch bitmap: unsupported version ${d.v}`)
   if (d.base !== wantBase) throw new Error(`watch bitmap: describes chrons from ${d.base}, expected ${wantBase}`)
   const n = d.n ?? 0
   if (!Number.isInteger(n) || n < 0 || n > maxN)
      throw new Error(`watch bitmap: covers ${n} chron(s), the region holds ${maxN}`)
   const want = Math.ceil(n / 8)
   const bits = new Map<string, Uint8Array>()
   const pop = new Map<string, number>()
   for (const [rule, b64] of Object.entries(d.bits ?? {})) {
      const bin = atob(b64)
      if (bin.length !== want)
         throw new Error(`watch bitmap: rule "${rule}" has ${bin.length} plane byte(s), want ${want} for ${n} chron(s)`)
      const plane = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) plane[i] = bin.charCodeAt(i)
      bits.set(rule, plane)
      pop.set(rule, popcountRange(plane, 0, n))
   }
   return { base: wantBase, n, bits, pop }
}

export function bitAt(plane: Uint8Array, i: number): boolean {
   return i >= 0 && ((plane[i >> 3] ?? 0) & (1 << (i & 7))) !== 0
}

export function nextSet(plane: Uint8Array, from: number, end: number): number {
   for (let i = Math.max(0, from); i < end; i++) {
      const byte = plane[i >> 3] ?? 0
      if (byte === 0) {
         i |= 7 // the loop's increment lands on the next byte's bit 0
         continue
      }
      if (byte & (1 << (i & 7))) return i
   }
   return -1
}

export function prevSet(plane: Uint8Array, from: number, lo: number): number {
   for (let i = from; i >= Math.max(0, lo); i--) {
      const byte = plane[i >> 3] ?? 0
      if (byte === 0) {
         i &= ~7 // the loop's decrement lands on the previous byte's bit 7
         continue
      }
      if (byte & (1 << (i & 7))) return i
   }
   return -1
}

export function popcountRange(plane: Uint8Array, lo: number, hi: number): number {
   let n = 0
   for (let i = nextSet(plane, lo, hi); i !== -1; i = nextSet(plane, i + 1, hi)) n++
   return n
}
