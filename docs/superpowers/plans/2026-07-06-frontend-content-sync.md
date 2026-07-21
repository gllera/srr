# Live Content Sync + LWW Profile Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An open tab silently adopts a newer store snapshot in place (no reload), profile sync becomes whole-blob last-write-wins with a never-regress guard on background cycles, ★ Saved becomes a seen-neutral peek mode, and one "Sync now" config quick-action drives both.

**Architecture:** `data.ts`'s boot path becomes re-runnable (`refresh()` = re-fetch db.gz → full re-init when moved); a new `refresh.ts` owns triggers (refocus/online/interval/manual) and orchestrates `data.refresh()` → `search.invalidate()` → `nav.onStoreRefreshed()` → app's UI routine, all under app's guard mutex. `sync.ts` is rewritten around a v2 `{v,ts,seen,saved,prefs}` blob: pull adopts wholesale when remote is newer, push replaces — but background cycles park instead of ever decreasing read progress; only the manual cycle applies pure LWW.

**Tech Stack:** TypeScript (3-space indent, no semicolons), vitest + jsdom units, e2e contract layer (real `srr` binary + jsdom), Puppeteer browser layer. Spec: `docs/superpowers/specs/2026-07-06-frontend-content-sync-design.md`.

---

## Repo cautions (read first)

- **Concurrent session:** another live session edits this repo. `frontend/src/js/nav.ts`, `fmt.ts`, `nav.test.ts`, `fmt.test.ts`, `frontend/CLAUDE.md`, `backend/feed.go` may be dirty with foreign changes. Before EVERY commit run `git status --short` and stage ONLY the files your task touched. If a file you must edit already carries foreign uncommitted changes (check `git diff <file>` BEFORE your first edit to it), note the pre-existing hunks; if they'd be swept into your commit, STOP and ask the user.
- **Worktrees:** if executing in worktrees, branch off LOCAL `main` (it is far ahead of origin) — `git worktree add <path> main`.
- Run single suites from `frontend/`: `npx vitest run src/js/<file>.test.ts`. Full check from repo root: `make verify` (includes contract e2e + `make generate-check`).
- `format.gen.ts` is generated — never edit. No backend changes in this plan.

## File structure

| File | Change |
|---|---|
| `frontend/src/js/keys.ts` | + `PROFILE_TS_KEY` |
| `frontend/src/js/profile.ts` | v2 blob (`ts`), `profileTs`/`touchProfile`/`localSeen`, `adopt` import mode |
| `frontend/src/js/sync.ts` | LWW cycle, `regressiveSeen` guard, `parked` state, `syncNow({manual})` |
| `frontend/src/js/dropdown.ts` | `syncNow(true)` → `syncNow({ manual: true })` |
| `frontend/src/js/nav.ts` | saved-mode `recordSeen` exemption; `onStoreRefreshed()`; `probeCurrent()` |
| `frontend/src/js/data.ts` | `fetchDb`/`parseDb`/`applyDb` refactor; `refresh()`; caches → `let` |
| `frontend/src/js/search.ts` | `invalidate()` (slots + LRUs re-creatable) |
| `frontend/src/js/list.ts` | `onStoreGrown()` (reopen top, no rebuild) |
| `frontend/src/js/refresh.ts` | NEW — trigger module (mirrors sync.ts's shape) |
| `frontend/src/js/app.ts` | `guardBg`, `refreshAfterStore`, `manualSyncNow`, `refresh.init`, `onRefresh` hook |
| `frontend/src/js/config.ts` | `onRefresh` hook + button wiring; status line: parked flag + refresh error |
| `frontend/src/index.html` + `frontend/src/design.html` | new `.srr-config-refresh` quick-action button (identical markup in both — design.test.ts drift guard) |
| Tests | modify: `profile.test.ts`, `sync.test.ts`, `nav.test.ts`, `list.test.ts`, `config.test.ts` (+ `app.test.ts` mock). create: `refresh.test.ts`, `e2e/contract/refresh.e2e.test.ts`, `e2e/browser/refresh.e2e.test.ts` |
| `frontend/CLAUDE.md` | module table + behaviors (last task) |

Dependency order: Task 1 → 2 (profile → sync); Task 4 → 5 → 6 → 7 → 8 (data → search → nav → list → refresh); Task 9 needs 2–8. Task 3 is independent. Tasks 10–12 last.

---

### Task 1: profile.ts — v2 blob, ts, adopt mode

**Files:**
- Modify: `frontend/src/js/keys.ts`
- Modify: `frontend/src/js/profile.ts`
- Test: `frontend/src/js/profile.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `profile.test.ts`, matching its existing style — localStorage-based, no module reset needed unless the file does it):

```ts
describe("v2 blob / ts / adopt", () => {
   it("exportProfile emits v:2 with the stored ts (0 when never stamped)", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 5 }))
      expect(JSON.parse(exportProfile())).toMatchObject({ v: 2, ts: 0 })
      touchProfile(1234)
      expect(JSON.parse(exportProfile())).toMatchObject({ v: 2, ts: 1234 })
      expect(profileTs()).toBe(1234)
   })

   it("adopt replaces seen and saved wholesale and takes the blob's ts", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500, "feed:2": 90 }))
      localStorage.setItem(SAVED_KEY, JSON.stringify([1, 2, 3]))
      touchProfile(100)
      const blob = JSON.stringify({ v: 2, ts: 200, seen: { "feed:1": 10 }, saved: [7], unreadOnly: false, imgProxy: "" })
      expect(importProfile(blob, { prefs: false, adopt: true }).ok).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 10 }) // feed:2 dropped — wholesale
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([7]) // un-saves propagate
      expect(profileTs()).toBe(200)
   })

   it("adopt never applies prefs (prefs stay carried-not-applied)", () => {
      localStorage.setItem(UNREAD_ONLY_KEY, "1")
      const blob = JSON.stringify({ v: 2, ts: 9, seen: {}, saved: [], unreadOnly: false, imgProxy: "" })
      importProfile(blob, { prefs: false, adopt: true })
      expect(localStorage.getItem(UNREAD_ONLY_KEY)).toBe("1")
   })

   it("v1 blob still merges monotonically (max/union) and a merge stamps ts", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500 }))
      localStorage.setItem(SAVED_KEY, JSON.stringify([3]))
      const blob = JSON.stringify({ v: 1, seen: { "feed:1": 10, "feed:2": 4 }, saved: [7], unreadOnly: true, imgProxy: "" })
      expect(importProfile(blob, { prefs: false }).ok).toBe(true)
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 500, "feed:2": 4 })
      expect(JSON.parse(localStorage.getItem(SAVED_KEY)!)).toEqual([3, 7])
      expect(profileTs()).toBeGreaterThan(0)
   })

   it("v2 blob WITHOUT adopt (file restore) merges like v1", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 500 }))
      const blob = JSON.stringify({ v: 2, ts: 999, seen: { "feed:1": 10 }, saved: [], unreadOnly: false, imgProxy: "" })
      importProfile(blob, { prefs: false })
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 500 })
   })

   it("localSeen returns the parsed map", () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:9": 42 }))
      expect(localSeen()).toEqual({ "feed:9": 42 })
   })
})
```

Add to the file's import line: `exportProfile, importProfile, profileTs, touchProfile, localSeen` and `PROFILE_TS_KEY`/`UNREAD_ONLY_KEY` from `./keys` as needed. Existing tests asserting `v: 1` in export output must be updated to `v: 2` (the shape otherwise matches).

- [ ] **Step 2: Run to verify failure** — `cd frontend && npx vitest run src/js/profile.test.ts` → FAIL (`profileTs` not exported).

- [ ] **Step 3: Implement.** In `keys.ts` append:

```ts
export const PROFILE_TS_KEY = "srr-profile-ts"
```

In `profile.ts`: import `PROFILE_TS_KEY`; add after `readSavedSorted`:

```ts
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
```

Change `exportProfile` to emit v2:

```ts
export function exportProfile(): string {
   const seen = readSeen()
   const saved = readSavedSorted()
   const unreadOnly = lsGet(UNREAD_ONLY_KEY) === "1"
   const imgProxy = lsGet(IMG_PROXY_KEY)
   return JSON.stringify({ v: 2, ts: profileTs(), seen, saved, unreadOnly, imgProxy })
}
```

In `importProfile`: change signature to `opts: { prefs: boolean; adopt?: boolean }`; replace the version check with:

```ts
   if (obj["v"] !== 1 && obj["v"] !== 2) {
      return { ok: false, error: `Unsupported profile version: ${obj["v"]}` }
   }
