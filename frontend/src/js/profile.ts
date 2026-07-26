// profile.ts — portable profile export/import.
// Bundles the device-local state that is meaningful on another device:
// srr-seen, srr-saved, srr-unread-only, srr-img-proxy.
// Explicitly EXCLUDES srr-hash (device-local reading cursor).
//
// This module reads/writes localStorage directly via keys.ts (a side-effect-free
// constants module) rather than importing nav.ts or fmt.ts — that avoids pulling
// in data.ts's eager db.gz fetch as a side effect, which makes the module
// unit-testable without a running pack server.
//
// Import strategy — two modes, sharing ONE per-key seen rule:
//   seen — per-key LWW by the `st` (seen-ts) side map, falling back to
//      Math.max() when either side lacks a key's timestamp. `st` stamps the
//      unix-second of each key's last LOCAL mutation (nav.ts writes it beside
//      every seen write), so a key whose incoming timestamp is strictly newer
//      wins IN EITHER DIRECTION — that's what lets an explicit "mark unread
//      from here" rewind (nav.markUnreadFrom) survive the next pull instead of
//      being re-raised by a max-merge. Keys without a timestamp on both sides
//      (v1 blobs, pre-upgrade v2 blobs, pre-upgrade local state) keep the
//      legacy raise-only max — an implicit rewind still cannot happen; only
//      the explicit, freshly-stamped kind propagates. Adopting a remote value
//      adopts its timestamp verbatim (never re-stamped to now — the ordering
//      belongs to the device where the person acted).
//   merge (default; always for v1 — file restores) —
//      seen  — the per-key rule above
//      saved — union preserving local save order, appending new incoming saves
//              (monotone on purpose: a restore adds back, it never deletes)
//      prefs — last-writer-wins, gated by opts.prefs (opt-in checkbox)
//   sync (mode:"sync" + v2 — a sync.ts pull) — the one-reader hybrid:
//      seen  — the per-key rule above, but WITHOUT stamping `ts`: the change
//              came from the remote, not from a local user action, and
//              stamping would make this device "newest" and steal the saved-LWW
//              ordering from the device where the person actually acted (same
//              reasoning as the prefs-don't-stamp rule on profileTs below).
//      saved+sd — per-key LWW by the `sd` (saved-ts) side map over a blob-level
//              base (RDR18, mergeSaved below): the base is the old rule — a
//              strictly newer blob's array replaces local wholesale, so
//              un-saves propagate — and each chron whose stamps differ then
//              overrides it in either direction. That is what makes a save on
//              one device concurrent with an un-save on another converge to
//              the newer INTENT rather than to the newer BLOB, which used to
//              lose one of the two. `ts` still converges to max(local, blob)
//              and still decides the queue ORDER; per-key stamps decide only
//              membership. A blob with no `sd` at all merges exactly as before.
//      prefs — gated by opts.prefs exactly as in merge mode; sync.ts just
//      always passes prefs:false (see profileTs's comment below for why).
// The ONLY path that can LOWER seen is a strictly newer per-key `st` — the
// explicit rewind a person asked for on some device. Everything else stays
// raise-only: all devices belong to one reader, whose read state is the union
// of what they read anywhere plus their latest explicit rewinds.
// Both stamp maps obey the same adoption rule: taking a side's value takes its
// stamp VERBATIM — never re-stamped to now, because the ordering belongs to the
// device where the person acted.

import {
   HOME_MID,
   IMG_PROXY_KEY,
   profileTsKey,
   savedKey,
   savedTsKey,
   seenKey,
   seenTsKey,
   UNREAD_ONLY_KEY,
} from "./keys"
import {
   loadMounts,
   mergeMountRecords,
   reconcileMounts,
   renameStoreState,
   saveMounts,
   type MountRecord,
} from "./mounts"
import { isValidHttpish, normalizeHttpish } from "./urlish"

// The portable profile is the HOME store's device state (the blob's top-level
// fields are mount 0's, per docs/MULTI-STORE-SPEC.md §4.4; peer-store substate
// rides the additive `ms` map that S38 adds). So the keys here resolve to the
// bare legacy names via HOME_MID — a single-store user's blob is unchanged.
const SEEN_KEY = seenKey(HOME_MID)
const SEEN_TS_KEY = seenTsKey(HOME_MID)
const PROFILE_TS_KEY = profileTsKey(HOME_MID)
// The saved pair has no constants of its own: mergeSaved and its readers are
// parameterized by mount id (the home store just passes HOME_MID), so one body
// serves both the top-level fields and every peer substate.

