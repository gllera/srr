// Pin registry — localStorage map of filter-key → {names, ts}.
// Tracks which packs are pinned offline for each filter scope.
// Tolerant: any parse error yields an empty registry rather than throwing.
//
// Per-store (docs/MULTI-STORE-SPEC.md §4.2): the registry lives under the
// mount-qualified key `pinsKey(mid)`. The `mid` is a trailing parameter
// defaulting to HOME_MID, so the home store (and every existing single-store
// call site + test) reads/writes the bare `srr-pins` key unchanged; a peer
// mount passes its own mid and keeps a separate registry.

import { HOME_MID, pinsKey } from "./keys"

export interface PinEntry {
   names: string[]
   ts: number
}

function loadRegistry(mid: string): Map<string, PinEntry> {
   try {
      const raw = localStorage.getItem(pinsKey(mid))
      if (!raw) return new Map()
      const obj = JSON.parse(raw) as unknown
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return new Map()
      const map = new Map<string, PinEntry>()
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
         if (
            typeof v === "object" &&
            v !== null &&
            !Array.isArray(v) &&
            Array.isArray((v as Record<string, unknown>).names) &&
            typeof (v as Record<string, unknown>).ts === "number"
         ) {
            map.set(k, v as PinEntry)
         }
      }
      return map
   } catch {
      return new Map()
   }
}

function saveRegistry(map: Map<string, PinEntry>, mid: string): void {
   try {
      const obj: Record<string, PinEntry> = {}
      for (const [k, v] of map) obj[k] = v
      localStorage.setItem(pinsKey(mid), JSON.stringify(obj))
   } catch {
      // quota errors — best-effort
   }
}

export function pinFilter(key: string, names: string[], mid = HOME_MID): void {
   const map = loadRegistry(mid)
   map.set(key, { names, ts: Date.now() })
   saveRegistry(map, mid)
}

export function unpinFilter(key: string, mid = HOME_MID): void {
   const map = loadRegistry(mid)
   map.delete(key)
   saveRegistry(map, mid)
}

export function isPinned(key: string, mid = HOME_MID): boolean {
   return loadRegistry(mid).has(key)
}

export function listPins(mid = HOME_MID): Map<string, PinEntry> {
   return loadRegistry(mid)
}
