# Persistent dedup: the `seen.gz` pool

Implementation plan for eliminating re-promotion duplicates (e.g. the Ofertitas
offer that appears 18× in the reader) by giving per-feed dedup a **persistent,
age-bounded memory** instead of today's single-fetch snapshot.

Status: **implemented** (`backend/seen.go` + wiring in `feed.go` / `cmd_fetch.go`
/ `db.go`; CLI in `cmd_feeds.go` / `cmd_dedup.go`; store policy in
`store/main.go`). This pass also pulled the §10 follow-up forward: the HTTP
conditional-fetch validators **`etag`/`last_modified` moved out of db.gz into
`seen.gz`** (a per-feed HTTP-validator section alongside the dedup pool),
hydrated onto the in-memory feed at load and written back after each fetch. At
the time of this pass, the crash-safety line kept `wm`/`bg` in db.gz: their
atomicity with the article `Commit` was what prevented duplicate ingestion, so
they were **not** moved. Build order (tests first) is in §7.

**Superseded (2026-07, `feat/seen-pingpong-bg`): `bg` has since relocated too.**
The line above is now only half true — see "Ping/pong slots + bg relocation
(v2)" immediately below for what changed and why the atomicity argument still
holds without `bg` living in db.gz. `wm` is unaffected: it stays in db.gz.

---

## Ping/pong slots + bg relocation (v2)

A later pass (`feat/seen-pingpong-bg`, full plan in
`backend/SEEN-PINGPONG-PLAN.md`) relocated each feed's `BoundaryGUIDs` (`bg`)
out of db.gz into this same sidecar, and changed `seen.gz` from one mutable
object into **two fixed ping/pong slots**:

- **Two slots, one pointer.** `seen.gz` is now `seen.0.gz` / `seen.1.gz`. A new
  `DBCore.SeenFlag bool json:"sf,omitempty"` in db.gz names the active slot
  (`false` ⇒ slot 0, `true` ⇒ slot 1; `seenSlotKey`).
- **`bg` moved in, alongside the HTTP validators.** The per-feed record
  (`httpState` → renamed `feedState`) now carries `bg []uint32` after `etag`/
  `lastMod` (format version bumped 1→2; a v1 body still parses, bg-less).
  `seenPool.http` was renamed `seenPool.feed` to match.
- **Write ordering reversed and made fatal.** `SyncSeen` now runs **BEFORE**
  `Commit` in both the fetch cycle (`cmd_fetch.go`) and `commitState` (the
  feed-mutation command path), not after, and its error is **fatal** (returned,
  aborting the cycle/command), not warn-only. It writes the *inactive* slot,
  then flips `SeenFlag` in memory; the same `Commit` that publishes the article
  batch (or feed-mutation change) publishes the flipped flag — so the batch and
  the pointer to the dedup state (pool + `bg`) that covers it become durable
  atomically, in one `db.gz` write. This replaces the old
  "`wm`/`bg` stay in db.gz for atomicity" argument: atomicity is now the
  ping/pong flag flip, not co-location.
- **Guarded load, not just a corruption check.** `loadSeen` reads the active
  slot; gzip's trailer CRC32 + `parseSeen`'s structural checks still detect
  corruption (unchanged), but the *response* to a bad active slot is now
  recovery, not just an empty pool: fall back to the sibling slot (the previous
  ping/pong generation — at most one cycle stale), then to the pre-ping-pong
  single `seen.gz` (read once as a one-time upgrade bridge, `seenLegacyKey`,
  logged INFO — old stores keep working through the slot cutover), and only
  then to an empty pool (WARN, and only once the store has committed at least
  one batch, to avoid a noisy warning on a brand-new store).
- **`wm` is unaffected — it stays in db.gz.** It is reader-displayed (the
  "Latest published" info card, `frontend/src/js/picker.ts`) and remains a
  partial dedup floor (dated re-promotions ≤ watermark stay suppressed) if the
  sidecar is ever completely lost — the residual risk in that case is limited
  to dateless/at-watermark re-ingestion for one cycle.