function lsGet(key: string): string {
   try {
      return localStorage.getItem(key) ?? ""
   } catch {
      return ""
   }
}

function lsSet(key: string, value: string): void {
   try {
      localStorage.setItem(key, value)
   } catch {}
}

function readSeen(): Record<string, number> {
   try {
      const raw = lsGet(SEEN_KEY)
      return raw ? JSON.parse(raw) : {}
   } catch {
      return {}
   }
}

// The per-key seen timestamps (srr-seen-ts): unix-second of each seen key's
// last local mutation, written by nav.ts beside every seen write. Absent key
// == 0 == "no ordering information" (pre-upgrade state) — merges fall back to
// the legacy raise-only max for it.
function readSeenTs(): Record<string, number> {
   try {
      const raw = lsGet(SEEN_TS_KEY)
      return raw ? JSON.parse(raw) : {}
   } catch {
      return {}
   }
}

// Parse an incoming st-shaped value (a blob's `st` field) into a clean map;
// anything malformed degrades to {} (every key then merges by legacy max).
function cleanTsMap(incoming: unknown): Record<string, number> {
   const out: Record<string, number> = {}
   if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) return out
   for (const [k, v] of Object.entries(incoming as Record<string, unknown>))
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.floor(v)
   return out
}

// Save order (insertion order as stored), NOT sorted: the ★ Saved queue is read
// front-to-back and new saves append, so the order is meaningful and travels in
// the blob. Deduped (first occurrence wins) to survive a hand-edited endpoint.
function readSavedOrder(mid = HOME_MID): number[] {
   try {
      const raw = lsGet(savedKey(mid))
      const arr = raw ? JSON.parse(raw) : []
      const ints = Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : []
      return [...new Set(ints)] as number[]
   } catch {
      return []
   }
}

// ── ★ Saved: the per-key stamps (`sd`, srr-saved-ts) — RDR18 ─────────────────
// The saved-set cousin of `st`: unix-second of each chron's last local
// membership mutation, stamped by saved.ts beside every srr-saved write. A
// chron is stamped whether it was saved or UN-saved — an un-save leaves a
// TOMBSTONE, and that is the entire point. Without one, a save on device A and
// an un-save on device B are indistinguishable at merge time and the blob-level
// `ts` silently drops whichever device's blob was older.
function readSavedTs(mid = HOME_MID): Record<string, number> {
   return cleanTsMap(parseAny(lsGet(savedTsKey(mid))))
}

// Tombstone cap. A MEMBER's stamp is never dropped (it is what defends a save
// against a peer's older un-save); only tombstones — stamps for chrons not in
// the set — are bounded, newest first, ties broken by chron so two devices
// holding the same union prune to the SAME map. That determinism matters: a
// prune the two sides disagree on reads as "the endpoint is behind" on both,
// and would ping-pong a push between them until they converge.
const SAVED_TOMBSTONE_CAP = 1024

function capSavedTs(sd: Record<string, number>, members: Set<number>): Record<string, number> {
   const tombs = Object.keys(sd).filter((k) => !members.has(Number(k)))
   if (tombs.length <= SAVED_TOMBSTONE_CAP) return sd
   tombs.sort((a, b) => sd[b] - sd[a] || Number(a) - Number(b))
   const out = { ...sd }
   for (const k of tombs.slice(SAVED_TOMBSTONE_CAP)) delete out[k]
   return out
}

// The PRUNED view of one mount's saved stamps — what exportProfile publishes
// AND what sync.ts's push trigger compares against. The two must be the same
// map: a stamp the trigger counts as local-only but the push never sends would
// re-fire the trigger on every single cycle.
function savedTsView(mid = HOME_MID): Record<string, number> {
   return capSavedTs(readSavedTs(mid), new Set(readSavedOrder(mid)))
}

// Order-independent equality for the stamp maps, so a merge that only reshuffled
// key order doesn't rewrite localStorage on every cycle.
function sameTsMap(a: Record<string, number>, b: Record<string, number>): boolean {
   const ak = Object.keys(a)
   if (ak.length !== Object.keys(b).length) return false
   return ak.every((k) => a[k] === b[k])
}