```

Then wrap the two merge sections: when `opts.adopt && obj["v"] === 2`, replace wholesale instead of merging (and skip the merge blocks entirely):

```ts
   if (opts.adopt && obj["v"] === 2) {
      // Whole-blob adoption (LWW pull): replace seen/saved, take the blob's ts.
      // NOT for file restores — those keep the monotone merge below.
      try {
         const incoming = obj["seen"]
         const cleaned: Record<string, number> = {}
         if (incoming !== null && typeof incoming === "object" && !Array.isArray(incoming))
            for (const [k, v] of Object.entries(incoming as Record<string, unknown>))
               if (typeof v === "number" && Number.isFinite(v)) cleaned[k] = v
         lsSet(SEEN_KEY, JSON.stringify(cleaned))
      } catch {}
      try {
         const incoming = obj["saved"]
         const cleaned = Array.isArray(incoming)
            ? incoming.filter((n) => Number.isInteger(n) && n >= 0).sort((a: number, b: number) => a - b)
            : []
         lsSet(SAVED_KEY, JSON.stringify(cleaned))
      } catch {}
      const ts = obj["ts"]
      lsSet(PROFILE_TS_KEY, String(typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0))
   } else {
      // Monotone merge (file restore + the one-time v1 legacy pull): seen max /
      // saved union — a local mutation, so it stamps ts.
      let changed = false
      /* existing seen-merge block, setting changed = true as it does today */
      /* existing saved-merge block, setting changed = true as it does today */
      if (changed) touchProfile()
   }
```

(Keep the prefs block after this, unchanged. The `changed` flags already exist inside the two blocks — hoist one shared `changed` above both.)

- [ ] **Step 4: Run** — `npx vitest run src/js/profile.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add frontend/src/js/keys.ts frontend/src/js/profile.ts frontend/src/js/profile.test.ts && git commit -m "feat(frontend): profile v2 blob — LWW ts + wholesale adopt mode"`

---

### Task 2: sync.ts — LWW cycle with progress-regression guard

**Files:**
- Modify: `frontend/src/js/sync.ts`
- Modify: `frontend/src/js/dropdown.ts` (line ~186: `void syncNow(true)` → `void syncNow({ manual: true })`)
- Test: `frontend/src/js/sync.test.ts`

**Behavior table (update existing tests that contradict it):**

| Situation (background cycle) | Outcome |
|---|---|
| remote 404 | no adopt; push if dirty (unguarded — nothing to regress against) |
| remote v1 | monotone merge, `dirty = true` (forces v2 upgrade push), guarded push |
| remote v2, `remote.ts <= profileTs()` | keep local; push if dirty (guarded) |
| remote v2 newer, non-regressive vs local | adopt wholesale; `dirty = false` |
| remote v2 newer, regressive vs local | **park**: no adopt, no push, `state().parked === true` |
| push would be regressive vs last-pulled remote seen | **park** the push, dirty stays |
| **manual** (`syncNow({manual:true})`) | pure LWW: adopt if newer (even regressive), then ALWAYS push |
| `flush()` | skipped when `profileTs() < lastRemoteTs` or blob regressive vs last-pulled remote; unguarded if never pulled |

- [ ] **Step 1: Write the failing tests** (replace `remoteBlob` helper and add; keep the existing describe blocks that still apply — url validation, disabled, throttling — and fix ones that assert old merge semantics per the table):

```ts
const v2Blob = (ts: number, seen: Record<string, number> = { "feed:1": 50 }, saved: number[] = [7]) =>
   JSON.stringify({ v: 2, ts, seen, saved, unreadOnly: true, imgProxy: "" })

describe("LWW pull", () => {
   beforeEach(() => sync.setSyncUrl(URL))

   it("adopts a newer non-regressive remote wholesale", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 10 }))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValueOnce(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow()
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 50 })
      expect(localStorage.getItem(PROFILE_TS_KEY)).toBe("200")
      expect(sync.state().parked).toBe(false)
   })

   it("keeps local when remote is older, then pushes only if dirty", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValueOnce(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow()
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90 })
      expect(fetchMock).toHaveBeenCalledTimes(1) // GET only, not dirty
   })

   it("parks instead of adopting a newer REGRESSIVE remote (and skips the push)", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      sync.pushSoon() // local is dirty
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow()
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90 }) // not adopted
      expect(fetchMock).toHaveBeenCalledTimes(1) // no PUT either
      expect(sync.state().parked).toBe(true)
   })

   it("a dropped feed key counts as regressive", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 50, "feed:2": 5 }))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValueOnce(res(200, v2Blob(200, { "feed:1": 50 }))) // feed:2 absent
      await sync.syncNow()
      expect(sync.state().parked).toBe(true)
   })

   it("MANUAL adopts a regressive newer remote and always pushes (pure LWW)", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow({ manual: true })
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 50 })
      expect(fetchMock).toHaveBeenCalledTimes(2) // GET then PUT
      expect(fetchMock.mock.calls[1][1].method).toBe("PUT")
      expect(sync.state().parked).toBe(false)
   })

   it("a v1 remote gets one monotone merge and an upgrade push", async () => {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ "feed:1": 90 }))
      fetchMock.mockResolvedValue(res(200, remoteBlob({ seen: { "feed:1": 50, "feed:2": 4 } })))
      await sync.syncNow()
      expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ "feed:1": 90, "feed:2": 4 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).v).toBe(2)
   })
})

describe("regression-guarded push / flush", () => {
   beforeEach(() => sync.setSyncUrl(URL))

   it("parks a background push that would rewind the endpoint", async () => {
      // Pull first so lastRemoteSeen is known and newer-progress.
      localStorage.setItem(PROFILE_TS_KEY, "300")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 90 })))
      await sync.syncNow() // remote older → keep local; local seen lacks feed:1
      sync.pushSoon()
      await vi.advanceTimersByTimeAsync(6000)
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(0)
      expect(sync.state().parked).toBe(true)
   })

   it("flush skips when local ts is older than the last-pulled remote", async () => {
      localStorage.setItem(PROFILE_TS_KEY, "100")
      fetchMock.mockResolvedValue(res(200, v2Blob(200, { "feed:1": 50 })))
      await sync.syncNow() // adopts; ts = 200; not dirty
      localStorage.setItem(PROFILE_TS_KEY, "150") // simulate a stale tab's older state
      sync.pushSoon()
      sync.flush()
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(0)
   })

   it("flush stays unguarded when this tab never pulled", () => {
      sync.pushSoon()
      sync.flush()
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(1)
   })
})
```

Import `PROFILE_TS_KEY` in the test file. Note `state()` now returns `{on, okAt, error, parked}` — update the existing `toEqual` assertion.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/js/sync.test.ts`.

- [ ] **Step 3: Implement.** In `sync.ts`:

Imports: `import { exportProfile, importProfile, localSeen, profileTs, touchProfile } from "./profile"`.

New state next to `lastError`:

```ts
let lastRemoteTs = -1 // ts of the last successfully pulled remote (-1 = never pulled)
let lastRemoteSeen: Record<string, number> | null = null // its seen map, for the regression guard
let parkedFlag = false // last background cycle parked on a would-be progress regression
```

Reset all three in `setSyncUrl` (alongside `lastOkAt`/`lastError`/`lastPullAt`).

`SyncState` gains `parked: boolean`; `state()` returns `{ on: enabled(), okAt: lastOkAt, error: lastError, parked: parkedFlag }`.

Add the guard predicate (exported for tests):

```ts
// True when publishing/adopting `incoming` over `cur` would DECREASE read
// progress: some feed key in `cur` is absent from `incoming` or maps lower.
// Seen axis only — saved-set changes (incl. un-saves) never park a cycle;
// deletions propagating is the point of LWW.
export function regressiveSeen(cur: Record<string, number>, incoming: Record<string, number>): boolean {
   for (const [k, v] of Object.entries(cur)) {
      const inc = incoming[k]
      if (inc === undefined || inc < v) return true
   }
   return false
}
```

Replace `pullMerge` with a parse-only fetch (the decision moved into `syncNow`):

```ts
interface RemoteBlob {
   v: 1 | 2
   ts: number
   seen: Record<string, number>
   raw: string
}

// GET + parse. null = 404 (nothing stored yet — the next push seeds it).
// Validation is minimal here (version + the seen map the guard needs);
// importProfile re-validates before mutating anything.
async function pullRemote(url: string): Promise<RemoteBlob | null> {
   const res = await fetch(url, { cache: "no-store", credentials: "include" })
   if (res.status === 404) return null
   if (!res.ok) throw new Error(`HTTP ${res.status}`)
   const raw = await res.text()
   let obj: Record<string, unknown>
   try {
      obj = JSON.parse(raw) as Record<string, unknown>
   } catch {
      throw new Error("invalid profile")
   }
   if (typeof obj !== "object" || obj === null) throw new Error("invalid profile")
   const v = obj["v"] === 2 ? 2 : obj["v"] === 1 ? 1 : 0
   if (v === 0) throw new Error(`unsupported profile version: ${obj["v"]}`)
   const tsRaw = obj["ts"]
   const ts = typeof tsRaw === "number" && Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : 0
   const seen: Record<string, number> = {}
   const seenRaw = obj["seen"]
   if (seenRaw !== null && typeof seenRaw === "object" && !Array.isArray(seenRaw))
      for (const [k, val] of Object.entries(seenRaw as Record<string, unknown>))
         if (typeof val === "number" && Number.isFinite(val)) seen[k] = val
   return { v: v as 1 | 2, ts, seen, raw }
}
```

Replace `syncNow` (old signature `syncNow(push = dirty)` is gone; the only external caller passing an arg is dropdown.ts):

```ts
// One full cycle under whole-blob LWW. Background cycles are progress-monotone:
// any adoption or publication that would DECREASE read progress (regressiveSeen)
// parks the cycle instead — no adopt, no push, status flagged — and waits for a
// manual Sync now, which applies pure LWW in both directions (the human tap is
// the authorization to rewind). A pull failure skips the push (never PUT over a
// remote we failed to read); offline failures stay silent.
export async function syncNow(opts: { manual?: boolean } = {}): Promise<void> {
   const url = getSyncUrl()
   if (!url || inflight) return
   inflight = true
   lastPullAt = Date.now()
   try {
      const remote = await pullRemote(url)
      let adopted = false
      let parked = false
      if (remote) {
         lastRemoteTs = remote.ts
         lastRemoteSeen = remote.seen
         if (remote.v === 1) {
            // One-time legacy path: monotone-merge the v1 blob (old rules), then
            // force a push so the endpoint upgrades to v2.
            const before = exportProfile()
            const r = importProfile(remote.raw, { prefs: false })
            if (!r.ok) throw new Error(r.error ?? "invalid profile")
            adopted = exportProfile() !== before
            dirty = true
         } else if (remote.ts > profileTs()) {
            if (!opts.manual && regressiveSeen(localSeen(), remote.seen)) {
               parked = true // newer remote would rewind local read progress
            } else {
               const before = exportProfile()
               const r = importProfile(remote.raw, { prefs: false, adopt: true })
               if (!r.ok) throw new Error(r.error ?? "invalid profile")
               adopted = exportProfile() !== before
               dirty = false // local state IS the remote state now
            }
         }
      }
      if (adopted) onMerged?.()
      let wantPush = opts.manual || dirty
      if (wantPush && !opts.manual && !parked && lastRemoteSeen && regressiveSeen(lastRemoteSeen, localSeen())) {
         parked = true // publishing local would rewind the endpoint's progress
      }
      if (wantPush && !parked) {
         await put(url)
         dirty = false
         clearTimeout(pushTimer)
         lastRemoteTs = profileTs()
         lastRemoteSeen = localSeen()
      }
      parkedFlag = parked
      lastOkAt = Math.floor(Date.now() / 1000)
      lastError = ""
   } catch (e) {
      if (navigator.onLine !== false) lastError = e instanceof Error ? e.message : String(e)
   } finally {
      inflight = false
      onStatus?.()
   }
}
```

`pushSoon` stamps the mutation time (it is called from exactly the two seen/saved mutation seams, and ts must track mutations even before sync is enabled):

```ts
export function pushSoon(): void {
   touchProfile()
   if (!enabled()) return
   dirty = true
   clearTimeout(pushTimer)
   pushTimer = setTimeout(() => void syncNow(), PUSH_DEBOUNCE_MS)
}
```

`flush` gains the LWW guards (dirty stays set on a skip):

```ts
export function flush(): void {
   if (!dirty) return
   const url = getSyncUrl()
   if (!url) return
   // LWW makes a bare PUT dangerous in ways v1's monotone merge wasn't: a stale
   // tab could replace a newer remote blob, or rewind the endpoint's progress.
   // Skip in both cases — dirty stays set, so the next full cycle (which pulls
   // first) handles it. A tab that never pulled flushes unguarded, as before.
   if (lastRemoteTs >= 0) {
      if (profileTs() < lastRemoteTs) return
      if (lastRemoteSeen && regressiveSeen(lastRemoteSeen, localSeen())) return
   }
   clearTimeout(pushTimer)
   dirty = false
   void put(url, true).catch(() => {
      dirty = true
   })
}
```

In `dropdown.ts` line ~186: `if (value) void syncNow({ manual: true })`. Update the module header comment in `sync.ts` (the v1 merge rationale paragraph) to describe LWW + the guard.

- [ ] **Step 4: Run** — `npx vitest run src/js/sync.test.ts src/js/dropdown.test.ts` → PASS (fix any dropdown test asserting the old call shape).
- [ ] **Step 5: Commit** — `git add frontend/src/js/sync.ts frontend/src/js/dropdown.ts frontend/src/js/sync.test.ts frontend/src/js/dropdown.test.ts && git commit -m "feat(frontend): profile sync v2 — whole-blob LWW with progress-regression guard"`

---

### Task 3: nav.ts — ★ Saved becomes a peek mode

**⚠ nav.ts may be dirty from the concurrent session — check `git diff frontend/src/js/nav.ts` before editing (see Repo cautions).**

**Files:**
- Modify: `frontend/src/js/nav.ts` (recordSeen, ~line 629)
- Test: `frontend/src/js/nav.test.ts`

- [ ] **Step 1: Write the failing test** (nav.test.ts style: `setupIndex`, spies; place near the existing search-exemption test):

