# Design: live content sync + LWW profile sync

Date: 2026-07-06
Status: implemented 2026-07-06

## Goal

An already-open tab has no way to pick up new articles short of a full page
reload: `data.ts` fetches `db.gz` once at module load and every derived
structure (`db`, `idxHeaders`, latest packs, feed groupings) is frozen at
`init()`. This design adds **in-place content sync** — the tab silently
adopts a newer store snapshot with no reload and no viewport disruption —
plus one manual **"Sync now"/Refresh** affordance, and changes the profile
sync (`sync.ts`) merge semantics to **whole-blob last-write-wins**.

The data model already cooperates: chronIdx addresses are append-only stable,
finalized packs are immutable, and the SW makes pack refetches near-free —
new content only ever appends above the old frontier.

## Decisions (settled in brainstorming)

| Question | Decision |
|---|---|
| Sync UX | **Seamless in-place** (`data.refresh()` swaps state in memory). Notify-then-reload and manual-only rejected. |
| Announce | **Fully silent.** No pill, no live prepend: counts/badges tick up, the LATEST terminus reopens, newer rows are reachable by scrolling up. |
| Manual affordance | **One "Sync now"** config quick-action (neutral copy: "Refresh") running content refresh + profile cycle; content half works with sync disabled. Separate push/pull buttons rejected (bare PUT is the clobber race the engine avoids). |
| Profile merge rule | **Whole-blob last-write-wins** (explicit user choice over the recommended endpoint-ends-up-current option): the newest push replaces the endpoint; a pull adopts remote wholesale when remote is newer. The lost-update risk this opens is gated by the **Progress regressions** rule below — losing read progress always takes a manual Sync now. |
| LWW ordering field | **Device-clock unix timestamp** of the last local mutation (human-debuggable; clock skew a non-issue for one person's devices). Lamport counter rejected. |
| Refresh mechanism | **Full re-init** (Approach A): re-run the boot path when db.gz moved. Incremental delta patching rejected — duplicates init's edge cases (hdrs lag, eager fallback, meta coverage, empty→non-empty) to save milliseconds of SW-cached refetch. |
| `gen` change | Same in-place path (full re-init discards everything anyway; the SW purge rides the same db.gz response). The `assertPackOk` guarded reload stays as backstop. |
| Prefs under LWW | Still **carried but never applied** on pull (as today) — view modes don't teleport between devices. |
| Backup file dialog | Keeps the v1 **monotone merge** semantics (an explicit restore tool should never silently discard). |
| ★ Saved viewing | **Peek mode**: `recordSeen` exempts saved mode exactly like `q:` search (`if (filter.search \|\| filter.saved) return`). Re-reading an archived item is not a read-through — today it rewinds the article's own feed's resume position (exact-pos semantics), a rewind LWW would then propagate to every device. Trade accepted: an unread saved article stays unread until read in its feed — the same trade search mode already makes. |
| Progress regressions | **Background sync never decreases read progress.** Any automatic pull-adoption or push-replacement that would lower a feed's seen position (or drop a feed's seen key) is skipped and flagged on the config status line; only the manual **Sync now** applies pure LWW in both directions. The guard covers the seen axis only — saved-set changes (including un-saves) always propagate, since deletions propagating was LWW's point. |

## Content sync

### `data.ts` — re-runnable boot

- The module-load `const dbFetch = fetch(...)` becomes a `fetchDb()` function;
  module load still calls it eagerly so boot and the HTML `<link rel=preload>`
  are unchanged.
- New `refresh(): Promise<"unchanged" | "updated">`:
  1. Re-fetch db.gz (`cache: "no-cache"` — an unmoved store is a cheap 304,
     served through the SW's network-first db.gz route, so `checkManifest`'s
     gen-purge / seq-prune rides the same response and lands before any
     subsequent pack fetch — the race-free ordering that already exists).
  2. Compare `{fetched_at, total_art, seq, gen}` to the live snapshot;
     identical → `"unchanged"`.
  3. Otherwise re-run the `init()` body wholesale: rebuild `db`, `slots`,
     `expiredCounts`, `idxHeaders`, refetch the latest idx pack (+ summary via
     the existing fast/eager paths), recreate `idxFetches`, and clear
     `dataCache`, `metaCache`, `groupCache`.