// The incoming `sd` map, or null when the blob carried NONE — the signal that
// its writer predates per-key saved stamps (a v1 blob, or a v2 from an older
// build). null is NOT the same as `{}`: an empty map is a stamps-aware device
// that has simply never saved anything, and its absent stamps legitimately
// count as 0 in the per-key comparison.
function tsMapOrNull(v: unknown): Record<string, number> | null {
   if (v === null || typeof v !== "object" || Array.isArray(v)) return null
   return cleanTsMap(v)
}

// Union preserving `order`, appending members of `incoming` it lacks — the
// merge-mode saved rule, shared by the home store and every peer substate.
function appendNew(order: number[], incoming: number[]): number[] {
   const out = [...order]
   const have = new Set(order)
   for (const n of incoming)
      if (!have.has(n)) {
         have.add(n)
         out.push(n)
      }
   return out
}

// The ★ Saved merge — ONE body for both import modes and every mount (RDR18).
//
// Two layers, and their order IS the interop story:
//
//  1. `base` is EXACTLY what this merge did before per-key stamps existed:
//     sync mode takes the blob's array wholesale when its `ts` is strictly
//     newer (so un-saves propagate) and keeps local otherwise; merge mode
//     unions, local order first, incoming appended. A blob carrying no `sd`
//     map — v1, or a v2 written by an older build — never reaches layer 2, so
//     it merges exactly as it always did. That is the whole backwards-interop
//     contract, and like `st` it needs no version bump: `sd` is additive, and
//     an old build reading a new blob just ignores a field it does not know.
//
//  2. In SYNC mode, where both the incoming array and its `sd` map are
//     present, each chron's membership is decided by the strictly newer of the
//     two stamps —
//     independently per key, in either direction. A save on A concurrent with
//     an un-save on B now converges to the newer INTENT instead of to whichever
//     blob happened to carry the newer `ts`, and two concurrent saves of
//     DIFFERENT articles both survive (each is stamped on exactly one side, and
//     an absent stamp reads as 0). A chron unstamped on both sides — state from
//     before the upgrade — falls through to base, where the blob-level rule
//     still governs because there is no finer ordering to be had.
//
// ORDER is load-bearing (★ Saved is a read-later queue consumed front-to-back),
// and coexists with per-key stamps like this: the merged queue is `base`'s
// order with non-members filtered out, then the chrons layer 2 ADDED appended
// in the other side's order. So the sequence always comes from the blob-level
// winner while per-key stamps decide only WHO is in the queue. Two devices
// merging the same pair of blobs therefore compute the same queue — base is
// "the newer-`ts` array" on both sides and the appended tail is "the older-`ts`
// array's order" on both — and a hand-curated reading order is never scrambled
// by making the set mergeable. (A blob-level `ts` TIE keeps each device's own
// order, as it always has; membership still converges per key.)
//
// Returns whether the SET actually moved. A stamp-only convergence is not a
// change — the ImportResult.changed contract is about what the UI shows.
function mergeSaved(
   mid: string,
   incomingRaw: unknown,
   incomingSd: Record<string, number> | null,
   mode: "merge" | "sync",
   adoptBlob: boolean,
): boolean {
   try {
      const order = readSavedOrder(mid)
      const localSet = new Set(order)
      const sd = readSavedTs(mid)
      // Only a well-formed array is an opinion about the set. A newer blob that
      // OMITS or malforms `saved` (a truncated keepalive PUT, a hand-edited
      // endpoint) must not zero the local star collection — a genuine
      // un-save-everything still arrives as `saved: []`, an array.
      const incoming = Array.isArray(incomingRaw)
         ? ([
              ...new Set((incomingRaw as unknown[]).filter((n) => Number.isInteger(n) && (n as number) >= 0)),
           ] as number[])
         : null
      const inSet = new Set(incoming ?? [])

      // Layer 1 — the pre-stamps behaviour, unchanged.
      const tookBlob = mode === "sync" && adoptBlob && incoming !== null
      let base: number[]
      if (tookBlob)
         base = incoming! // sync + strictly newer blob: it replaces the set wholesale
      else if (mode === "sync" || !incoming)
         base = order // sync but older/tied, or no opinion at all
      else base = appendNew(order, incoming) // merge (file restore): the union, local order first
      const members = new Set(base)

      // Layer 2 — per-key LWW, only in sync mode and only against a
      // stamps-aware blob. Merge mode is deliberately excluded: its base is
      // already the union, so the only thing layer 2 could do there is DELETE,
      // and a file restore must never delete (see the mode note above).
      if (mode === "sync" && incoming !== null && incomingSd !== null) {
         for (const k of savedKeyUnion(order, incoming, sd, incomingSd)) {
            const lt = sd[k] ?? 0
            const rt = incomingSd[k] ?? 0
            if (lt === rt) continue // no finer ordering — base's verdict stands
            if (rt > lt ? inSet.has(k) : localSet.has(k)) members.add(k)
            else members.delete(k)
         }
      }

      // Order: base's survivors, then layer-2's additions in the other side's
      // order (a member can only come from one of the two arrays, so this is
      // total).
      const next = base.filter((k) => members.has(k))
      const placed = new Set(next)
      for (const k of tookBlob ? order : (incoming ?? []))
         if (members.has(k) && !placed.has(k)) {
            next.push(k)
            placed.add(k)
         }

      // Stamps: adopt VERBATIM from whichever side's membership the merge took —
      // never re-stamped to now, since the ordering belongs to the device where
      // the person acted. When both sides agree on membership, the newer of the
      // two stamps is taken (still a verbatim adoption, and it is what converges
      // the ordering across the fleet). A stamp whose side LOST is dropped: a
      // stamp that contradicts the membership it sits beside would answer the
      // next merge's question wrongly.
      const nextSd: Record<string, number> = {}
      for (const k of savedKeyUnion(order, incoming ?? [], sd, incomingSd ?? {})) {
         const merged = members.has(k)
         let s = 0
         if (localSet.has(k) === merged) s = Math.max(s, sd[k] ?? 0)
         if (incoming !== null && inSet.has(k) === merged) s = Math.max(s, incomingSd?.[k] ?? 0)
         if (s > 0) nextSd[k] = s
      }
      const capped = capSavedTs(nextSd, members)

      let changed = false
      if (JSON.stringify(next) !== JSON.stringify(order)) {
         lsSet(savedKey(mid), JSON.stringify(next))
         changed = true
      }
      if (!sameTsMap(capped, sd)) lsSet(savedTsKey(mid), JSON.stringify(capped))
      return changed
   } catch {
      return false
   }
}

