// mounts.ts — the multi-store mount table (docs/MULTI-STORE-SPEC.md §3).
//
// The reader mounts N store roots at once. Each mounted store is one immutable
// pile of objects behind plain HTTP; a mount needs no server, no API and no
// negotiation beyond fetching its root. The mount TABLE is the device's list of
// which stores are mounted, where each lives, and how to reach it.
//
// This module is deliberately side-effect-light: the pure functions
// (normalization, id hashing, the OR-set merge) import nothing that fetches, so
// they unit-test standalone like pin.ts / profile.ts. It imports base.ts only
// for the home store's URL (HOME.base) — base.ts computes URLs, it does not
// fetch — and keys.ts for the storage key + the per-store key namespace.
//
// Identity (§3.2): the HOME mount's id is the literal "0", always, independent
// of its URL — it is the store the build points at and it cannot be removed.
// Every OTHER mount's id is `s` + FNV-1a-32(normalized url) in 8 lowercase hex
// digits, so two devices that mount the same URL agree on the namespace with
// zero coordination (which is what lets the synced mount table converge, §3.4).

import { HOME } from "./base"
import { HOME_MID, MOUNTS_KEY, pinsKey, profileTsKey, savedKey, seenKey, seenTsKey } from "./keys"

// One mount record (§3.1). Carries NO secret — `cred` is a boolean, not a token
// (§7.3, MS9). Presentation fields (label, ord, cred) plus a single LWW clock
// (`ts`) and a tombstone flag (`del`); a rename (§3.5) additionally carries
// `moved_to`.
export interface MountRecord {
   id: string // "0" for home; "s"+FNV-1a-32 hex otherwise
   url: string // normalized root, always exactly one trailing "/"
   label: string // user-editable display name ("" = derive from the URL host)
   ord: number // sort position in the picker
   role: "home" | "peer"
   cred: boolean // send credentials (cookies) with every fetch
   added: number // unix sec, first mount (informational + tie-break)
   ts: number // unix sec of the last mutation of THIS record (LWW clock)
   del: boolean // tombstone
   moved_to?: string // set on a rename tombstone (§3.5): the id state migrated to
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

// --- normalization + identity ---------------------------------------------

// Normalize a user-entered store URL to its canonical root form, or null when
// it is not a mountable URL (§3.2). Rules: parse with the URL API (punycodes
// the host, lowercases scheme+host, drops default ports); allow only https:
// (and http: on localhost/127.0.0.1 for dev); reject embedded credentials
// (user:pass@); drop query and fragment; ensure exactly one trailing "/".
export function normalizeStoreUrl(input: string): string | null {
   const raw = (input ?? "").trim()
   if (!raw) return null
   let u: URL
   try {
      u = new URL(raw)
   } catch {
      return null
   }
   const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]"
   if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) return null
   if (u.username || u.password) return null // no embedded credentials
   u.search = ""
   u.hash = ""
   // Exactly one trailing slash on the path.
   if (!u.pathname.endsWith("/")) u.pathname += "/"
   // u.href now carries the canonical scheme://host[:port]/path/.
   return u.href
}

// FNV-1a-32 over the normalized URL's UTF-8 bytes → "s" + 8 lowercase hex. The
// same URL always hashes to the same id on every device, so a synced mount set
// converges without any coordination (§3.2). Deterministic and self-contained;
// if a future manifest ever carries a store_id, prefer it over this (§3.2 note).
export function mountId(normalizedUrl: string): string {
   let h = 0x811c9dc5 // FNV-1a-32 offset basis
   const bytes = new TextEncoder().encode(normalizedUrl)
   for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i]
      // FNV prime 16777619, kept 32-bit unsigned via Math.imul + >>> 0.
      h = Math.imul(h, 0x01000193) >>> 0
   }
   return "s" + h.toString(16).padStart(8, "0")
}

// The home store's normalized URL (§3.3). The one URL that is always mount "0".
export function homeUrl(): string {
   return normalizeStoreUrl(HOME.base.href) ?? HOME.base.href
}