- **No db.gz migration.** A pre-relocation db.gz's inline `bg` is simply
  ignored on load (`BoundaryGUIDs` is `json:"-"`, so the JSON decoder skips the
  key); the sidecar refills `bg` from the feed's next non-empty fetch, and `wm`
  floors dated duplicates in the meantime. There is no `LegacyBoundaryGUIDs`
  bridge field — an early draft of the branch plan had one; it was removed
  before implementation (see `backend/SEEN-PINGPONG-PLAN.md`).

Net effect on the rest of this document: §2 decision 1's "`db.gz` and its `bg`
snapshot stay byte-for-byte unchanged" and §7 decision "Write `seen.gz` AFTER
`Commit`" (and the matching §6 crash-safety paragraph) describe the *pre-v2*
design and are **no longer current** — `bg` no longer rides in db.gz, and the
write now precedes `Commit` and is fatal. They are left below for history;
this section is the correction.

---

## 1. Problem & root cause

SRR dedups each fetch with two pieces of per-feed state in `db.gz`:

- `wm` (Watermark) — max published unix-second ever seen; items with `pub < wm`
  are skipped.
- `bg` (BoundaryGUIDs) — the FNV-32a hashes of **the current fetch's window**,
  rebuilt every fetch (a *snapshot*, capped at `maxBoundaryGUIDs = 1024`).

An item is skipped iff `guid ∈ bg` **or** `pub < wm`. Both fail on
**re-promotion**: a feed re-publishes an old item with a *fresh* `pubDate ≈ now`
but a *stable* `<guid>` (Ofertitas uses `?p=<postid>`). The re-dated `pub` sits
**above** the watermark (and the watermark deliberately is *not* raised by
re-dated already-seen items — `feed.go:314-324`), and the item long ago fell out
of the small window, so its guid is **absent** from the current `bg` snapshot.
Nothing remembers it → re-ingested as a duplicate. Measured on prod feed 42:
~53% of its stored articles are these repeats.

Packs store **no guid** (only `{f,a,p,t,l,c}`), so guids live *only* transiently
in `bg`. The only lever without a pack-format change is to **persist more of the
guid history** — the `seen.gz` pool below.

---

## 2. Design decisions (and why)

Arrived at by working through the alternatives; each rejected option is recorded
so we don't re-litigate.