// Every chron either side holds an opinion about: a member of either set, or a
// stamp in either map. Non-numeric keys from a hand-edited blob are dropped.
function savedKeyUnion(
   a: number[],
   b: number[],
   aTs: Record<string, number>,
   bTs: Record<string, number>,
): Set<number> {
   const out = new Set<number>([...a, ...b])
   for (const map of [aTs, bTs])
      for (const k of Object.keys(map)) {
         const n = Number(k)
         if (Number.isInteger(n)) out.add(n)
      }
   return out
}

// The LWW ordering field: unix seconds of the last local seen/saved mutation
// (0 = never). Pref changes deliberately do NOT stamp it — prefs are never
// applied on pull, so a mere pref flip must not make this device "newest" and
// cost another device its real progress on the next adoption.
export function profileTs(): number {
   const n = Number(lsGet(PROFILE_TS_KEY))
   return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function touchProfile(now = Math.floor(Date.now() / 1000)): void {
   lsSet(PROFILE_TS_KEY, String(now))
}

// The parsed local seen map — sync.ts's regression guard compares blobs by it.
export function localSeen(): Record<string, number> {
   return readSeen()
}

// The parsed per-key seen timestamps — sync.ts's behind/guard comparisons pair
// them with localSeen().
export function localSeenTs(): Record<string, number> {
   return readSeenTs()
}

// The per-key SAVED stamps, pruned exactly as exportProfile publishes them —
// sync.ts's saved-axis push trigger compares this against the pulled blob's
// `sd`. It must be the published view, or the trigger would keep reporting a
// stamp the push never carries (see savedTsView).
export function localSavedTs(): Record<string, number> {
   return savedTsView(HOME_MID)
}

export interface ImportResult {
   ok: boolean
   error?: string
   // seen or saved actually mutated. A ts-only convergence (newer blob with
   // identical saved and no seen raise) is NOT a change — nothing the UI shows
   // moved, so callers must not re-render or re-anchor on it. Also true when the
   // mount table moved (mountsChanged below folds in), so a merge that ONLY
   // changed `mnt` still fires the caller's after-merge refresh.
   changed?: boolean
   // The `mnt` mount table actually moved (a peer mounted/unmounted/renamed on
   // another device). Reported SEPARATELY from `changed` so the caller can
   // re-adopt the table into data.ts (boot the new root, SW-route it, repaint
   // the picker) only when it really changed — see app.ts's refreshAfterMerge.
   mountsChanged?: boolean
}

// seen — the per-key rule shared verbatim by both import modes: a key whose
// incoming `st` timestamp is strictly newer than the local one wins in either
// direction (raise or explicit rewind); a key without a timestamp on either
// side falls back to the legacy one-way max. Adopting an incoming value adopts
// its timestamp verbatim (or drops the local one when the incoming side has
// none — the value's ordering is then genuinely unknown). Returns whether any
// seen VALUE actually changed (timestamp-only convergence is not a change).
function mergeSeen(incoming: unknown, incomingTs: Record<string, number>): boolean {
   try {
      if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) return false
      const existing = readSeen()
      const existingTs = readSeenTs()
      let changed = false
      let tsChanged = false
      for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
         if (typeof v !== "number" || !Number.isFinite(v)) continue
         const localV = existing[k]
         const localTs = existingTs[k] ?? 0
         const remoteTs = incomingTs[k] ?? 0
         // Both sides carry ordering info and disagree → strict LWW (this is
         // the one path that can lower a value: an explicit rewind). Otherwise
         // legacy raise-only max — and when the max ADOPTS the incoming value,
         // its timestamp (or lack of one) comes along.
         const adopt = localTs > 0 && remoteTs > 0 && remoteTs !== localTs ? remoteTs > localTs : v > (localV ?? -1) // tie or no ordering → one-way raise
         if (!adopt) continue
         if (v !== localV) {
            existing[k] = v
            changed = true
         }
         if (remoteTs !== localTs) {
            if (remoteTs > 0) existingTs[k] = remoteTs
            else delete existingTs[k]
            tsChanged = true
         }
      }
      if (changed) lsSet(SEEN_KEY, JSON.stringify(existing))
      if (tsChanged) lsSet(SEEN_TS_KEY, JSON.stringify(existingTs))
      return changed
   } catch {
      return false
   }
}

