// Pin registry — localStorage map of filter-key → {names, ts}.
// Tracks which packs are pinned offline for each filter scope.
// Tolerant: any parse error yields an empty registry rather than throwing.

import { PINS_KEY } from "./keys"

export { PINS_KEY }

export interface PinEntry {
   names: string[]
   ts: number
}

function loadRegistry(): Map<string, PinEntry> {
   try {
      const raw = localStorage.getItem(PINS_KEY)
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

function saveRegistry(map: Map<string, PinEntry>): void {
   try {
      const obj: Record<string, PinEntry> = {}
      for (const [k, v] of map) obj[k] = v
      localStorage.setItem(PINS_KEY, JSON.stringify(obj))
   } catch {
      // quota errors — best-effort
   }
}

export function pinFilter(key: string, names: string[]): void {
   const map = loadRegistry()
   map.set(key, { names, ts: Date.now() })
   saveRegistry(map)
}

export function unpinFilter(key: string): void {
   const map = loadRegistry()
   map.delete(key)
   saveRegistry(map)
}

export function isPinned(key: string): boolean {
   return loadRegistry().has(key)
}

export function listPins(): Map<string, PinEntry> {
   return loadRegistry()
}