1. **Backend-only sidecar, not a bigger `bg`.** *(Historical — at the time of this
   decision `bg` still rode in `db.gz`; it has since been relocated into this
   same sidecar too, see "Ping/pong slots + bg relocation (v2)" above. The
   "stays byte-for-byte unchanged" claim below no longer holds for `bg`
   specifically — it was true, and remains true, for `wm` and the rest of the
   feed's config fields.)* `bg` rode in `db.gz` — the one
   `no-cache` object every reader re-downloads every load. Growing it to hold
   history is 8–18× the hot object for data readers ignore. Instead: a new
   store-root object **`seen.gz`**, a *third* backend-only mutable class after
   `db.gz` and `out/` (frontend + service worker already ignore `out/`). `db.gz`
   and its `bg` snapshot stayed **byte-for-byte unchanged** as the fallback (at
   the time). No
   pack-format change and **no reader *behavior* change** — but the new `dd`/`dt`
   json tags on `Feed`/`DBCore` DO regenerate `format.gen.ts` (`cmd_gents.go`
   reflects both structs into `IFeedWire`/`IDBWire`), so `make generate` is part
   of the build (§7); the frontend/service-worker ignore the new fields exactly
   like `recipes`/`out`, so nothing the reader *does* changes.

2. **Age-based eviction, not a count-capped LRU.** The pool keeps every
   `(feed, guid)` **seen within the last `H` days**. This is the load-bearing
   decision: a count-capped *global* LRU couples each feed's memory to global
   fetch volume — a busy feed's churn evicts a quiet feed's carry, and any feed
   that stops being fetched (backoff / 304 / error) drifts out and gets evicted.
   Age eviction has **no capacity trigger**, so a feed's entries live exactly `H`
   days regardless of what any other feed does. (Fetching all feeds "at once"
   does *not* fix the LRU — the pressure is insertion *volume*, not timing.)

3. **Global flat structure in memory; the global-vs-per-feed split is a
   non-issue under age eviction.** The retained *set* is identical either way
   ("everything seen in the last `H` days"). In memory: one
   `map[uint64]uint16` keyed `feed_id<<32 | guid` → `when_seen` (unix-day).

4. **Per-feed flood cap `C` as the only hard bound.** Pure age eviction is
   unbounded under a firehose (100k/day × 30d = 3M entries for one feed). Cap
   **per feed** (keep each feed's newest `C` by `when`). It must **not** be a
   *global* cap — a global cap re-introduces the exact cross-feed interference
   age eviction removed. A pathological feed then sacrifices only *its own*
   horizon.

5. **Columnar on-disk layout.** Empirically (11,591-entry prod-shaped pool):

   | layout | gzipped |
   |---|---|
   | guids alone (entropy floor) | 45.3 KB |
   | **columnar `[feed_id][when][guid]`** | **47.9 KB** |
   | naive interleaved rows `[feed_id,guid,when]` | 57.1 KB |

   The guid `u32`s are random ⇒ incompressible ⇒ they *are* the file (~4 B/entry
   floor). `feed_id`/`when`, stored as **separate sorted columns**, gzip-RLE to
   ~0.2 B/entry. A hand-rolled "day-change header" hits the 45.3 KB floor only by
   dropping `feed_id` — which globalizes the guid space and causes ~300
   cross-feed hash collisions (→ wrongly-suppressed articles) at 1.6M entries.
   **Keep `feed_id`; let gzip do the RLE.** Not worth a custom timestamp header.

6. **Title dedup, opt-in, gated `dt AND !nt`** (§3). Catches the *other*
   re-promotion variant (new guid, **same headline** — a CMS minting a fresh
   permalink). Off by default because titles are far less unique than guids;
   blanket title-dedup silently eats legitimately-recurring headlines.

7. **Write `seen.gz` AFTER `Commit`** (opposite of `hdrs`/`mp`). Warn-only, like
   `SyncMeta`. Rationale in §6. *(Superseded by the v2 ping/pong relocation
   above: now that `bg` lives here too and is load-bearing, `SyncSeen` runs
   BEFORE `Commit` and is fatal on failure — the same ordering as `hdrs`/`mp`,
   no longer their reverse.)*

Rejected outright: dedup against stored guids (packs have none); truncated-hash
sets in `db.gz` (lossy + still in the hot object); bloom/cuckoo/Golomb (false
positives silently drop real articles, and no LRU/age eviction); appending guids
to `data/` lines + meta blooms (scales with article count forever, touches the
pack contract, and "all-time" wrongly suppresses months-old re-offers).

---

## 3. Data model & configurable horizon `H`

The horizon **must be configurable** (not a hardcoded 30). Two levers, mirroring
the existing `exp` / ExpireDays pattern (`feed.go:101-105`):

- **Store default** — new `DBCore.DedupDays int json:"dd,omitempty"`
  (`db.go:123`). Absent/0 ⇒ code constant `defaultDedupDays = 30`. This is the
  single knob that answers "use something other than 30 days".
- **Per-feed override** — new `Feed.DedupDays int json:"dd,omitempty"`
  (`feed.go`, next to `ExpireDays`). `0` ⇒ inherit the store default; `>0` ⇒
  that many days; **`-1` ⇒ disable the pool for this feed** (escape hatch; the
  feed then behaves exactly as today, `bg`-only).

  Effective horizon: `feed.DedupDays>0 ? feed.DedupDays : (feed.DedupDays==-1 ?
  disabled : store.DedupDays>0 ? store.DedupDays : defaultDedupDays)`. Put this
  in one helper `func (c *Feed) dedupDays(store int) int` — a **positive** day
  count, or a **non-positive** sentinel (`dedupDisabled`) for the opted-out feed.
  Only the *per-feed* value may be `-1`; a store default `<0` is invalid config
  (clamp to `defaultDedupDays` or reject in the `config` setter), since there is
  no store-wide "disable the pool" — per-feed `-1` is that lever.

- **Title-dedup flag** — new `Feed.DedupTitle bool json:"dt,omitempty"`. Title
  hashing applies only when `DedupTitle && !NoTitle`.

**CLI surface** (mirror how `exp`/recipe overrides are set today):
- `srr feed add|upd --dedup-days N` and `--dedup-title[=false]`
  (`cmd_feeds.go`). `--dedup-days -1` disables.
- Store default: extend `cmd_config.go` (`srr config`) with a `dedup-days`
  setter, or accept `SRR_DEDUP_DAYS` on the fetch globals. Persist into
  `DBCore.DedupDays` so it is a store property, not a per-box flag.
- Surface effective values (read-only) in `feed ls/show` alongside
  `content_bytes`/`asset_bytes`.

`json:"dd"` on both `DBCore` and `Feed` is fine (distinct objects); both `dd` and
the `dt` title flag are free of any existing key. Because `cmd_gents.go` reflects
`Feed` and `DBCore` into `IFeedWire`/`IDBWire`, adding these tags **regenerates
`format.gen.ts`** — run `make generate`. The reader ignores the new fields (a
no-op contract change), but `make verify-be`'s `generate-check` fails if the file
is left stale.

---

## 4. On-disk format — `seen.gz`

`gzip(` header ‖ feed_id column ‖ when column ‖ guid column `)`, entries sorted
by `(feed_id, when)` so both non-guid columns RLE well.

```
header:  magic "SEEN"          (4 bytes)
         version u8 = 1        (1 byte)
         count   u32 LE        (# entries N)
feed_ids: N × u16 LE           (feed id; u16 = feedIDCeiling bound already used by idx)
whens:    N × u16 LE           (when_seen as absolute unix-day = unixSec/86400;
                                u16 covers through ~year 2149)
guids:    N × u32 LE           (FNV-32a of guid OR of fold(title) — untagged;
                                membership test is OR over both, §5)
```

- **`when` unit:** absolute unix-day (`fetchedAt / 86400`). Eviction: drop
  entries where `today - when > H`. No base-epoch bookkeeping.
- Corruption guard: bad magic/version, or trailing bytes not `4+1+4 + N*(2+2+4)`,
  ⇒ WARN + treat as empty pool (degrade to today's `bg`-only dedup; never an
  article loss).
- Compress with the fast stdlib path (rewritten every cycle; not zopfli).
- Keys/paths: `const seenFileKey = "seen.gz"`.
- **Shared hash namespace (accepted lossy):** guid hashes and `fold(title)` hashes
  share one per-feed u32 keyspace (both are `fnv32`), and membership is their OR.
  A guid-hash == title-hash collision within one feed (~1/2³² per pair, only when
  `dt`) yields a spurious dedup. Untagging them holds the file at the ~4 B/entry
  entropy floor (§5.5) and matches how `has` tests both axes; the odds are
  negligible.

`cacheControlForKey` (`store/main.go:73`) → add `case key == "seen.gz": return
cacheRevalidate` (backend-only, but if the CDN ever serves it, never cache
stale). `contentTypeForKey` (`store/main.go:111`) → include `seen.gz` in the
`application/gzip` class. Not added to `PackSeries`/`packKeyRe` (never
immutable). Extend `store/store_test.go` cache/content-type tables.

---

## 5. In-memory type & integration points

New file `backend/seen.go`:

```go
type seenPool struct {
    dirty bool              // stamp/evict set it; SyncSeen skips the Put when false
    m     map[uint64]uint16 // feed_id<<32 | hash  ->  when_seen (unix-day)
    // has(feedID, hash) bool, stamp(feedID, hash, day),
    // evict(today, horizonFor func(feedID) int, cap int, live map[int]*Feed)
}
func seenKey(feedID int, h uint32) uint64 { return uint64(feedID)<<32 | uint64(h) }
func fnv32(s string) uint32 { /* FNV-32a, same basis/prime as ingest.hash */ }
func titleHash(title string) uint32 { return fnv32(foldSearchText(title)) } // reuse db_meta.go:54
```

**All methods must be nil-receiver-safe** (`has`→false, `stamp`/`evict`→no-op on a
`nil *seenPool`). The fetch tests build `fetchRun{…}` literals with no pool
(`feed_test.go:40` `fetchOnce` and ~10 siblings), so an unconditional
`run.seen.has(...)` would nil-panic every existing feed test and break T10. A
`nil` pool also cleanly models "pool disabled / never loaded".

**Load** — in `NewDB` (`db.go:235`), after `db.gz` is decoded: `Get("seen.gz",
ignoreMissing=true)`, gunzip, parse into `db.seen`. Missing/short/corrupt ⇒ empty
pool + WARN. Store the pool on `DB` (`db.go:117`: add `seen *seenPool`).

**Thread into the fetch cycle** — add `seen *seenPool` **and** `dedupDays int`
(the store default, `db.core.DedupDays`) to `fetchRun` (`feed.go:142`); set both
where the run is built (`cmd_fetch.go:409`). The store default must ride the run so
`fetchURL` can resolve each feed's effective horizon (and the disabled gate)
during the lock-free fan-out, before the pool is written.

**Check (dedup)** — in `fetchURL`'s first pass (`feed.go:282-329`). The pool is
read **read-only** during the concurrent feed fan-out (it is the cycle-start
snapshot, like `priorBoundary`), so no lock on reads. Fold pool membership into
the existing already-seen branch at `feed.go:314`:

```go
horizon := c.dedupDays(run.dedupDays) // store default threaded onto fetchRun
poolOn := horizon > 0                  // dd == -1 opts the feed out entirely
dt := poolOn && c.DedupTitle && !c.NoTitle
seenBefore := func(i *mod.RawItem) bool {
    if !poolOn { return false } // disabled feed: exact bg-only behavior (T8)
    if run.seen.has(c.id, i.GUID) { return true }
    if dt && run.seen.has(c.id, titleHash(i.Title)) { return true }
    return false
}
// at line 314, replace `if _, prev := priorBoundary[i.GUID]; prev {`
if _, prev := priorBoundary[i.GUID]; prev || seenBefore(i) {
    continue // keep deduping; do NOT raise watermark (existing rationale)
}
```

This preserves the crucial watermark invariant: a pool hit, like a `priorBoundary`
hit, must not raise `wm` (else a genuinely-new item dated between old and bumped
gets dropped — `feed.go:315-319`).

**Stamp (update)** — the pool records "last day each guid/title was present in the
feed", so an item is remembered for `H` days after it *leaves* the feed window.
Stamp **every** current-window item (ingested or already-seen), not only new ones,
so a long-lived window item's clock stays fresh until it disappears. To avoid
concurrent map writes during fan-out, each feed **accumulates its stamps locally**
(unexported `c.seenStamps []uint32`, mirroring the existing per-run `c.newItems`
scratch field — lowercase so it never serializes to `db.gz`) and the merge is
**single-threaded after `g.Wait()`** (mirrors the `articles` aggregation at
`cmd_fetch.go:459-465`):

- **Collect during the first pass, commit only at the successful tail.**
  Already-seen items never reach `candidates`, and `boundary` holds no titles, so
  the stamps must be gathered inside the first-pass loop (`feed.go:282-329`): for
  each first-occurrence item append `i.GUID`, plus `titleHash(i.Title)` when `dt`,
  to a **local** slice. Assign it to `c.seenStamps` only at the successful tail —
  right where `c.BoundaryGUIDs = bg` is set (`feed.go:491`), **after** the all-nil
  (`feed.go:337`) and stale-response (`feed.go:352`) guards' early returns — so a
  transient stale/empty copy never refreshes the pool. A disabled feed (`!poolOn`)
  collects nothing. (304 / zero-item / NotModified return before the loop and
  stamp nothing — harmless: `bg` is preserved across those, so an unchanged window
  still dedups without a pool refresh.)
- After `g.Wait()` (`cmd_fetch.go:454`), before save: for each fetched feed,
  `for _, h := range c.seenStamps { pool.stamp(c.id, h, today) }`.
- Then a single `pool.evict(today, per-feed c.dedupDays(db.core.DedupDays), C,
  db.core.Feeds)` — age-evict globally, apply the per-feed flood cap, and **drop
  entries whose `feed_id` is not a live feed** (see Feed lifecycle).

**Save** — new method `func (o *DB) SyncSeen(ctx) error` in `seen.go`, modeled on
`SyncMeta` (`db_meta.go:239`): serialize (§4), gzip, `Put("seen.gz")`. At the
time of this pass it was called in `cmd_fetch.go` **after** `db.Commit(ctx)`
(`cmd_fetch.go:525-527`), warn-only:

```go
if err := db.Commit(ctx); err != nil { return err }
if err := db.SyncSeen(ctx); err != nil { slog.Warn("sync seen pool", "error", err) }
```

**Superseded (v2, see above):** now that `bg` also lives in this pool, the
order and severity are reversed — `SyncSeen` runs BEFORE `Commit` and is
FATAL on error (aborts the cycle/command instead of warning):

```go
if err := db.SyncSeen(ctx); err != nil { return fmt.Errorf("sync seen pool: %w", err) }
if err := db.Commit(ctx); err != nil { return err }
```

Write-if-changed: skip the `Put` when no stamp/evict/snapshot mutated the pool
this cycle (most `--interval` cycles are all-304 no-ops) — track a dirty flag.

**Feed lifecycle (id reuse is the hazard)** — `AddFeed` (`db.go:345`) assigns the
first free id, so `feed rm` + a later `feed add` **reuses** an id; the reused feed
must not inherit the dead one's pool entries. An `evict`-only purge ("drop
entries for any `feed_id` absent from the live `db.core.Feeds`, every fetch
cycle") is **not enough**: a `feed rm` immediately followed by a `feed add`
reuses the id with no fetch cycle in between, so `db.core.Feeds` goes
`{5:old}`→`{5:new}` and no `evict` ever observes the gap — the new feed would
silently inherit the old one's entries (a real hazard when re-subscribing the
*same* source, whose guids collide exactly). Instead, **`RemoveFeed` purges the
id synchronously (`dropFeed`: dedup entries + HTTP validators)** and the removal
commands (`feed rm`, GUI `DELETE`) persist it via `commitState` (Commit +
`SyncSeen`) *before* the id can be reused. `evict`'s dead-feed sweep is kept as a
belt-and-suspenders for ids that go dead and stay dead. The residual case is a
*same-id URL change* (`feed upd -u`): the entries
stay under a still-live id and just age out over `H` days; the only risk is a
guid-hash collision between the old and new source (~1/2³²), so it is accepted
rather than chased with per-feed incarnation tracking. (Blast radius of *any* stale
entry is bounded the same way — a different source's guids hash elsewhere; the
reused-id purge is correctness hygiene matching the stated "a new source shares no
dedup history", not a high-frequency bug.)

**Flood cap** — `const seenFeedCap = 4096` (comment: effective horizon for a feed =
min(H, cap/rate); a feed exceeding it sacrifices only its own memory). Note the cap
**couples a busy feed's horizon to its volume**: >~136 art/day sustained fills 4096
in <30 d, silently shrinking that feed's window below `H` and re-opening the bug for
a re-promotion gap wider than the shrunk horizon. Fine for the current store (~5
art/feed/day, §9), but size it against the chosen `H` for high-volume feeds
(`cap ≳ H × peak_daily`); the `H=90` option in §9 in particular wants a larger cap
for any firehose feed.

---

## 6. Concurrency & crash-safety

- **Reads lock-free**: the pool is immutable during the concurrent fan-out (it is
  the cycle-start snapshot), so `has` must be a pure read (no lazy init of `m`, no
  memoization). Stamps are buffered per feed and merged single-threaded after
  `g.Wait()`.
- **Within-fetch title dedup does not fire** (guids' does, via the `boundary`
  map): because the pool is a read-only snapshot, two items in the *same* fetch
  with different guids but an identical title both ingest — the first item's title
  stamp isn't visible until the post-`g.Wait()` merge. The re-promotion case this
  feature targets is cross-fetch (a new permalink minted later), so T2/T3 pass;
  same-fetch title collisions are an accepted gap, not covered by `dt`.
- **Save after Commit** (not before): *(historical — this ordering was replaced
  by the v2 ping/pong relocation; see below)* the durable articles are already in
  `L<Seq+1>` and published by `Commit`. If we wrote `seen.gz` *first* and the
  commit then failed, we'd have marked never-published guids as seen and *lost*
  those articles forever. Written after, a crash only leaves `seen.gz` **lagging**
  one cycle ⇒ at worst one duplicate next cycle = today's behavior. Never an
  article loss. This was the reverse of `hdrs`/`mp` (which must precede their
  `db.gz` publish) and was deliberate **at the time `seen.gz` held no
  load-bearing state of its own** (only a cache of dedup history the in-memory
  `bg` snapshot already covered for the current cycle). Once `bg` itself moved
  into the sidecar (v2), that argument flips: now `SyncSeen` runs BEFORE
  `Commit`, fatal on failure — a committed article batch must never outrun the
  slot that dedups its GUIDs, the same ordering `hdrs`/`mp` always used. A
  ping/pong write also means a failed commit no longer risks marking
  never-published guids as seen "for good": the inactive slot it wrote is
  simply never pointed at (`SeenFlag` isn't flipped in the published db.gz), so
  a retried cycle starts from the same active slot as before.
- **Warn-only**: *(historical — see above; the seen write is now fatal, not
  warn-only, because `bg` is load-bearing)* a failed load/parse/save degrades to
  `bg`-only dedup; it never corrupts or drops articles (same philosophy as
  `SyncMeta`/`SyncIdxSummary`).
- **`gen --bump` interaction**: none — `seen.gz` is dedup state, orthogonal to
  pack rebuilds. Leave it untouched on bump. (A rebuild that physically dropped
  articles doesn't affect guid identity.)

---

## 7. Build order — tests first (Phase 4 of systematic-debugging)

Write the failing tests **before** any production code. Harness note: `fetchOnce`
(`feed_test.go:40`) builds a fresh `fetchRun` per call; to exercise persistence,
the new tests must thread one shared `seenPool` (and reload it from serialized
bytes for the round-trip test). The existing `fetchRun{…}` literals leave `seen`
nil, so the pool methods **must** be nil-safe (see §5, B1) or every current feed
test panics — T10 is the guard for that.

1. **T1 — stable-guid re-promotion (the reported bug).** 3 fetches on one feed:
   `X{guid=x,pub=Jan01}` → expect 1 ingested; `Y{guid=y,pub=Jan02}` (X absent) →
   1; `X{guid=x,pub=Jan03}` (re-promoted, fresh date, X back) → **expect 0**
   (today ingests 1). This is the red test that proves the fix.
2. **T2 — title dedup on a `dt` feed.** `{guid=g1,title=T}` then
   `{guid=g2,title=T}`: with `DedupTitle=true` → fetch2 ingests 0; with it false →
   1.
3. **T3 — `nt` feed ignores the title axis.** `DedupTitle=true, NoTitle=true`:
   same-title/new-guid still ingests (guid axis only).
4. **T4 — recurring-title feed, `dt` off, must NOT over-suppress** (default =
   today's behavior; guards against accidental blanket title-dedup).
5. **T5 — age eviction & configurable H.** Seen, then absent > H days, then
   reappears re-dated → ingested again (expired); absent < H days → deduped. Run
   with two different `DedupDays` to prove the horizon moves.
6. **T6 — persistence round-trip.** Stamp, `SyncSeen` → bytes → reload in a fresh
   `NewDB`-style pool → dedup still fires (proves serialize/parse symmetry).
7. **T7 — flood cap.** A feed exceeding `seenFeedCap` keeps its newest `C` by
   `when`; oldest evicted.
8. **T8 — per-feed disable (`dd = -1`)** falls back to exact `bg`-only behavior.
9. **T9 — corruption guard.** Truncated/bad-magic `seen.gz` ⇒ empty pool, no
   error, dedup degrades to `bg`.
10. **Regression — existing suite green** (also proves nil-pool safety, since these
    build `fetchRun` with no pool), especially `TestFetchRedatedWholeWindowDedupes`
    (whole-window re-dated but items *stay present* → still 0 re-ingested; the pool
    must not change this), `TestFetchEmptyResponsePreservesDedupState`,
    `TestFetchStaleResponsePreservesDedupState`.
11. **T11 — id-reuse purge.** Stamp a guid under feed id 5, remove feed 5 (no fetch
    cycle), add a new feed reusing id 5, then fetch an item whose guid hashes to the
    stamped value → **ingested** (a new source shares no history), because
    `RemoveFeed` purges the id synchronously (`dropFeed`) and `feed rm` persists it
    via `commitState` before the id is reused. Covered end-to-end by
    `TestFetchCycleReusedFeedIdStartsClean` and at the pool level by
    `TestSeenPoolPurgedOnFeedRemove` (with `TestSeenPoolDeadFeedPurge` guarding the
    `evict` belt-and-suspenders).
12. **T12 — stale/empty response does not stamp.** A stale-response-guarded fetch
    (newest dated item below watermark, no dateless) and an all-nil response each
    leave the pool byte-identical (no new stamps), so dedup state is preserved.

Then implement §3–§5 minimally to make T1–T12 pass, then **`make generate`** (the
new `dd`/`dt` tags on `Feed`/`DBCore` change `format.gen.ts`; the reader ignores
them, but `make verify-be`'s `generate-check` fails on a stale file) and
`make verify-be` (gofmt + vet + golangci + unit + build + generate-check). The
reader is untouched *behaviorally*, so no `frontend/` test changes — but
`format.gen.ts` is regenerated and committed.

---

## 8. Rollout / rollback

- **Forward-compatible:** an old binary never looks for `seen.gz`; a new binary
  with no `seen.gz` present behaves exactly like today (empty pool). Deploy is a
  normal `srr-update be` on dmz.
- **Rollback:** delete `seen.gz`. Both binaries cope.
- **First run** after deploy: pool starts empty and fills from live windows; the
  fix takes effect for a given re-promotion once its guid has been seen once
  within the horizon. Existing stored duplicates are **not** retroactively
  removed (that's a separate `gen --bump` rebuild, out of scope).

---

## 9. Size expectations (empirical, prod-shaped)

Pool plateaus at `ingest_rate × H`, **independent of total article count** once
the store is older than `H`. Measured store: 71 feeds, ~376 articles/day.

| H | entries | gzipped `seen.gz` |
|---|---|---|
| 7 d | ~2.8k | ~15 KB |
| 30 d | ~11k | ~48 KB |
| 90 d | ~34k | ~170 KB |

The reported Ofertitas gap is ~2.7 days, so even `H=7` catches it; `H=30` default
is comfortable. At a hypothetical 10k feeds: `H=30` ≈ ~8 MB, `H=7` ≈ ~2 MB — and
it's a backend-only file **no reader** fetches.

**Fetch-loop I/O (not reader I/O).** `runFetch` opens the DB *inside each cycle*
(`cmd_fetch.go:352` → `withDBCtx` → `NewDB`), so the loop **downloads and parses
`seen.gz` every cycle** (~48 KB at H=30, ~288×/day on a 5-min interval) and rewrites
it on every non-idle cycle. The dirty flag skips the `Put` on all-304 cycles, but a
feed with no ETag/Last-Modified returns 200 every cycle → re-stamps its window →
dirties the pool → one `seen.gz` rewrite per cycle. Same per-cycle hot-object class
as `db.gz`; worth noting next to the meta-tail write-amplification in the bandwidth
audit, though at 48 KB it is far smaller than the meta tail.

---

## 10. Out of scope / future

- Retroactively purging the ~53% existing feed-42 duplicates (needs a store
  rebuild + `gen --bump` + CDN purge).
- `srr inspect` per-feed pool-usage reporting (nice-to-have).
- Migrating other backend-only fetch state (`ferr`, …) out of `db.gz` into a
  sidecar to *shrink* the hot object further — the sidecar precedent this
  establishes makes it possible later; not part of this change. (`etag`/
  `last_modified` were already moved by this pass; `bg` moved too, later, by the
  v2 ping/pong relocation above. `wm` is deliberately excluded from this list —
  it's reader-displayed and stays in db.gz by design, not an oversight.)