// ── Multi-store: the mount table (`mnt`) + per-peer substate (`ms`), §4.4 ──────
// Both additive: an old build pulls the blob, ignores mnt/ms, and merges the
// HOME store exactly as today. The home store's wire shape (top-level
// seen/st/saved/ts) does NOT move — it stays mount 0's, so a single-store user's
// blob is byte-identical. `ms` carries the PEER stores' substate (mid != "0"),
// each merged by the SAME rules applied per store.

interface StoreSubstate {
   ts: number
   seen: Record<string, number>
   st: Record<string, number>
   saved: number[]
   sd: Record<string, number>
}

// Read one mount's substate from its namespaced keys (seen@mid / st@mid /
// saved@mid / profile-ts@mid). Returns null when the store holds nothing local.
function readSubstate(mid: string): StoreSubstate | null {
   const seen = parseMap(lsGet(seenKey(mid)))
   const st = cleanTsMap(parseAny(lsGet(seenTsKey(mid))))
   const saved = parseIntArray(lsGet(savedKey(mid)))
   const tsN = Number(lsGet(profileTsKey(mid)))
   const ts = Number.isFinite(tsN) && tsN > 0 ? Math.floor(tsN) : 0
   if (Object.keys(seen).length === 0 && saved.length === 0 && ts === 0) return null
   return { ts, seen, st, saved, sd: savedTsView(mid) }
}

function parseMap(raw: string): Record<string, number> {
   try {
      const o = raw ? (JSON.parse(raw) as unknown) : {}
      if (o === null || typeof o !== "object" || Array.isArray(o)) return {}
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(o as Record<string, unknown>))
         if (typeof v === "number" && Number.isFinite(v)) out[k] = v
      return out
   } catch {
      return {}
   }
}
function parseAny(raw: string): unknown {
   try {
      return raw ? JSON.parse(raw) : {}
   } catch {
      return {}
   }
}
function parseIntArray(raw: string): number[] {
   try {
      const a = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(a)
         ? [...new Set(a.filter((n) => Number.isInteger(n) && (n as number) >= 0) as number[])]
         : []
   } catch {
      return []
   }
}