```ts
it("saved mode never records seen — opening an old saved article is a peek", async () => {
   setupIndex([
      { f: 1, t: "old" },
      { f: 1, t: "mid" },
      { f: 1, t: "new" },
   ])
   localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 2 }))
   localStorage.setItem("srr-saved", JSON.stringify([0]))
   nav.filter.set(["~saved"])
   await nav.goTo(0)
   // Own feed's resume position must NOT rewind to 0.
   expect(JSON.parse(localStorage.getItem("srr-seen")!)).toEqual({ "feed:1": 2 })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/js/nav.test.ts -t "peek"` → FAIL (seen rewound to 0).

- [ ] **Step 3: Implement.** In `recordSeen`, change the early return and its comment:

```ts
   // Peek modes never touch the seen frontier. Search (q:) jumps to hits, not a
   // contiguous read-through — advancing here would mark everything up to the
   // hit as seen. ★ Saved is the same shape: re-reading an archived item is not
   // resuming its feed, and the own-feed exact-position write below would REWIND
   // that feed's resume position (inflating its unread badge — and under LWW
   // sync, propagating the rewind to every device). A saved/search article you
   // peek at stays unread until you actually read it in its feed.
   if (filter.search || filter.saved) return
```

- [ ] **Step 4: Run** — `npx vitest run src/js/nav.test.ts` → PASS.
- [ ] **Step 5: Commit** (nav.ts + nav.test.ts only, after the dirty-file check) — `git commit -m "feat(frontend): saved mode joins search as a seen-neutral peek mode"`

---

### Task 4: data.ts — re-runnable boot + refresh()

**Files:**
- Modify: `frontend/src/js/data.ts`

No new unit test file — coverage comes from the contract layer (Task 10), which exercises the real packs; `data.test.ts` stays pure-function-only per its charter. This task must keep every existing suite green.

- [ ] **Step 1: Refactor.** Replace the module-load fetch (line ~22) with:

```ts
// no-cache forces a conditional revalidation on every load … (keep comment)
function fetchDb(): Promise<Response> {
   return fetch(new URL("db.gz", PACK_BASE), { cache: "no-cache" })
}
const dbFetch = fetchDb()
```

Change `dataCache`, `metaCache`, `groupCache` declarations from `const` to `let` (lines ~257, ~332, ~371).

Split `init()` into parse + apply, and add `refresh()`:

```ts
async function parseDb(res: Response): Promise<IDB> {
   if (!res.ok) throw new Error(`db.gz fetch failed: ${res.status} ${res.url}`)
   const raw: IDB = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()
   raw.feeds ??= {}
   raw.seq ??= 0 // backend omitempty: absent for an empty store
   for (const [k, ch] of Object.entries(raw.feeds)) ch.id = Number(k)
   return raw
}

// The (re-runnable) boot body: swap the snapshot in and rebuild everything
// derived from it. Also the refresh() path — the caches are recreated
// wholesale (one code path, no diff logic); refetches ride the SW/HTTP cache,
// and on a gen change the stale bytes MUST go anyway.
async function applyDb(raw: IDB): Promise<void> {
   db = raw
   const ids = Object.keys(db.feeds).map(Number)
   slots = ids.length > 0 ? Math.max(...ids) + 1 : 1
   expiredCounts = new Uint32Array(slots)
   for (const ch of Object.values(db.feeds)) expiredCounts[ch.id] = ch.xp ?? 0
   dataCache = makeLRU<Promise<IArticle[]>>(20)
   metaCache = makeLRU<Promise<IMetaWire[]>>(20)
   groupCache = {}
   if (db.total_art === 0) {
      idxHeaders = []
      sessionStorage.removeItem(RELOAD_GUARD)
      return
   }
   const nf = numFinalizedIdx()
   idxFetches = makeLRU(nf + 1)
   const latest = fetchIdxPack(nf)
   let headers: IdxHeader[] | null = null
   if (nf > 0 && db.hdrs === nf) {
      try {
         headers = parseIdxHeaders(await fetchPackBytes(`idx/h${db.hdrs}.gz`, false), nf)
      } catch {
         // stale summary past GC / half-written store: eager fallback below.
      }
   }
   if (headers === null) {
      const packs = await Promise.all(Array.from({ length: nf }, (_, p) => fetchIdxPack(p)))
      headers = packs.map((p) => p.header)
   }
   latestIdx = await latest
   headers.push(latestIdx.header)
   idxHeaders = headers
   sessionStorage.removeItem(RELOAD_GUARD)
}

export async function init() {
   await applyDb(await parseDb(await dbFetch))
}

// refresh() re-fetches db.gz and re-runs the boot path when the store moved.
// "unchanged" when the snapshot is byte-equivalent on the fields that matter
// (fetched_at moves on EVERY backend commit, so it alone catches everything;
// the rest are belt-and-braces). A gen change takes the same path — everything
// derived is discarded anyway, and the SW's checkManifest rides this same
// response, purging its buckets before our subsequent pack refetches.
export async function refresh(): Promise<"unchanged" | "updated"> {
   const raw = await parseDb(await fetchDb())
   if (
      raw.fetched_at === db.fetched_at &&
      raw.total_art === db.total_art &&
      raw.seq === db.seq &&
      (raw.gen ?? 0) === (db.gen ?? 0)
   )
      return "unchanged"
   await applyDb(raw)
   return "updated"
}
```