// The synthesized home record — exactly today's single-store behavior when
// srr-mounts is absent (§3.3).
export function homeRecord(): MountRecord {
   return {
      id: HOME_MID,
      url: homeUrl(),
      label: "",
      ord: 0,
      role: "home",
      cred: false,
      added: 0,
      ts: 0,
      del: false,
   }
}

// A human label for a mount: the operator's label if set, else the URL host
// (the picker never shows a raw hash id).
export function mountLabel(m: MountRecord): string {
   if (m.label) return m.label
   if (m.id === HOME_MID) return "Home"
   try {
      return new URL(m.url).host
   } catch {
      return m.url
   }
}

// --- storage --------------------------------------------------------------

function parseRecords(raw: string | null): MountRecord[] {
   if (!raw) return []
   try {
      const arr = JSON.parse(raw) as unknown
      if (!Array.isArray(arr)) return []
      const out: MountRecord[] = []
      for (const r of arr) {
         const rec = coerceRecord(r)
         if (rec) out.push(rec)
      }
      return out
   } catch {
      return []
   }
}

// Coerce one untrusted record (localStorage or a synced blob) into a well-formed
// MountRecord, or null. Tolerant of missing optional fields; strict on id/url.
function coerceRecord(r: unknown): MountRecord | null {
   if (typeof r !== "object" || r === null || Array.isArray(r)) return null
   const o = r as Record<string, unknown>
   if (typeof o.id !== "string" || !o.id) return null
   if (typeof o.url !== "string" || !o.url) return null
   const role = o.role === "home" ? "home" : "peer"
   const rec: MountRecord = {
      id: o.id,
      url: o.url,
      label: typeof o.label === "string" ? o.label : "",
      ord: typeof o.ord === "number" && Number.isFinite(o.ord) ? o.ord : 0,
      role,
      cred: o.cred === true,
      added: typeof o.added === "number" && Number.isFinite(o.added) ? Math.floor(o.added) : 0,
      ts: typeof o.ts === "number" && Number.isFinite(o.ts) ? Math.floor(o.ts) : 0,
      del: o.del === true,
   }
   if (typeof o.moved_to === "string" && o.moved_to) rec.moved_to = o.moved_to
   return rec
}

// Load the persisted mount table, ALWAYS with a coherent home record present.
// Absent (a fresh single-store user) ⇒ the synthesized one-record table (§3.3),
// which reproduces today's behavior exactly. A stored table missing its home
// record (corruption) gets one synthesized back so the reader always has a home
// lane.
export function loadMounts(): MountRecord[] {
   let recs: MountRecord[]
   try {
      recs = parseRecords(localStorage.getItem(MOUNTS_KEY))
   } catch {
      recs = []
   }
   return ensureHome(recs)
}

// Guarantee exactly one home record (id "0", role "home", the build's URL). Any
// stored home record keeps its label/ord/ts but is re-pointed at the current
// build URL (the home mount tracks SRR_CDN_URL, never a stale stored URL — §3.2).
function ensureHome(recs: MountRecord[]): MountRecord[] {
   const out = recs.filter((r) => r.id !== HOME_MID)
   const storedHome = recs.find((r) => r.id === HOME_MID)
   const home = homeRecord()
   if (storedHome) {
      home.label = storedHome.label
      home.ord = storedHome.ord
      home.ts = storedHome.ts
      home.added = storedHome.added
   }
   out.unshift(home)
   return out
}

export function saveMounts(recs: MountRecord[]): void {
   try {
      localStorage.setItem(MOUNTS_KEY, JSON.stringify(recs))
   } catch {
      // quota — best-effort, like pin.ts
   }
}