// Merge one incoming peer substate into a mount's namespaced keys, by the SAME
// rules as the home store: seen+st per-key LWW (mergeSeenMid) and saved+sd
// through the shared mergeSaved (per-key LWW over the blob-level base, or the
// union in merge mode). `mid` is never HOME_MID here (home rides the top-level
// fields). Returns whether anything actually changed.
function mergeSubstate(mid: string, sub: unknown, mode: "merge" | "sync"): boolean {
   if (!sub || typeof sub !== "object" || Array.isArray(sub)) return false
   const o = sub as Record<string, unknown>
   const incomingSt = cleanTsMap(o["st"])
   let changed = mergeSeenMid(mid, o["seen"], incomingSt)
   const tsRaw = o["ts"]
   const blobTs = typeof tsRaw === "number" && Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : 0
   const localTs = readSubstate(mid)?.ts ?? 0
   if (mergeSaved(mid, o["saved"], tsMapOrNull(o["sd"]), mode, blobTs > localTs)) changed = true
   // The blob-level ordering field still converges to max, and still only in
   // sync mode — a peer store's ts is its own, never the home store's.
   if (mode === "sync" && blobTs > localTs) lsSet(profileTsKey(mid), String(blobTs))
   return changed
}

// mergeSeenMid is mergeSeen for a mount id's namespaced keys — the same per-key
// LWW rule (strictly-newer st wins in either direction, else raise-only max).
function mergeSeenMid(mid: string, incoming: unknown, incomingTs: Record<string, number>): boolean {
   try {
      if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) return false
      const existing = parseMap(lsGet(seenKey(mid)))
      const existingTs = cleanTsMap(parseAny(lsGet(seenTsKey(mid))))
      let changed = false
      let tsChanged = false
      for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
         if (typeof v !== "number" || !Number.isFinite(v)) continue
         const localV = existing[k]
         const localTs = existingTs[k] ?? 0
         const remoteTs = incomingTs[k] ?? 0
         const adopt = localTs > 0 && remoteTs > 0 && remoteTs !== localTs ? remoteTs > localTs : v > (localV ?? -1)
         if (!adopt) continue
         if (v !== localV) {
            existing[k] = v
            changed = true
         }
         if (remoteTs !== localTs) {
            if (remoteTs > 0) existingTs[k] = remoteTs
            else delete existingTs[k]
            tsChanged = true
         }
      }
      if (changed) lsSet(seenKey(mid), JSON.stringify(existing))
      if (tsChanged) lsSet(seenTsKey(mid), JSON.stringify(existingTs))
      return changed
   } catch {
      return false
   }
}

// The peer substate map for export: every non-home mount (tombstones included,
// so unmounted-not-forgotten state still propagates — §3.4) that holds any local
// state. `mnt` is the whole mount table (records + tombstones).
function exportMountState(): { mnt: MountRecord[]; ms: Record<string, StoreSubstate> } {
   const mnt = loadMounts()
   const ms: Record<string, StoreSubstate> = {}
   for (const m of mnt) {
      if (m.id === HOME_MID) continue
      const sub = readSubstate(m.id)
      if (sub) ms[m.id] = sub
   }
   return { mnt, ms }
}

// True when this device holds any MULTI-STORE state to propagate — a live peer
// mount or peer substate. sync.ts uses it to decide the one-time upgrade push
// against an mnt-less (old-build) endpoint: a pure single-store device has
// nothing to add and stays quiet (§4.4).
export function hasPeerState(): boolean {
   const { mnt, ms } = exportMountState()
   return mnt.some((m) => m.id !== HOME_MID && !m.del) || Object.keys(ms).length > 0
}