- A `fetched_at`-only change (zero-article backend cycle, feed vitals/ferr
  updates, expiration advance) still re-inits: ~3 requests, all SW/HTTP-cache
  hits, one code path — and the config freshness line + feed health tints go
  live for free.

### `refresh.ts` (new) — trigger owner

Mirrors `sync.ts`'s lifecycle shape but stays a separate module so `sync.ts`
remains profile-pure (unit-testable without data.ts):

- Triggers: tab-refocus (`visibilitychange` → visible, throttled ≥60 s since
  the last attempt), `online`, a 5-minute interval while visible, and manual
  `refreshNow()`.
- Runs `data.refresh()` through app's injected `guard()` so state never swaps
  mid-navigation; a busy guard skips the background tick (next trigger
  retries). On `"updated"` it invokes the injected after-refresh routine.

### `nav.ts` — `onStoreRefreshed()`

**No filter re-snapshot** — re-applying tokens would re-raise unseen-only
bounds past articles read this session and yank the walk. Instead:

- Raise each existing member feed's bound monotonically:
  `bound = max(oldBound, feed.add_idx_new)` (adopts expiration, never
  re-snapshots seen).
- Add feeds that newly joined the scope (a new feed under [ALL], a feed newly
  tagged into the active tag) with fresh bounds.
- `pos` is untouched (chronIdx is a permanent address; `total_art` only grew).
- Clear the `nextLeft`/`nextRight` neighbor slots and re-probe — a cached
  "no right neighbor" at the newest article is exactly what new content
  invalidates. Existing prefetch freshness/abort discipline is preserved.
- Active `q:` filter: `search.invalidate()` then re-run `ensureSearchSet`;
  the existing supersession guard absorbs the swap.

New articles need no bound work at all: they sit above every existing bound,
so `matches`/`findRight` see them automatically.

### `nav.ts` — ★ Saved becomes a peek mode

`recordSeen` gains the saved-mode exemption beside the existing search one:
`if (filter.search || filter.saved) return`. Saved mode already kept
`filter.feeds` empty (no cross-feed frontier raise); this removes the last
side effect — the own-feed exact-position rewind — so opening an old saved
article touches no seen state at all. List-row taps in the Saved view route
through the same `resolve()` path, so the exemption covers both surfaces.
Bare deep links (`#pos` under [ALL]) deliberately keep today's semantics —
arriving somewhere and stepping around *is* reading.

### `list.ts` — reopen the top

On an `"updated"` refresh: clear `exhaustedTop`, remove the LATEST terminus
(`syncTopTerminus`), re-observe the top sentinel — newer rows page in only
when the user scrolls up (the "fully silent" contract; the existing prepend
scroll-compensation already handles the mechanics). `refresh()` re-derives
row state; an empty-store or all-caught-up empty state gets a `rerender()`.

### `search.ts`

New `invalidate()`: drop the lazy summary/tail slots and the query-keyed hit
LRU. Next query re-reads; SW-cached finalized shards make it cheap.

### `app.ts` + `config.ts`