Preserve every existing comment that still applies (move, don't delete). Keep `init`'s original doc comments on `applyDb`.

- [ ] **Step 2: Run the full unit + contract suites** (they import the real data.ts): `npx vitest run` then from repo root `make test-contract` → all PASS, zero behavior change expected.
- [ ] **Step 3: Commit** — `git add frontend/src/js/data.ts && git commit -m "refactor(frontend): re-runnable data boot — parseDb/applyDb + refresh()"`

---

### Task 5: search.ts — invalidate()

**Files:**
- Modify: `frontend/src/js/search.ts`
- Test: `frontend/src/js/search.test.ts`

- [ ] **Step 1: Write the failing test** (search.test.ts pattern: `vi.resetModules()` + dynamic import, mocked `./data` with `fetchPackBytes` spy):

```ts
it("invalidate() drops the cached tail/summary/shards/hits so the next query re-reads", async () => {
   // First query populates the latest-tail slot (and the hit cache).
   await search.loadHits("alpha", 500)
   const before = fetchPackBytes.mock.calls.length
   await search.loadHits("alpha", 500) // cached — no new fetches
   expect(fetchPackBytes.mock.calls.length).toBe(before)
   search.invalidate()
   await search.loadHits("alpha", 500)
   expect(fetchPackBytes.mock.calls.length).toBeGreaterThan(before) // re-read
})
```

(Adapt fixture names to the file's existing mock store — it already has a working `loadHits` test to copy the setup from.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/js/search.test.ts` → FAIL (`invalidate` not exported).

- [ ] **Step 3: Implement.** Wrap the three cached loaders in factories so they can be re-created:

```ts
const summarySlot = () =>
   lazySlot(async () => {
      const nf = data.numFinalizedMeta()
      const blooms = new Uint8Array(await data.fetchPackBytes(`meta/s${data.db.mp}.gz`, false))
      if (blooms.length !== nf * SEARCH_BLOOM_BYTES)
         throw new Error(`meta summary: ${blooms.length} bytes for ${nf} shards`)
      return blooms
   })
let loadSummary = summarySlot()

const latestSlot = () =>
   lazySlot(() => data.fetchPackBytes(`meta/L${data.db.seq}.gz`, true).then((buf) => parseShard(buf, false)))
let loadLatest = latestSlot()

let shardCache = makeLRU<Promise<Shard>>(8)
```

…and `let hitCache = makeLRU<Promise<HitSet>, string>(8)`. Then add:

```ts
// Drop every cached read so the next query re-reads the refreshed store: the
// latest tail and bloom summary are generation-named (stale after a refresh),
// the hit sets were computed against the old snapshot, and on a gen change even
// finalized shards changed bytes. Refetches ride the SW cache. Called by
// refresh.ts after data.refresh() adopts a new snapshot.
export function invalidate(): void {
   loadSummary = summarySlot()
   loadLatest = latestSlot()
   shardCache = makeLRU<Promise<Shard>>(8)
   hitCache = makeLRU<Promise<HitSet>, string>(8)
}
```

- [ ] **Step 4: Run** — `npx vitest run src/js/search.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add frontend/src/js/search.ts frontend/src/js/search.test.ts && git commit -m "feat(frontend): search.invalidate() — droppable caches for the store refresh"`

---

### Task 6: nav.ts — onStoreRefreshed() + probeCurrent()

**⚠ nav.ts dirty-file check again before editing.**

**Files:**
- Modify: `frontend/src/js/nav.ts`
- Test: `frontend/src/js/nav.test.ts`

- [ ] **Step 1: Write the failing tests:**

```ts
describe("onStoreRefreshed", () => {
   it("keeps existing bounds, raises only by a grown add_idx, adds new members", async () => {
      setupIndex([
         { f: 1, t: "a" },
         { f: 1, t: "b" },
      ])
      nav.filter.clear() // [ALL]: feeds = {1: 0}
      // Simulate a refresh: feed 1's add_idx advanced (expiration) and feed 2 appeared.
      db.feeds[1].add_idx = 1
      db.feeds[2] = makeFeed({ id: 2, title: "New", total_art: 1, add_idx: 2 })
      db.total_art = 3
      await nav.onStoreRefreshed()
      expect(nav.filter.feeds.get(1)).toBe(1) // raised by add_idx only
      expect(nav.filter.feeds.get(2)).toBe(2) // new member joined
   })

   it("does NOT re-snapshot unseen-only bounds from seen", async () => {
      setupIndex([
         { f: 1, t: "a" },
         { f: 1, t: "b" },
         { f: 1, t: "c" },
      ])
      nav.setUnreadOnly(true)
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": -1 }))
      nav.filter.set(["1"]) // bound snapshotted at 0
      localStorage.setItem("srr-seen", JSON.stringify({ "feed:1": 1 })) // read 0,1 this session
      await nav.onStoreRefreshed()
      expect(nav.filter.feeds.get(1)).toBe(0) // bound NOT re-raised past the session's reads
   })

   it("drops a feed deleted from the store", async () => {
      setupIndex([{ f: 1, t: "a" }])
      nav.filter.clear()
      delete db.feeds[1]
      await nav.onStoreRefreshed()
      expect(nav.filter.feeds.has(1)).toBe(false)
   })
})

describe("probeCurrent", () => {
   it("recomputes has_right/right_count for the current position after growth", async () => {
      setupIndex([
         { f: 1, t: "a" },
         { f: 1, t: "b" },
      ])
      nav.filter.clear()
      await nav.goTo(1) // newest — has_right false
      setupIndex([
         { f: 1, t: "a" },
         { f: 1, t: "b" },
         { f: 1, t: "c" },
      ]) // grow the store
      await nav.onStoreRefreshed() // clears the cached "no right neighbor"
      const o = await nav.probeCurrent()
      expect(o!.has_right).toBe(true)
      expect(o!.right_count).toBe(1)
   })

   it("returns null with no article on screen", async () => {
      expect(await nav.probeCurrent()).toBeNull()
   })
})
```

(Adapt `setupIndex`/`makeFeed`/`db` to the file's actual helper signatures — they exist per the test-patterns doc; growing the store means re-driving the same mocks the helper wires.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Add to `nav.ts` (after `applyFilter` is a good home):

```ts
// After data.refresh() swapped the store snapshot: reconcile the filter and the
// navigation caches WITHOUT re-snapshotting the walk. Bounds only ever rise by
// a grown add_idx (expiration) — never re-derived from seen, which would yank
// the unseen-only sequence mid-session (articles read this session would drop
// out from under ←). New members (a new feed under [ALL], a feed newly tagged
// into the active tag) join with the same bound set()/applyUnseen would give
// them; members gone from the store leave. New articles need no bound work at
// all — they sit above every existing bound. pos is untouched: chronIdx is a
// permanent address and total_art only grew.
export async function onStoreRefreshed(): Promise<void> {
   if (!filter.saved && !filter.search) {
      const fresh = new Map<number, number>()
      if (filter.active) {
         for (const token of filter.tokens) {
            const num = Number(token)
            if (Number.isFinite(num)) {
               const ch = data.db.feeds[num]
               if (ch?.total_art && !fresh.has(num)) fresh.set(num, ch.add_idx ?? 0)
            } else
               for (const ch of Object.values(data.db.feeds))
                  if (ch.tag === token && ch.total_art && !fresh.has(ch.id)) fresh.set(ch.id, ch.add_idx ?? 0)
         }
      } else {
         for (const ch of Object.values(data.db.feeds)) if (ch.total_art) fresh.set(ch.id, ch.add_idx ?? 0)
      }
      const seenMap = readSeen()
      for (const [id, addIdx] of fresh) {
         const old = filter.feeds.get(id)
         if (old !== undefined) {
            if (addIdx > old) filter.feeds.set(id, addIdx) // expiration advanced past the old bound
         } else {
            const s = unreadOnly ? (seenMap["feed:" + id] ?? -1) : -1
            filter.feeds.set(id, Math.max(addIdx, s + 1))
         }
      }
      for (const id of [...filter.feeds.keys()]) if (!fresh.has(id)) filter.feeds.delete(id)
   }
   // Cached neighbor probes are exactly what new content invalidates (a stored
   // "no right neighbor" at the newest article most of all), and the prefetched
   // neighbor may equally have changed. Drop both; the next step re-probes.
   next.left = next.right = undefined
   abortPrefetch()
   // An active search walks a snapshot computed against the old store: reload it
   // (the caller invalidated search.ts's caches first). ensureSearchSet's
   // supersession guard absorbs a concurrent query change.
   if (filter.search) {
      resetSearchStream()
      await ensureSearchSet()
   }
}

// Recompute the reader chrome (has_left/has_right/right_count) for the article
// already on screen — after a store refresh, without re-rendering the content
// (the silent contract: no fade, no scroll). null when nothing is showing.
// loadArticle(pos) is cache-warm, so this costs idx probes at most.
export async function probeCurrent(): Promise<IShowFeed | null> {
   if (pos < 0) return null
   const article = await data.loadArticle(pos)
   return showFeed(article)
}
```

- [ ] **Step 4: Run** — `npx vitest run src/js/nav.test.ts` → PASS.
- [ ] **Step 5: Commit** (nav.ts + nav.test.ts only) — `git commit -m "feat(frontend): nav.onStoreRefreshed + probeCurrent — filter-stable store adoption"`

---

### Task 7: list.ts — onStoreGrown()

**Files:**
- Modify: `frontend/src/js/list.ts`
- Test: `frontend/src/js/list.test.ts`

- [ ] **Step 1: Write the failing test** (list.test.ts pattern: hoisted `data`/`nav` mocks, `vi.resetModules()` + dynamic import; reuse its article-seeding helper):

```ts
describe("onStoreGrown", () => {
   it("reopens an exhausted top when a newer match exists (terminus off, no rebuild)", async () => {
      seedArticles(3) // helper: fills data._arts 0..2, db.total_art = 3
      await list.render() // anchored newest — exhaustedTop, LATEST terminus present
      expect(container.querySelector(".srr-wire-top")).not.toBeNull()
      const rowsBefore = container.querySelectorAll("a.srr-row").length
      addArticle(3) // helper: grow db.total_art to 4 with a matching article
      await list.onStoreGrown()
      expect(container.querySelector(".srr-wire-top")).toBeNull() // reopened
      expect(container.querySelectorAll("a.srr-row").length).toBe(rowsBefore) // NO rows prepended (silent)
   })

   it("keeps the terminus when the refresh brought nothing for this filter", async () => {
      seedArticles(3)
      await list.render()
      await list.onStoreGrown() // no growth → probe finds nothing
      expect(container.querySelector(".srr-wire-top")).not.toBeNull()
   })

   it("rebuilds when the list shows an empty state", async () => {
      seedArticles(0)
      await list.render()
      addArticle(0)
      await list.onStoreGrown()
      expect(container.querySelectorAll("a.srr-row").length).toBeGreaterThan(0)
   })
})
```

(`seedArticles`/`addArticle`: use the file's existing seeding pattern — it populates `data._arts` and `data.db.total_art` directly; add a tiny local helper if none is factored out.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/js/list.test.ts -t "onStoreGrown"`.

- [ ] **Step 3: Implement.** Add to `list.ts` next to `rerender()`:

```ts
// After a store refresh grew the feed: reopen the top of the list WITHOUT
// rebuilding or moving the viewport (the fully-silent contract). Probes for a
// newer MATCH first so the LATEST terminus doesn't flicker off when the refresh
// brought nothing for this filter; when one exists, the terminus comes off
// (scroll-compensated) and the top sentinel resumes paging — newer rows arrive
// on the next upward scroll, prepended with the usual compensation. An empty
// state (fresh store, all-caught-up, no rows) rebuilds instead: there is
// nothing on screen to disturb.
export async function onStoreGrown(): Promise<void> {
   if (!rowsEl || !rowsEl.querySelector("a.srr-row")) return rerender()
   refresh() // re-derive row state; cheap, covers a gen-rebuild's changed feeds
   if (!exhaustedTop || newest < 0) return
   const my = tok
   const found = await nav.feedRight(newest + 1).catch(() => -1)
   if (my !== tok || found === -1) return // superseded by a rebuild, or nothing newer
   exhaustedTop = false
   syncTopTerminus(true)
}
```

- [ ] **Step 4: Run** — `npx vitest run src/js/list.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add frontend/src/js/list.ts frontend/src/js/list.test.ts && git commit -m "feat(frontend): list.onStoreGrown — silently reopen the top after a store refresh"`

---

### Task 8: refresh.ts — the trigger module

**Files:**
- Create: `frontend/src/js/refresh.ts`
- Test: `frontend/src/js/refresh.test.ts` (new)

- [ ] **Step 1: Write the failing tests:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// refresh.ts holds throttle state and wires document/window listeners at
// init(), so each test gets a fresh instance via vi.resetModules() + dynamic
// import (the sync.test.ts pattern). data/nav/search are mocked.
const data = vi.hoisted(() => ({ refresh: vi.fn(async () => "updated" as const) }))
const nav = vi.hoisted(() => ({ onStoreRefreshed: vi.fn(async () => {}) }))
const search = vi.hoisted(() => ({ invalidate: vi.fn() }))
vi.mock("./data", () => data)
vi.mock("./nav", () => nav)
vi.mock("./search", () => search)

type Refresh = typeof import("./refresh")
let refresh: Refresh
let updated: ReturnType<typeof vi.fn>

const exclusive = async (fn: () => Promise<void>) => (await fn(), true)

beforeEach(async () => {
   vi.useFakeTimers()
   data.refresh.mockClear().mockResolvedValue("updated")
   nav.onStoreRefreshed.mockClear()
   search.invalidate.mockClear()
   updated = vi.fn()
   vi.resetModules()
   refresh = await import("./refresh")
})

afterEach(() => {
   vi.useRealTimers()
})

describe("refreshNow", () => {
   it("runs the full chain on 'updated' and returns ''", async () => {
      refresh.init(exclusive, updated)
      expect(await refresh.refreshNow()).toBe("")
      expect(data.refresh).toHaveBeenCalledTimes(1)
      expect(search.invalidate).toHaveBeenCalledTimes(1)
      expect(nav.onStoreRefreshed).toHaveBeenCalledTimes(1)
      expect(updated).toHaveBeenCalledTimes(1)
   })

   it("skips the chain on 'unchanged'", async () => {
      data.refresh.mockResolvedValue("unchanged")
      refresh.init(exclusive, updated)
      await refresh.refreshNow()
      expect(search.invalidate).not.toHaveBeenCalled()
      expect(updated).not.toHaveBeenCalled()
   })

   it("returns the error message on failure (and remembers it)", async () => {
      data.refresh.mockRejectedValue(new Error("boom"))
      refresh.init(exclusive, updated)
      expect(await refresh.refreshNow()).toBe("boom")
      expect(refresh.lastRefreshError()).toBe("boom")
   })

   it("a busy mutex skips the tick entirely", async () => {
      refresh.init(async () => false, updated)
      expect(await refresh.refreshNow()).toBe("")
      expect(data.refresh).not.toHaveBeenCalled()
   })
})

describe("triggers", () => {
   it("visibilitychange → visible refreshes, throttled to one per minute", async () => {
      refresh.init(exclusive, updated)
      const fire = () => document.dispatchEvent(new Event("visibilitychange"))
      fire()
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh).toHaveBeenCalledTimes(1)
      fire() // within the throttle window
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(61_000)
      fire()
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh.mock.calls.length).toBeGreaterThanOrEqual(2)
   })

   it("the 5-minute heartbeat fires while visible", async () => {
      refresh.init(exclusive, updated)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(data.refresh).toHaveBeenCalled()
   })

   it("online refreshes immediately", async () => {
      refresh.init(exclusive, updated)
      window.dispatchEvent(new Event("online"))
      await vi.advanceTimersByTimeAsync(0)
      expect(data.refresh).toHaveBeenCalledTimes(1)
   })
})
```

(jsdom's `document.visibilityState` is `"visible"` by default, which is what the trigger tests need.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/js/refresh.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `frontend/src/js/refresh.ts`:**

```ts
// refresh.ts — live content sync: an open tab silently adopts a newer store
// snapshot (spec: docs/superpowers/specs/2026-07-06-frontend-content-sync-design.md).
// Owns the TRIGGERS only, mirroring sync.ts's shape (lifecycle wiring +
// throttle, no DOM): the state swap is data.refresh(), the downstream
// reconciliation is search.invalidate() + nav.onStoreRefreshed() + the UI
// routine app.ts injects. Every check is one conditional GET of db.gz (a 304
// when the store hasn't moved), so the cadence is cheap by design.
//
// Runs under app's guard mutex (injected as `exclusive`) so the swap can never
// interleave with a navigation; a busy mutex SKIPS the tick — the next trigger
// retries — rather than queueing.
import * as data from "./data"
import * as nav from "./nav"
import * as search from "./search"

const FOCUS_MIN_INTERVAL_MS = 60_000 // at most one check per minute on re-focus
const POLL_INTERVAL_MS = 300_000 // plus a 5-minute heartbeat while visible

let lastAttempt = 0 // ms; attempt-based like sync.ts, so failures aren't hammered
let lastError = ""
let runExclusive: (fn: () => Promise<void>) => Promise<boolean> = async (fn) => (await fn(), true)
let onUpdated: () => void = () => {}

// The last cycle's failure ("" = healthy) — the config status line reads it.
export function lastRefreshError(): string {
   return lastError
}

// One refresh cycle. Resolves to "" on success or a skipped (busy) tick, else
// the error message — the manual Sync-now path popups it; background triggers
// ignore the return and leave it on the status line. Offline failures stay
// silent, like sync.ts — the SW makes offline reading a supported state.
export async function refreshNow(): Promise<string> {
   lastAttempt = Date.now()
   let result = ""
   await runExclusive(async () => {
      try {
         if ((await data.refresh()) === "updated") {
            search.invalidate()
            await nav.onStoreRefreshed()
            onUpdated()
         }
         lastError = ""
      } catch (e) {
         if (navigator.onLine !== false) {
            lastError = e instanceof Error ? e.message : String(e)
            result = lastError
         }
      }
   })
   return result
}

function due(): boolean {
   return Date.now() - lastAttempt >= FOCUS_MIN_INTERVAL_MS
}

// Wire the lifecycle: throttled re-check on tab re-focus, immediate on regained
// connectivity, a slow heartbeat while visible. `exclusive` = app's background
// guard (false = busy, skip); `updated` = app's after-refresh UI routine.
export function init(exclusive: (fn: () => Promise<void>) => Promise<boolean>, updated: () => void): void {
   runExclusive = exclusive
   onUpdated = updated
   document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && due()) void refreshNow()
   })
   window.addEventListener("online", () => void refreshNow())
   setInterval(() => {
      if (document.visibilityState === "visible" && due()) void refreshNow()
   }, POLL_INTERVAL_MS)
}
```

- [ ] **Step 4: Run** — `npx vitest run src/js/refresh.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add frontend/src/js/refresh.ts frontend/src/js/refresh.test.ts && git commit -m "feat(frontend): refresh.ts — live content-sync triggers"`

---

### Task 9: app.ts + config.ts + skeletons — Sync now wiring

**Files:**
- Modify: `frontend/src/js/app.ts`, `frontend/src/js/config.ts`
- Modify: `frontend/src/index.html`, `frontend/src/design.html` (identical edit — the design.test.ts drift guard enforces it)
- Test: `frontend/src/js/config.test.ts` (+ `frontend/src/js/app.test.ts` mock; `frontend/src/js/design.test.ts` must stay green)

- [ ] **Step 1: Skeletons.** In `index.html`, inside `.srr-config-actions` after the sync button (line ~166), add:

```html
                  <button type="button" class="srr-config-refresh" aria-label="Sync now">
                     <svg class="srr-config-action-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7" />
                     </svg>
                     <span class="srr-config-action-label">Refresh</span>
                  </button>