// exportProfile serialises all four portable keys plus the LWW `ts` and the two
// per-key ordering maps — `st` (seen) and `sd` (saved) — into a v:2 blob. Both
// are additive, so old builds ignore them and keep their coarser rules and the
// version needs no bump. The multi-store `mnt`/`ms` (§4.4) ride along, also
// additive. srr-hash is never included.
export function exportProfile(): string {
   const seen = readSeen()
   const saved = readSavedOrder()
   const unreadOnly = lsGet(UNREAD_ONLY_KEY) === "1"
   const imgProxy = lsGet(IMG_PROXY_KEY)
   const { mnt, ms } = exportMountState()
   return JSON.stringify({
      v: 2,
      ts: profileTs(),
      seen,
      st: readSeenTs(),
      saved,
      sd: savedTsView(HOME_MID),
      unreadOnly,
      imgProxy,
      mnt,
      ms,
   })
}

// Merge the incoming blob's mount table + peer substate (§4.4). Applied by
// importProfile after the HOME store merge. Returns whether anything changed
// (so the caller re-adopts the mount table + repaints). mnt merges FIRST (per
// §3.4) so a rename tombstone renames the peer's `…@mid` state before its `ms`
// is merged onto the new id.
function mergeMountState(obj: Record<string, unknown>, mode: "merge" | "sync"): boolean {
   let changed = false
   if (Array.isArray(obj["mnt"])) {
      const incoming = (obj["mnt"] as unknown[]).map(coerceMountRecord).filter((r): r is MountRecord => r !== null)
      // A modern build ALWAYS writes `mnt` (exportProfile → ensureHome ⇒ never
      // empty), so this branch runs on essentially every pull. Only report a
      // change when the table actually MOVED — an identical mnt round-trip must
      // report changed:false, or every sync cycle would spuriously re-anchor the
      // list (the ImportResult.changed contract: seen/saved actually mutated).
      const before = loadMounts()
      const merged = mergeMountRecords(before, incoming)
      const { records, renames } = reconcileMounts(merged)
      for (const r of renames) renameStoreState(r.from, r.to)
      if (renames.length > 0 || JSON.stringify(records) !== JSON.stringify(before)) {
         saveMounts(records)
         changed = true
      }
   }
   const ms = obj["ms"]
   if (ms && typeof ms === "object" && !Array.isArray(ms)) {
      for (const [mid, sub] of Object.entries(ms as Record<string, unknown>)) {
         if (mid === HOME_MID) continue
         if (mergeSubstate(mid, sub, mode)) changed = true
      }
   }
   return changed
}

// A lenient coercion of one untrusted mnt record (mirrors mounts.ts's internal
// one, which is not exported). Strict on id/url; tolerant elsewhere.
function coerceMountRecord(r: unknown): MountRecord | null {
   if (typeof r !== "object" || r === null || Array.isArray(r)) return null
   const o = r as Record<string, unknown>
   if (typeof o["id"] !== "string" || !o["id"] || typeof o["url"] !== "string" || !o["url"]) return null
   const rec: MountRecord = {
      id: o["id"],
      url: o["url"],
      label: typeof o["label"] === "string" ? o["label"] : "",
      ord: typeof o["ord"] === "number" && Number.isFinite(o["ord"]) ? o["ord"] : 0,
      role: o["role"] === "home" ? "home" : "peer",
      cred: o["cred"] === true,
      added: typeof o["added"] === "number" && Number.isFinite(o["added"]) ? Math.floor(o["added"] as number) : 0,
      ts: typeof o["ts"] === "number" && Number.isFinite(o["ts"]) ? Math.floor(o["ts"] as number) : 0,
      del: o["del"] === true,
   }
   if (typeof o["moved_to"] === "string" && o["moved_to"]) rec.moved_to = o["moved_to"]
   return rec
}

