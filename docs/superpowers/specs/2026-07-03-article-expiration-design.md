# Design: per-feed article expiration

Date: 2026-07-03
Status: implemented 2026-07-03

## Goal

A per-feed retention policy: articles older than X days are **logically deleted**
(the feed's `add_idx` is bumped past them, so every read path skips them) and
their self-hosted `assets/…` objects are **physically deleted** (the heavy
bytes — the actual storage this reclaims). Data/idx/meta packs are never
rewritten: finalized packs are immutable by contract, and chronIdx must remain
a permanent address (★ Saved depends on it).

Motivating case: high-volume media feeds (e.g. the Telegram ingest) grow the
store's `assets/` prefix without bound; their old articles have no long-term
value.

## Decisions (settled in brainstorming)

| Question | Decision |
|---|---|
| Expiration clock | **`fetched_at`** (age in store). Globally monotone in chron order — the expired set per feed is always a contiguous prefix, exactly what `add_idx` models. `published` rejected: non-monotone (one fresh item would block the prefix behind it) and a late-imported backlog would expire before being read. |
| Trigger | **Automatic, every fetch cycle** — a warn-only step like `SyncMeta`/GC sweeps. No standalone command. |
| Config surface | **CLI + serve webui**: `feed add/upd -e/--expire-days`, `feedView.expire_days` (edit/apply/ls/show + serve API), webui feed-editor field. |
| Expired-article edges | **Search filtered, ★ Saved kept, out-feeds filtered**: the frontend skips search hits with `chron < add_idx` (consistent with list/nav); saved articles stay readable forever (immutable packs) with media collapsed once assets are gone. Deep links likewise still resolve. Syndication out-feeds are a filtered read path too: `SyncOutFeeds`' walk skips `chron < add_idx`, and `outFeedsSig` includes each feed's `AddIdx` so an expiration advance alone rewrites the outputs. |
| Asset GC | **Delete without liveness check** (explicit user choice over the recommended live-scan): every `assets/…` key referenced by a newly-expired article is deleted, even if a live article shares it. Accepted risk — see Trade-offs. |
| Counters | Neither `db.gz total_art` nor per-feed `total_art` changes (both are format atoms — see below). A new per-feed **`Expired`** counter (`xp`) keeps reader-side counting exact. |

## Data model (db.gz)

Two new fields on `Feed` (backend `feed.go`, emitted to `IFeedWire` by `srr gen-ts`):

- `ExpireDays int` — JSON **`exp,omitempty`**. 0/absent = never expire (default,
  and the wire default for every existing store — no migration).
- `Expired int` — JSON **`xp,omitempty`**. Cumulative count of this feed's
  expired idx entries, bumped by each expiration event. Starts at 0 on
  `AddFeed` (including id reuse — a fresh incarnation has expired nothing).

**Why the existing counters must NOT change:**

- **`db.gz total_art` (store-level)** is the chronIdx addressing atom: finalized
  pack counts (`floor((total_art−1)/50000)`), latest-pack entry count, meta
  coverage (`mp·5000 + mt == total_art`), clamping. It counts articles ever
  written to packs and never decreases.
- **Per-feed `total_art`** is the *writer's source for the idx header cumulative
  feedCounts* (`writeIdxHeader` in `db_pack.go`). Finalized headers are
  immutable; decrementing `TotalArt` would publish a next header *lower* than
  its predecessor — negative per-pack deltas, breaking the reader's
  header-delta pack-skip and inspect's `checkFeedCountsContinuity`. It stays
  the all-time count (since the feed id's current incarnation).

**Why `Expired` is needed (the counting invariant):** the reader's `countLeft`
(idx.ts) trusts the header cumulative count wholesale for any filtered feed
whose `add_idx` is before the pack's base. That is sound today because
`add_idx` is only ever set at the store frontier (`AddFeed`), where `TotalArt`
resets in tandem. Expiration moves `add_idx` into mid-history where immutable
headers already counted the expired prefix — without correction, `countAll`,
unread badges, tag sums, and the next-pill `right_count` over-count by the
expired amount, growing without bound. The correction is one subtraction:

> For any pack P with `add_idx < P.baseChron`:
> visible-before-P == header.feedCounts[f](P) − xp

This holds across id reuse too: pre-incarnation packs are never consulted under
that condition (their bases are ≤ the incarnation's initial `add_idx`), and
post-incarnation headers count since-incarnation entries, of which exactly `xp`
are below `add_idx`.

## Backend

### `db_expire.go` — `ExpireArticles(ctx, now int64) error`

1. Collect feeds with `ExpireDays > 0`. For each, `cutoff = now − ExpireDays·86400`.
   Compute `minStart = min(add_idx)` over them and `maxCutoff = max(cutoff)`.
   No such feeds → return nil (the common no-op cycle costs nothing).
2. One `walkArticles(minStart → TotalArticles)` pass, **early-stopped at the
   first article with `fetched_at ≥ maxCutoff`** (global `fetched_at`
   monotonicity makes this bound correct — the walk only ever reads packs in
   the expired-age window, not the whole store; first enablement on a feed
   with an old backlog pays that window walk once, and the dormant-feed
   frontier advance — see Implementation deltas — keeps the steady-state
   window bounded by ingestion since the last cycle, not dead time). For each
   article whose
   feed is expiring, `chron ≥ its add_idx`, and `fetched_at < its cutoff`:
   - record `newAddIdx[feed] = chron + 1`, `newlyExpired[feed]++`
   - harvest `assets/…` keys from its content (see below)
3. Nothing expired → return nil. Otherwise `Rm` each harvested key (`Rm` is
   silent-on-missing by contract). **Any Rm failure aborts the step** without
   applying any `add_idx`/`Expired` change: the next cycle recomputes the same
   window and retries — already-deleted keys are silent-missing no-ops, so the
   retry is idempotent.
4. All deletes succeeded → apply in-memory: `feed.AddIdx = newAddIdx` (only
   ever forward — the walk starts at the current `add_idx`),
   `feed.Expired += newlyExpired`; log one INFO summary (articles expired,
   assets deleted, per feed).
5. Caller commits.

Boundary semantics: an article expires iff `fetched_at < cutoff` (strictly
older than X days). `now` is a parameter for unit-test injection; production
passes wall clock.

**Asset-ref harvesting** reuses the element/attr walk in `db_out.go`: factor
the `outAssetAttrs` traversal into a shared helper (walk `img/video/audio src`,
`video poster`, `a href`; collect values matching the `assets/` key shape) so
`rewriteAssetURLs` and the harvester can't drift. Keys are deduped in-run;
articles with no `assets/` substring skip the HTML parse (same fast-path as
`rewriteAssetURLs`).

### Fetch-cycle placement (`cmd_fetch.go`)

After `SyncMeta`, **before `SyncOutFeeds`** (implementation delta from this
spec's draft, which had expire after the out-feed sync — expire-first means the
same cycle's syndication already excludes what just expired) — warn-only like
the sync steps:

```
PutArticles → SyncIdxSummary → SyncMeta → ExpireArticles → SyncOutFeeds → Commit → GC sweeps
```

An expiration failure logs WARN, leaves the in-memory `AddIdx`/`Expired`
untouched (abort-all, per step 3), and never blocks committing the cycle's
fetch results. `srr serve --interval` inherits the step for free — it drives
the same `FetchCmd.fetchLoop`. A *persistently* failing Rm (e.g. a store
permission bug on one key) blocks expiration progress loudly — one WARN per
cycle — rather than silently leaking; the re-walk it causes is bounded by the
expired-age window.

**Crash-safety:** asset deletes happen *before* the `add_idx` bump is
published. A crash mid-delete leaves `add_idx` unchanged → the next cycle
recomputes the same window and re-deletes (missing-tolerant Rm). No orphan
leak, no pending-delete bookkeeping. The cosmetic window — a reader with the
pre-crash db.gz can navigate to a just-expired article and see collapsed
media — concerns only articles already past retention, and heals on reload.

### CLI + serve

- `feed add` / `feed upd`: new `-e/--expire-days N` flag (0 clears).
- `feedView` gains `expire_days` (settable) and read-only `expired` (reported
  like `error`, never applied back) → `feed ls/show/edit/apply` and the serve
  feed API round-trip it for free.
- `serve_overview.go`: feed projection gains `expire_days`; the projected
  per-feed article count and the tag buckets (`tc.Articles`) become **live
  counts** (`TotalArt − Expired`) — the overview is a display projection.
- Webui feed editor (`webui/app.js`): numeric "Expire days" field (empty/0 =
  keep forever).
- `srr inspect`: `--validate`'s db-meta check — the "first idx occurrence <
  add_idx" issue is now expected behavior; replace with `add_idx ≤
  total_articles` and `0 ≤ xp ≤ total_art` sanity checks. `total_art == idx
  count` stays (expiration changes neither side). `--filter` count math
  subtracts `Expired` to keep mirroring the frontend.
- `make generate`: `format.gen.ts` regenerated (`IFeedWire.exp?`, `xp?`).

## Frontend

- **Counting correction (`idx.ts` / `data.ts`)**: at `countLeft`'s
  header-shortcut site (`addIdx < baseChron → count += feedCounts[f]`),
  subtract the feed's `xp` (clamped ≥ 0 defensively). Plumbing: a parallel
  per-feed expired lookup built by `data.ts` from `db.feeds` and threaded
  beside the existing `lookup` Int32Array (the `filter.feeds` Map keeps its
  `feed_id → addIdx` shape — no call-site churn). `countAll`, unread badges,
  tag sums, and `right_count` all ride this one site; `findLeft`/`findRight`/
  `hasCandidate` filter per-entry or gate on `addIdx < packEnd` and need
  nothing.
- **Search filtering (`search.ts`)**: skip hits whose feed exists and
  `chron < add_idx` (in shard matching, where `e.f` and the hit chron are at
  hand). Deleted-feed hits keep the status quo (tombstone).
- **Info dialog (`config.ts`)**: "Articles" row shows the live count
  `total_art − (xp ?? 0)`.
- No other changes: list/nav/counts already honor `add_idx`; the service
  worker ignores feed fields.

## Trade-offs (accepted)

- **Shared-asset deletion** (explicit choice): an asset referenced by both an
  expired and a live article is deleted; the live article renders with
  collapsed media (`collapseBrokenMedia`). Rare under this store's profile
  (per-post-unique media). Repair paths: `srr asset heal --create`, or a
  future re-ingest of the same bytes re-uploads under the same content-hash
  key.
- **CF edge cache**: deleted assets may outlive origin deletion at the edge
  (immutable Cache-Control) until evicted. Origin storage is what this
  reclaims.
- **★ Saved / deep links**: expired articles stay readable (immutable packs,
  permanent chronIdx) with media collapsed. By design.
- **Meta shards keep expired titles**: search is filtered client-side; the
  shard bytes are immutable. A bloom-pruned shard fetch for an expired-only
  hit is wasted but harmless.
- **Pack storage is never reclaimed** — logical deletion only. Assets are the
  heavy bytes; pack text is cheap and chronIdx permanence depends on it.

## Implementation deltas (as landed, 2026-07-03)

- **Dormant-feed frontier advance** (final-review fix, commit c7d1285): a
  fully-expired feed that stops posting would otherwise pin
  `minStart = min(add_idx)` forever while the early-stop frontier tracks wall
  clock — an unboundedly growing re-walk every cycle. Now the walk records
  `stopChron` and per-feed `sawLive`; an expiring feed that saw no live own
  entry AND expired nothing this cycle advances `add_idx` straight to
  `stopChron`. The advanced-over region provably contains zero own entries,
  so `xp` is unchanged and the inspect live-count cross-check holds. A feed
  that expired its tail waits one cycle before the jump (deliberate — keeps
  the zero-own-entries argument trivial). `AddFeed` now also explicitly
  zeroes `Expired` (invariant made local rather than caller-dependent).
- **Admin per-feed count (pending)**: the spec asked for live per-feed counts
  in the serve overview; as landed, tag buckets are live but the Feeds-table
  column still shows all-time `total_art` (the API ships `expired` alongside,
  so the fix is a one-line webui subtraction — blocked on concurrent webui
  work, queued with the backend/CLAUDE.md docs patch).
- **Expire-before-outfeeds ordering**: `ExpireArticles` runs after `SyncMeta`
  and *before* `SyncOutFeeds` (this spec's draft had it after) — same-cycle
  syndication consistency. `SyncOutFeeds`' walk filters `chron < AddIdx` per
  feed, and `outFeedsSig` includes each feed's `AddIdx` alongside its tag, so
  an expiration-only cycle un-gates the idle-cycle rewrite skip. Expiration
  runs on every cycle including serve's `--interval` loop and the GUI
  single-feed fetch (`only`-mode) — global maintenance like
  `SyncIdxSummary`/`SyncMeta`; production `now` is `db.core.FetchedAt`.
- **assetKeyRe grammar validation (traversal fix)**: harvested candidates are
  validated against the strict `assetKeyRe`
  (`^assets/[0-9a-f]{2}/[0-9a-f]{16}(\.[A-Za-z0-9]+)?$` — the renamed
  `healKeyRe`, shared with `srr asset heal`), not the bare `assets/` prefix
  this spec sketched: the keys feed `Rm`, which path-joins on local/SFTP, so
  adversarial feed content like `assets/../victim` is never harvested
  (leak-safe, never delete-unsafe). Harvesting reuses `parseBodyFragment` +
  `visitAssetAttrs`, factored out of `db_out.go`'s `rewriteAssetURLs` as
  planned; unparseable HTML contributes nothing (the content already published
  as-is — an error would wedge retention forever). Early stop is the
  `errExpireDone` sentinel (third package sentinel beside
  `errNotFeed`/`errNotAsset`).
- **ExpireDays ceiling**: `normalizeFeed` bounds `0 ≤ expire_days ≤ 36500`
  (100 years); the webui number input carries matching `min`/`max`.
- **Inspect live-count cross-check**: beyond the planned range checks
  (`0 ≤ add_idx ≤ total_articles`, `0 ≤ xp ≤ total_art`), `--validate`
  cross-checks the `(AddIdx, Expired)` pair against the packs — live idx
  entries at `chron ≥ add_idx` must equal `total_art − xp` (reuse-proof: a
  reused id's legacy entries sit below `add_idx`). `--filter` and
  `--list-tags` sum live counts (`TotalArt − Expired`); the all-time
  `total_art == idxCount` check stays (known id-reuse limitation, commented).

## Testing

- **Go unit (`db_expire_test.go`)**: prefix property (per-feed cutoffs, one
  walk, early stop at `maxCutoff`); `add_idx` monotone forward; `Expired`
  accumulation matches skipped entries; asset keys harvested from every attr
  (img/video/audio src, poster, a href) and deduped; `Rm` called for each,
  missing-tolerant, abort-all on failure (no `add_idx`/`xp` applied — the
  landed contract, superseding this spec's earlier warn-and-continue draft
  wording); feeds with `exp=0`
  untouched; a fully-expired feed (`add_idx == total`, live count 0);
  boundary `fetched_at == cutoff` not expired; no-op cycle returns false and
  reads nothing; warn-only integration in the fetch cycle (a failing store
  read doesn't fail the fetch).
- **Writer/reader counting**: idx.test.ts — `countLeft` subtracts `xp` at the
  header shortcut; a mid-history `add_idx` with nonzero `xp` counts exactly
  the visible set. search.test.ts — expired hits filtered, deleted-feed hits
  kept. config.test.ts — live "Articles" row.
- **E2e contract test**: seed a store whose old articles have aged
  `fetched_at` via a gated Go generator (the `genbig_test.go` precedent — the
  production write path with injectable timestamps), set `expire-days`, run a
  real `srrb` fetch cycle (real wall clock — no time seam in the binary) →
  real `nav`/`search` skip expired, counts exact, assets gone from the store
  dir, `srr inspect --validate` clean.
- **Audits**: `idx-format-reviewer` agent (this touches the counting contract
  on both sides), then `make verify`.

## Docs

- Root `CLAUDE.md` Data Contract: `exp`/`xp` in the Feeds row; the counting
  invariant note (`total_art` all-time, visible = header − xp past add_idx);
  expiration in the fetch-cycle order.
- `backend/CLAUDE.md`: `db_expire.go` component entry, fetch-cycle order,
  inspect changes, CLI flags.
- `frontend/CLAUDE.md`: counting correction + search filter notes.