- New quick-action in the config icon bar (search · unread · image-proxy ·
  backup · sync · **refresh**). Tap = `refreshNow()` + profile `syncNow`
  (concurrently — they're independent); errors from the manual path surface
  via the `guard()` popup, background errors only on the config status line.
- After-refresh routine (mirrors sync's merged callback):
  `nav.onStoreRefreshed()` → `refreshFeedLabel` + list refresh/reopen +
  `config.render()` when open + reader neighbor/pending-count re-probe
  (`has_right`/`right_count` update without a step).

## Profile sync v2 (whole-blob LWW)

- Blob becomes `{v: 2, ts, seen, saved, prefs}`; `ts` = unix seconds of the
  last local **seen/saved** mutation, persisted under a new `keys.ts`
  constant (`srr-profile-ts`), stamped by the existing mutation seams
  (`recordSeen`/`toggleSaved`). Pref changes do NOT stamp `ts` — prefs are
  never applied on pull, so a mere pref flip must not make this device
  "newest" and cause another device's real progress to be discarded.
- **Regression test** (the guard's predicate): incoming state `S_new` is
  *regressive* vs current state `S_cur` iff some feed key in `S_cur.seen` is
  absent in `S_new.seen` or maps to a lower chronIdx. Seen axis only — the
  saved set is never part of the predicate.
- **Pull**: `remote.ts > local.ts` → adopt wholesale (replace seen/saved;
  prefs carried, not applied), set local ts = remote ts — **unless the remote
  blob is regressive vs local**, in which case a background cycle parks
  (no adopt, no push — pushing would clobber a newer remote), flags the
  config status line ("read progress would rewind — Sync now to resolve"),
  and waits for a manual resolution. `remote.ts <= local.ts` → keep local.
  404 = nothing stored yet (not an error). Each pull caches the remote blob's
  seen map + ts in memory for the push-side checks below.
- **Push** (background: `pushSoon` debounce, post-pull-when-dirty): PUT the
  blob (its `ts` = local last-mutation time) — **unless it is regressive vs
  the last-pulled remote seen map**, in which case the push parks the same
  way (dirty stays set, status line flags manual).
- **Manual Sync now**: pure LWW, both directions, no guard — pull-adopt
  wholesale when remote is newer (regressive or not), then always PUT the
  result. The human tap is the authorization to decrease read progress;
  after it, device and endpoint agree on the ts-newest state.
- **v1 legacy**: a v1 blob pulled from the endpoint gets one monotone merge
  (old rules: seen max, saved union), a fresh ts stamp, and is overwritten
  as v2 on the next push. The backup file dialog keeps v1 merge semantics on
  import (export writes v2).
- **flush()**: the pagehide keepalive PUT has no time to pre-pull, so it
  reuses the cached last-pulled remote snapshot: skip when
  `local.ts < lastRemoteTs` (a stale tab must not replace a newer blob with
  an older one) or when the blob is regressive vs that snapshot. Skipping
  leaves the dirty flag set, so the next full cycle — which pulls first —
  handles it. A tab that never pulled (sync just enabled) flushes
  unguarded, as today.

## Error handling

Same posture as profile sync today: offline failures stay silent
(`navigator.onLine`), the last refresh error surfaces on the config status
line next to the sync readout; only the manual button routes to the error
popup. `assertPackOk`'s sessionStorage-guarded reload remains the ultimate
backstop. In-flight neighbor prefetches racing a refresh are benign (their
promises resolve into dropped/rebuilt caches; nav's freshness tokens already
gate consumption).

## Testing

- **Unit**: `data.refresh` matrix (unchanged-304 / seq bump / gen change /
  fetched_at-only / empty→non-empty); nav bound-raising rules + neighbor-slot
  clearing; saved-mode `recordSeen` exemption (open old saved article →
  seen map byte-identical, from both reader and list-row paths); sync LWW
  matrix (remote newer / local newer / tie / v1 legacy / 404 / offline);
  regression-guard matrix (regressive newer remote parks pull AND push +
  flags status; regressive local parks background push, dirty persists;
  manual Sync now overrides both directions; flush skips on older-ts or
  regressive blob, flushes unguarded when never pulled); list top-reopen
  after exhaustion; `search.invalidate`.
- **Contract e2e**: extend the `incremental` suite — mount the real reader,
  run a second real `srr` fetch that adds articles, call `refresh()`, assert
  the new article is navigable in place and counts match `srr inspect`.
- **Browser e2e**: open the built SPA, publish a second fetch cycle to the
  pack dir, tap Refresh, assert the new article is reachable without a page
  reload (and the LATEST terminus reopened).
- Update `frontend/CLAUDE.md` (module table: `refresh.ts`, sync v2 semantics)
  and the root `CLAUDE.md` if any contract-adjacent wording changes.

## Out of scope

- Any backend/pack-format change (none needed — the reader adopts what the
  writer already publishes).
- Push-style notification (SSE/WebSocket) — the store is static hosting by
  design; polling conditional GETs are the contract.
- Auto-pinning new content into the offline pin buckets (pins stay snapshots).