```

Apply the byte-identical block to `src/design.html` at the same spot. No new CSS: the generic `.srr-config-actions` button styles apply. Run `npx vitest run src/js/design.test.ts` → PASS.

- [ ] **Step 2: config.ts.** Add to `ConfigHooks`:

```ts
   // Sync now: content refresh + a manual (pure-LWW) profile cycle.
   onRefresh: () => void
```

In `setup()`, after the sync-button line:

```ts
   ;(el.querySelector(".srr-config-refresh") as HTMLElement).addEventListener("click", () => hooks.onRefresh())
```

In `refreshStatus()`: import `* as refresh from "./refresh"`, extend the signature/sig-string and rows:

```ts
   const refreshErr = refresh.lastRefreshError()
   const sig = `${fetchedAt}|${stale}|${metaMissing}|${idxDegraded}|${syncState.on}|${syncState.okAt}|${syncState.error}|${syncState.parked}|${refreshErr}`
```

…and after the existing sync readout block:

```ts
   if (syncState.on && syncState.parked)
      statusBox.append(statusFlag("Sync paused — read progress would rewind. Sync now to resolve."))
   if (refreshErr) statusBox.append(statusFlag(`Refresh failed — ${refreshErr}`))
```

- [ ] **Step 3: config.test.ts.** Add `.srr-config-refresh` to the seeded DOM skeleton (wherever `.srr-config-sync` is seeded) and `onRefresh: vi.fn()` to every hooks literal/factory. Add one test:

```ts
it("the refresh quick-action fires onRefresh", () => {
   ;(document.querySelector(".srr-config-refresh") as HTMLElement).click()
   expect(hooks.onRefresh).toHaveBeenCalledTimes(1)
})
```

(If config.test.ts mocks `./sync`'s `state()`, add `parked: false` to the mocked return; mock `./refresh` as `{ lastRefreshError: () => "" }`.)

- [ ] **Step 4: app.ts.** Import `* as refresh from "./refresh"`. After `guard()` add:

```ts
// The background variant of guard(): same busy mutex, no render/error popup — a
// caller that loses the race is skipped, not queued (its next trigger retries).
// Used by the store refresh so a state swap can't interleave with navigation.
async function guardBg(fn: () => Promise<void>): Promise<boolean> {
   if (busy) return false
   busy = true
   try {
      await fn()
      return true
   } finally {
      busy = false
   }
}
```

In `init()`, after the `refreshAfterMerge` definition add:

```ts
   // Shared reconciliation after a store refresh adopted a newer db.gz — the
   // fully-silent contract: no reload, no scroll, no content re-render. The
   // toolbar label re-derives, the reader's prev/next chrome re-probes (a cached
   // "no newer article" is exactly what new content invalidates), the list
   // reopens its top, and an open config repaints its freshness line.
   const refreshAfterStore = () => {
      refreshFeedLabel()
      if (view === "reader") {
         void nav
            .probeCurrent()
            .then((o) => {
               if (o && view === "reader") {
                  el.prev.disabled = !o.has_left
                  el.next.disabled = !o.has_right
                  syncNextCount(o)
               }
            })
            .catch(() => {})
      } else {
         void list.onStoreGrown()
      }
      if (config.isOpen()) config.render()
   }

   // Sync now (config quick-action): make this browser current in both
   // directions — the content refresh and a manual (pure-LWW, always-push)
   // profile cycle, run concurrently (they're independent). Content errors get
   // the popup (the one user-initiated path); sync errors stay on the status
   // line as always. Config stays open so its freshness line confirms the result.
   const manualSyncNow = async () => {
      const [contentErr] = await Promise.all([refresh.refreshNow(), sync.syncNow({ manual: true })])
      if (config.isOpen()) config.render()
      if (contentErr) showError(new Error(contentErr))
   }
