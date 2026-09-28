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
import { lsJson, lsSet } from "./storage"

export interface PinEntry {
   names: string[]
   ts: number
}

function loadRegistry(mid: string): Map<string, PinEntry> {
   const obj = lsJson(pinsKey(mid))
   const map = new Map<string, PinEntry>()
   if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return map
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
}

// Best-effort: a quota error drops the write (lsSet swallows it).
function saveRegistry(map: Map<string, PinEntry>, mid: string): void {
   lsSet(pinsKey(mid), JSON.stringify(Object.fromEntries(map)))
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