// The mounts the picker/boot actually use: non-deleted, sorted home-first then
// by ord then added (a stable, coordination-free order across devices).
export function activeMounts(recs: MountRecord[] = loadMounts()): MountRecord[] {
   return recs
      .filter((r) => !r.del)
      .sort((a, b) => {
         if (a.role !== b.role) return a.role === "home" ? -1 : 1
         if (a.ord !== b.ord) return a.ord - b.ord
         if (a.added !== b.added) return a.added - b.added
         return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
}

// --- OR-set merge (§3.4) --------------------------------------------------

// Merge two mount tables as an add/remove set with LWW records. Pure — no
// storage, no key renames (those are side effects the caller applies from
// reconcileMounts). Rules, per id:
//   1. union by id
//   2. both present ⇒ the strictly greater `ts` wins WHOLESALE
//   3. equal `ts` ⇒ the DELETED record wins (removal is conservative)
//   4. a tombstone is retained forever
// The home record is always forced back afterward so a peer can never delete or
// re-point the home lane (§3.2).
export function mergeMountRecords(local: MountRecord[], incoming: MountRecord[]): MountRecord[] {
   const byId = new Map<string, MountRecord>()
   for (const r of local) byId.set(r.id, r)
   for (const r of incoming) {
      const cur = byId.get(r.id)
      if (!cur) {
         byId.set(r.id, r)
         continue
      }
      if (r.ts > cur.ts) byId.set(r.id, r)
      else if (r.ts === cur.ts && r.del && !cur.del) byId.set(r.id, r) // tie → deleted wins
      // else keep cur
   }
   return ensureHome([...byId.values()])
}

// --- home-collision + rename reconciliation (§3.2, §3.5) ------------------

// A rename to apply to this device's per-store localStorage keys: move every
// `…@<from>` key to `…@<to>` (to = HOME_MID for a home-collision collapse).
export interface PendingRename {
   from: string
   to: string
}

// Reconcile a merged mount set against this device's HOME url and any rename
// tombstones (§3.2 home-collision, §3.5 re-hosting). Returns the reconciled
// record set PLUS the key renames the caller must replay. Idempotent: a device
// that already collapsed a collision (holds only the tombstone, no source
// state) produces no rename the second time.
//
//   • Home-collision: a LIVE peer record whose normalized url equals the home
//     url is collapsed into mount 0 — replaced by a tombstone carrying
//     moved_to:"0", and its `…@s<A>` state is renamed onto the bare home keys.
//   • Re-host: a tombstone carrying moved_to that this device still has live
//     `…@<from>` state for triggers the same deterministic rename before the
//     substate merge, so peers replay a §3.5 migration identically.
export function reconcileMounts(recs: MountRecord[]): { records: MountRecord[]; renames: PendingRename[] } {
   const home = homeUrl()
   const renames: PendingRename[] = []
   const out: MountRecord[] = []
   for (const r of recs) {
      if (r.id !== HOME_MID && !r.del && normalizeStoreUrl(r.url) === home) {
         // A peer mount pointing at the home store: collapse into mount 0.
         if (hasStoreState(r.id)) renames.push({ from: r.id, to: HOME_MID })
         out.push({ ...r, del: true, moved_to: HOME_MID, ts: Math.max(r.ts, nowSec()) })
         continue
      }
      if (r.del && r.moved_to && r.moved_to !== r.id && hasStoreState(r.id)) {
         // A rename tombstone we still hold source state for: replay the move.
         renames.push({ from: r.id, to: r.moved_to })
      }
      out.push(r)
   }
   return { records: ensureHome(out), renames }
}

// The five per-store localStorage keys for a mount id (keys.ts). HOME_MID maps
// to the bare legacy names; every other id is suffixed `@<mid>`.
function storeStateKeys(mid: string): string[] {
   return [seenKey(mid), seenTsKey(mid), savedKey(mid), pinsKey(mid), profileTsKey(mid)]
}

// True when this device holds ANY per-store state under `mid` — the guard that
// makes reconcileMounts idempotent (once state is renamed away, no second move).
function hasStoreState(mid: string): boolean {
   try {
      return storeStateKeys(mid).some((k) => localStorage.getItem(k) !== null)
   } catch {
      return false
   }
}

// Move every per-store key from one mid to another (§3.5 step 1). On a
// collision the destination (home) keys may already exist; the source wins
// (it is the reading history the user asked to keep by mounting the URL). A
// missing source key leaves the destination untouched.
export function renameStoreState(from: string, to: string): void {
   const src = storeStateKeys(from)
   const dst = storeStateKeys(to)
   for (let i = 0; i < src.length; i++) {
      try {
         const v = localStorage.getItem(src[i])
         if (v !== null) {
            localStorage.setItem(dst[i], v)
            localStorage.removeItem(src[i])
         }
      } catch {
         // quota / access — best-effort
      }
   }
}

// Delete every per-store key for a mid — the destructive "Remove and forget
// this store's reading history" action (§3.4). Ordinary unmount does NOT call
// this; only the explicit forget path does.
export function forgetStoreState(mid: string): void {
   for (const k of storeStateKeys(mid)) {
      try {
         localStorage.removeItem(k)
      } catch {}
   }
}

// --- local mutations (each stamps ts = now on the touched record, §3.4.5) --

// Add (or re-add) a mount for a normalized URL. Returns the id, or null if the
// URL is not mountable. Re-adding a tombstoned id revives it (fresh ts).
export function addMount(
   recs: MountRecord[],
   input: string,
   label = "",
   cred = false,
): { records: MountRecord[]; id: string } | null {
   const url = normalizeStoreUrl(input)
   if (!url) return null
   if (url === homeUrl()) return { records: recs, id: HOME_MID } // already mount 0
   const id = mountId(url)
   const now = nowSec()
   const existing = recs.find((r) => r.id === id)
   const maxOrd = recs.reduce((m, r) => (r.ord > m ? r.ord : m), 0)
   const rec: MountRecord = {
      id,
      url,
      label,
      ord: existing?.ord ?? maxOrd + 10,
      role: "peer",
      cred,
      added: existing && existing.added ? existing.added : now,
      ts: now,
      del: false,
   }
   const others = recs.filter((r) => r.id !== id)
   return { records: [...others, rec], id }
}

// Tombstone a mount (unmount — does NOT delete read state, §3.4). The home
// mount cannot be removed.
export function removeMount(recs: MountRecord[], id: string): MountRecord[] {
   if (id === HOME_MID) return recs
   return recs.map((r) => (r.id === id ? { ...r, del: true, ts: nowSec() } : r))
}

// Edit a mount's presentation fields (label / ord / cred). Bumps ts.
export function editMount(
   recs: MountRecord[],
   id: string,
   patch: Partial<Pick<MountRecord, "label" | "ord" | "cred">>,
): MountRecord[] {
   return recs.map((r) => (r.id === id ? { ...r, ...patch, ts: nowSec() } : r))
}

// Re-host migration (§3.5): mounting URL B while mount s<A> exists, keeping the
// reading history. Writes both records with a fresh ts (s<A> as a rename
// tombstone → s<B>, s<B> live) and renames the local `…@s<A>` keys to `…@s<B>`.
export function moveMount(
   recs: MountRecord[],
   fromId: string,
   toInput: string,
): { records: MountRecord[]; id: string } | null {
   const url = normalizeStoreUrl(toInput)
   if (!url) return null
   const toId = mountId(url)
   if (toId === fromId) return { records: recs, id: toId }
   renameStoreState(fromId, toId)
   const now = nowSec()
   const from = recs.find((r) => r.id === fromId)
   const others = recs.filter((r) => r.id !== fromId && r.id !== toId)
   const tomb: MountRecord = {
      ...(from ?? homeRecord()),
      id: fromId,
      role: "peer",
      del: true,
      moved_to: toId,
      ts: now,
   }
   const live: MountRecord = {
      id: toId,
      url,
      label: from?.label ?? "",
      ord: from?.ord ?? recs.reduce((m, r) => (r.ord > m ? r.ord : m), 0) + 10,
      role: "peer",
      cred: from?.cred ?? false,
      added: now,
      ts: now,
      del: false,
   }
   return { records: [...others, tomb, live], id: toId }
}
