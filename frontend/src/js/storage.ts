// storage.ts — the shared localStorage shapes: the JSON integer-set (★ Saved,
// the picker's ★ Favorites) and the per-key ordering-timestamp map (the LWW
// seam profile.ts merges srr-seen-ts / srr-saved-ts by). A LEAF module
// (imports nothing), like keys.ts — which stays names-only on purpose.

// A JSON integer array under `key`, as a Set. Absent, corrupt or throwing
// storage (private mode, disabled by policy) reads as empty — these are
// device-local conveniences and must never be able to break a render.
export function readIdSet(key: string): Set<number> {
   try {
      const raw = localStorage.getItem(key)
      const arr: unknown = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(arr) ? arr.filter((n): n is number => Number.isInteger(n)) : [])
   } catch {
      return new Set()
   }
}

export function writeIdSet(key: string, ids: Set<number>): void {
   try {
      localStorage.setItem(key, JSON.stringify([...ids]))
   } catch {
      // Full or blocked storage: the change applies to this session and is lost
      // on reload, which is strictly better than throwing out of a user gesture.
   }
}

// Stamp `ids` at NOW (unix seconds) in the ordering map under `key` — the
// unix-second that lets sync order a key's latest local action against other
// devices (profile.ts's per-key LWW). A corrupt map is replaced rather than
// crashed on; a device that cannot stamp degrades to the blob-level ordering.
export function stampTsMap(key: string, ids: readonly (string | number)[]): void {
   try {
      const raw = localStorage.getItem(key)
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      const map =
         parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, number>)
            : {}
      const now = Math.floor(Date.now() / 1000)
      for (const id of ids) map[id] = now
      localStorage.setItem(key, JSON.stringify(map))
   } catch {}
}

// The raw string get/set, best-effort like everything else here: storage that
// throws (private mode, disabled by policy) reads empty and writes nothing.
// `null` REMOVES the key — the one shape a caller storing an optional value
// needs, and the reason these live together rather than as a get-only helper.
//
// Deliberately NOT the home of every localStorage touch in the app: schema.ts
// must distinguish "storage threw" from "key absent" (a plain string cannot say
// that), and the modules whose accessors ARE their public API — fmt's image
// proxy, sync's endpoint URL — keep theirs.
export function lsGet(key: string): string {
   try {
      return localStorage.getItem(key) ?? ""
   } catch {
      return ""
   }
}

export function lsSet(key: string, value: string | null): void {
   try {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
   } catch {}
}