// importProfile parses `json` and applies it to the current device's state.
// Returns {ok:false, error} without mutating anything if the blob is invalid.
// Two modes (see the "Import strategy" note above):
//   merge (default; always for v1) —
//      seen   — for each incoming key, take Math.max(existing ?? -1, incoming)
//      saved  — union preserving local save order, appending new incoming saves
//      a merge that actually changed seen/saved stamps `ts` to now (it's a
//      local mutation like any other seen/save)
//   sync (opts.mode === "sync" && v2) — raise-only seen (same max-merge, but
//      never stamping `ts`); saved + `ts` adopt the blob's values only when the
//      blob's `ts` is strictly newer (LWW; the blob's ts is floored/validated,
//      NOT re-stamped to now — the point is to take the sender's ordering)
// prefs — only applied when opts.prefs is true (either mode); invalid
// imgProxy is ignored.
export function importProfile(json: string, opts: { prefs: boolean; mode?: "merge" | "sync" }): ImportResult {
   // ── parse + validate ──────────────────────────────────────────────────────
   let blob: unknown
   try {
      blob = JSON.parse(json)
   } catch {
      return { ok: false, error: "Invalid JSON" }
   }
   if (typeof blob !== "object" || blob === null || Array.isArray(blob)) {
      return { ok: false, error: "Expected a JSON object" }
   }
   const obj = blob as Record<string, unknown>
   if (obj["v"] !== 1 && obj["v"] !== 2) {
      return { ok: false, error: `Unsupported profile version: ${obj["v"]}` }
   }

   let changed = false
   const incomingSt = cleanTsMap(obj["st"])
   const incomingSd = tsMapOrNull(obj["sd"])
   if (opts.mode === "sync" && obj["v"] === 2) {
      // ── sync (one-reader hybrid pull) — NOT for file restores; those go
      // through the merge branch below even on a v2 blob (opts.mode unset).
      changed = mergeSeen(obj["seen"], incomingSt) // per-key rule, ts deliberately untouched
      const tsRaw = obj["ts"]
      const blobTs = typeof tsRaw === "number" && Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : 0
      const adopt = blobTs > profileTs()
      // saved + sd — mergeSaved runs UNCONDITIONALLY, not only under a newer
      // blob: a per-key stamp can win against an older blob (that is the point
      // of having one), and the blob-level verdict rides in as its `adoptBlob`
      // base. `ts` itself still converges to max, and only when strictly newer.
      if (mergeSaved(HOME_MID, obj["saved"], incomingSd, "sync", adopt)) changed = true
      if (adopt) lsSet(PROFILE_TS_KEY, String(blobTs))
   } else {
      // ── merge (v1, or v2 without mode:"sync" — a file restore) ─────────────

      // seen — the shared per-key rule (raise, or an st-ordered explicit
      // rewind). Only a real value change counts: a stale restore that moves
      // nothing must not stamp `ts` (see below).
      if (mergeSeen(obj["seen"], incomingSt)) changed = true

      // saved — union that PRESERVES local save order and APPENDS restored saves
      // not already present (in the blob's order), keeping the queue's
      // front-to-back meaning instead of re-sorting by chronIdx. Deliberately
      // MONOTONE even now that stamps exist: a file restore is an explicit "add
      // this back" gesture and must never silently delete a save, which is why
      // saved is a union here and an LWW only in sync mode. What the stamps buy
      // here is that a restored save arrives carrying its own `sd` entry, so a
      // later un-save anywhere in the fleet can still outrank it.
      if (mergeSaved(HOME_MID, obj["saved"], incomingSd, "merge", false)) changed = true

      if (changed) touchProfile()
   }

   // ── multi-store: the mount table + peer substate (§4.4) ────────────────────
   // Kept OUT of the home `changed`/touchProfile above — a peer store's change
   // must never stamp the HOME store's ts. Merged for both modes; folded into
   // the RETURNED changed so the caller re-adopts the mount table + repaints.
   const storeMode = opts.mode === "sync" && obj["v"] === 2 ? "sync" : "merge"
   const mountsChanged = mergeMountState(obj, storeMode)
   if (mountsChanged) changed = true

   // ── prefs (opt-in) ────────────────────────────────────────────────────────
   if (opts.prefs) {
      try {
         if (typeof obj["unreadOnly"] === "boolean") {
            // Store the off state explicitly ("0"), not by clearing the key — an
            // absent key is the first-run unread-only default (app.ts), so a
            // restored "off" must persist as "0" to override it.
            lsSet(UNREAD_ONLY_KEY, obj["unreadOnly"] ? "1" : "0")
         }
      } catch {}
      try {
         // The urlish helpers, not fmt.ts's proxy wrappers: importing fmt.ts
         // pulls base.ts's module-load `new URL(SRR_CDN_URL, …)` side effect
         // and would break this module's unit-testability. trailingSlash=true —
         // an imported proxy value is a prefix, same rule as the settings UI.
         const proxy = obj["imgProxy"]
         if (typeof proxy === "string" && isValidHttpish(proxy)) {
            lsSet(IMG_PROXY_KEY, normalizeHttpish(proxy, true))
         }
      } catch {}
   }

   return { ok: true, changed, mountsChanged }
}