```

Add to the `config.setup` hooks object:

```ts
      onRefresh: () => void manualSyncNow(),
```

And after `sync.init(...)` (line ~953):

```ts
   // Live content sync: boot is already fresh (data.init just ran), so only the
   // ongoing triggers are wired — re-focus (throttled), reconnect, heartbeat.
   refresh.init(guardBg, refreshAfterStore)
```

- [ ] **Step 5: app.test.ts.** If it fails on the new import, mock it the way `./sync` is mocked there:

```ts
vi.mock("./refresh", () => ({
   init: vi.fn(),
   refreshNow: vi.fn(async () => ""),
   lastRefreshError: vi.fn(() => ""),
}))
```

- [ ] **Step 6: Run** — `npx vitest run` (full unit suite) → PASS.
- [ ] **Step 7: Commit** — `git add frontend/src/js/app.ts frontend/src/js/config.ts frontend/src/js/config.test.ts frontend/src/js/app.test.ts frontend/src/index.html frontend/src/design.html && git commit -m "feat(frontend): Sync now quick-action — wire live content sync into the UI"`

---

### Task 10: contract e2e — the refresh matrix on a real store

**Files:**
- Create: `frontend/e2e/contract/refresh.e2e.test.ts`

- [ ] **Step 1: Write the test** (model: `incremental.e2e.test.ts`; note `mountReader` must serve store files per-request — verify in `mount.ts` that the fetch shim reads from disk at fetch time, which it does for the seq-advance test in `search.e2e.test.ts` to work):

```ts
import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { feedServer, inspectValidate, makeStore, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"
import { mountReader } from "./mount"

// The live content-sync contract: ONE mounted reader instance adopts a second
// backend fetch cycle in place via data.refresh() — no remount, no reload —
// and navigates to the new articles.

describe("contract: in-place refresh across a fetch cycle", () => {
   let feeds: FeedServer
   let store: string
   let reader: Awaited<ReturnType<typeof mountReader>>
   const all = nItems(5, "alpha")

   beforeAll(async () => {
      feeds = await feedServer({ "/a.xml": rssFeed("Alpha", all.slice(0, 3)) })
      store = makeStore()
      await srr(store, "feed", "add", "-t", "Alpha", "-u", `${feeds.url}/a.xml`)
      await srr(store, "art", "fetch")
      reader = await mountReader(store)
   })

   afterAll(async () => {
      await feeds?.close()
      if (store) rmSync(store, { recursive: true, force: true })
   })

   it("refresh() with no backend run is 'unchanged'", async () => {
      expect(await reader.data.refresh()).toBe("unchanged")
      expect(reader.data.db.total_art).toBe(3)
   })

   it("adopts a new fetch cycle in place: totals, seq, and new-article navigation", async () => {
      feeds.set("/a.xml", rssFeed("Alpha", all))
      await srr(store, "art", "fetch")
      expect(await reader.data.refresh()).toBe("updated")
      expect(reader.data.db.total_art).toBe(5)
      expect(reader.data.db.seq).toBe(2)
      // The SAME instance reads the new articles (fresh latest pack, cleared caches).
      for (let i = 0; i < 5; i++) expect((await reader.data.loadArticle(i)).t).toBe(all[i].title)
      // countAll over the full store reflects the growth without a remount.
      expect(reader.data.countAll(new Map([[1, 0]]))).toBe(5)
   })

   it("a second refresh with nothing new is 'unchanged' again", async () => {
      expect(await reader.data.refresh()).toBe("unchanged")
   })

   it("adopts a gen bump (in-place rebuild signal) through the same path", async () => {
      await srr(store, "gen", "--bump")
      expect(await reader.data.refresh()).toBe("updated")
      expect((await reader.data.loadArticle(4)).t).toBe(all[4].title) // still readable
   })

   it("backend inspect --validate agrees", async () => {
      expect(await inspectValidate(store)).toContain("OK: all checks passed")
   })
})
```

(Adjust the `countAll` feed-id argument to the store's actual feed id — check `reader.data.db.feeds`; the single feed is id 1 with the existing harness.)

- [ ] **Step 2: Run** — from repo root `make test-contract` → PASS.
- [ ] **Step 3: Commit** — `git add frontend/e2e/contract/refresh.e2e.test.ts && git commit -m "test(e2e): in-place refresh contract — one reader instance across fetch cycles"`

---

### Task 11: browser e2e — Sync now in the real SPA

**Files:**
- Create: `frontend/e2e/browser/refresh.e2e.test.ts`

- [ ] **Step 1: Write the test** (model the boot/teardown on `titleless.e2e.test.ts` — the smaller standalone example; `baseUrl`/`packsDir` come from `inject`):

```ts
import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import puppeteer, { type Browser, type Page } from "puppeteer"

import { feedServer, srr, type FeedServer } from "../harness"
import { nItems, rssFeed } from "../fixtures"

// Live content sync in the real SPA: publish a second fetch cycle to the pack
// dir while a page is open, tap the Sync-now quick action, and the new article
// is reachable WITHOUT a page reload.

const baseUrl = inject("baseUrl")
const packsDir = inject("packsDir")

const items = nItems(3, "live")

describe("browser: in-place refresh via Sync now", () => {
   let browser: Browser
   let page: Page
   let feeds: FeedServer

   beforeAll(async () => {
      feeds = await feedServer({ "/live.xml": rssFeed("Live", items.slice(0, 2)) })
      for (const f of readdirSync(packsDir)) rmSync(join(packsDir, f), { recursive: true, force: true })
      await srr(packsDir, "feed", "add", "-t", "Live", "-u", `${feeds.url}/live.xml`)
      await srr(packsDir, "art", "fetch")
      browser = await puppeteer.launch({ args: ["--no-sandbox"] })
      page = await browser.newPage()
   }, 120_000)

   afterAll(async () => {
      await browser?.close()
      await feeds?.close()
   })

   it("a tab picks up a new fetch cycle without reloading", async () => {
      await page.goto(`${baseUrl}/#`, { waitUntil: "networkidle0" })
      await page.waitForSelector(".srr-list a.srr-row")
      // Stamp the window so we can prove no reload happened.
      await page.evaluate(() => ((window as unknown as Record<string, unknown>).__srrStamp = 1))

      feeds.set("/live.xml", rssFeed("Live", items))
      await srr(packsDir, "art", "fetch")

      // Sync now from the config surface.
      await page.click(".srr-settings")
      await page.waitForSelector(".srr-config-refresh")
      await page.click(".srr-config-refresh")

      // The new article becomes navigable: deep-step to it via the list (the
      // silent contract means rows arrive on scroll — assert via nav totals).
      await page.waitForFunction(
         () => (document.querySelector(".srr-config-status")?.textContent ?? "").includes("Last updated"),
         { timeout: 20_000 },
      )
      const stamp = await page.evaluate(() => (window as unknown as Record<string, unknown>).__srrStamp)
      expect(stamp).toBe(1) // same page instance — no reload
      // Open the newest article via hash navigation on the LIVE tab (total_art
      // grew to 3, so chron 2 must resolve to the new item).
      await page.evaluate(() => (location.hash = "#2"))
      await page.waitForFunction(
         (want: string) => document.querySelector(".srr-title")?.textContent === want,
         { timeout: 20_000 },
         items[2].title,
      )
   }, 120_000)
})
```

- [ ] **Step 2: Run** — from repo root `make test-browser` → PASS (needs the puppeteer Chromium; CI runs it on push regardless).
- [ ] **Step 3: Commit** — `git add frontend/e2e/browser/refresh.e2e.test.ts && git commit -m "test(e2e): browser — Sync now adopts a new fetch cycle without reload"`

---

### Task 12: docs + full verify

**Files:**
- Modify: `frontend/CLAUDE.md` (⚠ dirty-file check — the concurrent session has it modified)

- [ ] **Step 1:** Update `frontend/CLAUDE.md`: add `refresh.ts` to the module table (trigger owner: refocus/online/heartbeat/manual → `data.refresh()` chain under `guardBg`); update the `sync.ts` row (v2 LWW blob, `regressiveSeen` guard, parked state, manual mode; `pushSoon` stamps `PROFILE_TS_KEY`); update `profile.ts` (v2 + adopt), `data.ts` (`refresh()`, `applyDb`), `search.ts` (`invalidate`), `list.ts` (`onStoreGrown`), `nav.ts` (saved-mode peek exemption, `onStoreRefreshed`, `probeCurrent`), `keys.ts` (`PROFILE_TS_KEY`), config quick-action list (… backup · sync · **refresh**), and the spec pointer. Mention the design spec path.
- [ ] **Step 2:** Run `make verify` from the repo root → PASS.
- [ ] **Step 3:** Commit the docs (only if `frontend/CLAUDE.md`'s pre-existing foreign hunks are resolved — otherwise report to the user and stop): `git commit -m "docs(frontend): live content sync + LWW profile sync"`

---

## Self-review checklist (done at plan time)

- **Spec coverage:** content sync (Tasks 4–9), announce-silent (7, 9), Sync now (9), LWW v2 (1–2), regression guard incl. flush (2), saved peek mode (3), search invalidation (5), filter stability (6), error posture (2, 8, 9), testing matrix (all), CLAUDE.md (12). Out-of-scope items untouched.
- **Type consistency:** `refreshNow(): Promise<string>`; `syncNow(opts?: {manual?: boolean})`; `SyncState.parked`; `importProfile(json, {prefs, adopt?})`; `onStoreGrown(): Promise<void>`; `onStoreRefreshed(): Promise<void>`; `probeCurrent(): Promise<IShowFeed | null>` — used identically across tasks.
- **Known adaptation points (not placeholders):** test-helper names in `nav.test.ts`/`list.test.ts`/`search.test.ts` mock scaffolding must be matched to those files' existing factories; the behavior being asserted is fully specified.
