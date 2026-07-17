# Delta-Segment Tail — Specification

**Status:** IMPLEMENTED (2026-07-17, working tree). Normative corrections made
during implementation, folded in below: (1) `BumpGen` does NOT reset the chain
fields — §5; (2) the SW prune window for `l`/`d` names is
`tailGen − LATEST_KEEP`, tighter than the backend GC's — §8; (3) **feed
removal drains the chain** (`RemoveFeed` → `DrainDeltas`) — §6.5, closing the
id-reuse header-corruption hazard the format review found; (4) §12.1's
byte-identity claim carries a feed-membership carve-out — see §12.1.
**Scope:** writer↔reader data contract change (backend `db_pack.go`/`db_meta.go`/`cmd_fetch.go`/`idx_read.go`, frontend `data.ts`/`search.ts`/`sw.ts`, `store.PackSeries`, `srr gen-ts`, `srr inspect`).
**Companion reading:** root `CLAUDE.md` → Data Contract; `backend/SEEN-PINGPONG-PLAN.md` (the precedent for this document's style and for the "db.gz names the current generation" commit discipline this design extends).

---

## 1. Problem

Every article-producing fetch cycle rewrites the **entire hot tail** under new
write-once generation names: `idx/L<seq>.gz`, `data/L<seq>.gz`,
`meta/L<seq>.gz`. The tail content accumulated since the last finalization is
re-uploaded wholesale to publish a batch of any size.

Measured on prod (2026-07-10 bandwidth audit, seq 1549→1550): **one new ~2 KB
article ⇒ ~225 KB uploaded** (meta tail 201 KB + idx tail 5.7 KB + data tail
8 KB + db.gz 10.6 KB) — **~100× write amplification**. The same renaming makes
every open tab and returning reader re-download the full tails on its next
refresh: the new `L<seq>` names are structural cache misses, so the 5-minute
heartbeat refresh of a single new article costs each client ~215 KB.

Since R2 egress is free and priced per operation, the real currencies are
(ranked): **reader latency and bytes on every refresh**, R2 class-B op counts
(scale with readers), R2 class-A writes, and writer CPU (the meta tail is
re-gzipped every cycle).

## 2. Design in one paragraph

Publish each cycle's batch as one small immutable **delta segment**
`data/d<seq>.gz` — the batch's full `ArticleData` JSONL, byte-identical in line
format to a data pack — and rewrite the three tail packs only when a
**consolidation** trigger fires (every `maxDeltas` cycles, on accumulated delta
bytes, or forced by a finalization boundary). A delta carries the superset
record, so the reader derives all three tail roles from it: idx entries
(`f`), meta cards (`{f, w:=p||a, t}`), and article content — delta-region
articles are **resident** in the reader and never touch a data/meta pack.
Consolidation replays the accumulated deltas through the *existing* pack
materialization code, so the finalized 50k idx packs, PackSize data packs, and
5k meta shards come out **byte-identical** to what today's per-cycle path would
have written. Everything stays write-once; db.gz stays the single mutable
commit root; two new small db.gz integers (`nd`, `na`) describe the delta
chain, with **absent == 0 == exactly today's store** — no migration.

```
                      chron →
  ┌────────────────┬──────────────────────┬─────────┬────┬────┐
  │ finalized packs│ consolidated tail    │ d<g₁>   │ …  │d<seq>
  │ idx/0..nf-1    │ idx/L<tailGen>       │ (batch) │    │(batch)
  │ data/1..pid-1  │ data/L<tailGen>      │         │    │
  │ meta/0..nm-1   │ meta/L<tailGen>      │         │    │
  └────────────────┴──────────────────────┴─────────┴────┴────┘
  0            nf·50000                   tc              total_art
                       tailGen = seq − nd     tc = total_art − na
```

## 3. Goals / non-goals

Goals:

- G1 — Write bytes per dirty cycle ∝ batch size, not tail size.
- G2 — A returning reader downloads ∝ what it hasn't seen (db.gz + new deltas).
- G3 — Preserve every structural invariant the project is built on: write-once
  names, db.gz as the sole commit root, "no reader can learn a name before
  Commit publishes it", immutable finalized packs, chronIdx as a permanent
  address, the SW's structural offline consistency.
- G4 — Bounded cold-boot cost: at most `maxDeltas` extra small requests, byte-
  bounded by `maxDeltaBytes`.
- G5 — Trivial rollback: any consolidation returns the store to the exact
  pre-delta shape; `--max-deltas 0` is a kill switch reproducing today's
  behavior.

Non-goals:

- Multi-level compaction (a real LSM). The existing finalization ladder
  (5k meta / 50k idx / PackSize data) *is* the higher levels; one level-0 delta
  chain capped at `maxDeltas` needs nothing more.
- Changing db.gz's mutability (that is proposal #1, the snapshot/HEAD-pointer
  design — see §14 Interactions).
- Reducing the *feed-fetch* side (backoff etc. — separate work, partially done).

## 4. Object model

### 4.1 New object: the delta segment

- **Key:** `data/d<g>.gz`, `g` = the seq generation that published it.
  Lives under `data/` deliberately: it *is* article data, it inherits the
  existing CDN edge-cache rule prefix (`/data/`), and it slots into the
  `PackSeries` grammar as a new kind letter — `{"data", "Ld"}` (see §10).
- **Content:** gzip (fast stdlib level) JSONL of the cycle's batch — one
  `ArticleData` line per article, chron order, exactly the `written []ArticleData`
  slice `PutArticles` returns today. No header, no footer, no bloom.
- **Mutability:** write-once generation name, `cacheImmutable`, Content-Type
  `application/gzip` — all falls out of `packKeyRe` matching it.
- **Lifecycle:** published by a dirty cycle's Commit; superseded when a later
  consolidation folds it into the tail packs; GC'd after a grace window (§8).

### 4.2 Unchanged objects, changed cadence

`idx/L<g>`, `data/L<g>`, `meta/L<g>` keep their names, formats, and write-once
discipline, but are written **only by consolidation cycles**. Between
consolidations their generation number is *pinned*: the live tail packs are
`*/L<tailGen>` where **`tailGen = seq − nd`** — no longer `L<seq>`. `seq`
itself keeps bumping once per dirty cycle (it now names the newest tail
*object*, delta or consolidated). Finalized packs, `idx/h<N>`, `meta/s<N>`,
db.gz, seen.gz, out/, assets/ are all untouched.

## 5. db.gz schema changes (`DBCore`)

| Field | Key | Type | Meaning |
|---|---|---|---|
| `NumDeltas` | `nd` | int, omitempty | Count of live delta segments. Live deltas are `data/d<g>.gz` for `seq − nd < g ≤ seq`, oldest first. **Absent/0 ⇒ no deltas ⇒ the store is exactly a pre-delta store** (tail packs at `L<seq>`): the upgrade bridge and the post-consolidation state are the same value. |
| `DeltaArticles` | `na` | int, omitempty | Total article count across the live deltas. Defines `tc = total_art − na`, the **tail-covered count**: chrons `< tc` are served by packs, chrons `≥ tc` by deltas. Redundant with the sum of delta line counts *by design* — the reader cross-validates (§7.5). |
| `DeltaBytes` | `dby` | int64, omitempty | Writer-only trigger state: cumulative uncompressed JSONL bytes across live deltas. Reset to 0 at consolidation. On the wire like `recipes`/`out` but ignored by the frontend/SW. |
| `GCLatestSwept` | `gcs` | int, omitempty | Writer-only GC low-water mark: the highest tail generation `GCLatest` has cleared (see §8). Lets the sweep resume where it stopped so no missed/failed sweep or `--max-deltas` change permanently strands a name. On the wire like `dby`, ignored by the frontend/SW, untouched by `BumpGen`. |

Derived, never stored: `tailGen = seq − nd`, `tc = total_art − na`.

**`BumpGen` leaves `nd`/`na`/`dby`/`gcs` untouched** (a correction to this spec's
first draft, caught by the contract layer): the bump is a cache-invalidation
signal, not a layout change, and zeroing `nd` would relocate the expected tail
name from `L<seq−nd>` to `L<seq>` — a name that was never written — bricking
every reader with a reload loop the moment an operator runs a bare
`srr gen --bump` over a live chain. A rebuild that consolidates the chain must
update the chain fields itself, the same operator discipline as recomputing
`add_idx`/`xp`.

`refresh()`'s change detection needs no new fields: `seq` moves on every dirty
cycle (delta or consolidation), and `fetched_at` on every cycle.

## 6. Writer specification

### 6.1 The accounting/materialization split

Today's `PutArticles` interleaves two responsibilities that this design must
separate, because they now run in different cycles:

- **Accounting** (runs exactly once per article, at ingest time — the delta
  path): `total_art++`, `Feed.TotalArt++`, `Feed.ContentBytes += n`, and the
  batch's `[]ArticleData` production. Also `wm`/dedup/seen state — all of the
  fetch pipeline upstream of storage is untouched by this spec.
- **Materialization** (runs at consolidation): the pack-writing loop — idx
  header/entries/footer, data-pack rolls at `PackSize`, 50k idx finalization,
  and (via `SyncMeta`) 5k meta shards + blooms. Its input is a `[]ArticleData`
  slice; under this design that slice is *the concatenation of parsed deltas*
  (plus the current cycle's batch on a boundary-forced consolidation) instead
  of the current cycle's batch alone.

**⚠ The as-of-chron header subtlety.** `writeIdxHeader` snapshots each feed's
cumulative `TotalArt` at the moment a fresh idx pack starts. Today that is
correct because accounting and materialization interleave per article. Under
deferred consolidation, `Feed.TotalArt` is already at end-state when the replay
runs. The materialization loop must therefore thread its **own count vector**:
seed `cnt[f] = Feed.TotalArt − (occurrences of f in the not-yet-replayed
entries)`, bump `cnt[f]` per replayed article, and write headers from `cnt`.
It must assert `cnt == Feed.TotalArt` for every feed when the replay ends. The
consolidation-equivalence test (§12.1) exists first and foremost to catch this
class of bug.

### 6.2 Per-cycle decision

On a dirty cycle with batch `B` (after all per-feed fetch/dedup/pipeline work,
articles sorted by published as today):

```
consolidate :=  nd  ≥ maxDeltas                                   (chain cap)
            ||  dby + bytes(B) ≥ maxDeltaBytes                    (byte cap)
            ||  crossesMetaStratum(total_art, total_art + |B|)    (boundary force)
            ||  maxDeltas == 0                                    (kill switch)
```

`crossesMetaStratum(a, b)` := `floor((b−1)/5000) > floor((a−1)/5000)` — the
batch would create a new 5k meta stratum. Because `5000 | 50000`, this also
covers every 50k idx boundary; the data-pack byte boundary is deliberately
**not** checked here (data packs roll *inside* materialization, exactly as a
large batch rolls them today — invariant I2 below does not include them).

**Delta path** (`consolidate == false`):

0. **Re-validate the consolidated tail idx** (`checkLatestIdx` against `tc`,
   which a delta doesn't move). The pre-delta writer loaded+checked the tail
   every cycle (it had to, to append); a delta cycle never touches the tail, so
   a corrupt/truncated tail (a non-atomic backend's partial prior consolidation,
   or store tampering) would otherwise go unseen by the writer until the next
   consolidation — up to `maxDeltas` cycles later — while every reader is
   already failing to parse it. A transient READ failure only warns (the delta
   doesn't depend on the tail); a structural MISMATCH is fatal, as it was
   pre-delta. Skipped when the tail idx holds no entries (all-delta store, or
   `tc` on a 50k boundary).
1. Run accounting for `B`; serialize `B` to JSONL.
2. `savePack(ctx, "data/d<seq+1>.gz", …)` — fast gzip, like today's L packs.
3. In memory: `seq++`, `nd++`, `na += |B|`, `dby += uncompressed(B)`.
4. Maintain `Head`/`HeadBase` directly from `B` + the previous head (the delta
   path has the cards in hand; head rides db.gz, which is rewritten anyway, so
   the zero-extra-fetch newest window stays live — see §7.4).
5. `SyncIdxSummary` / `SyncMeta` are structural no-ops (nothing finalized,
   `tc` unmoved; `SyncMeta` must explicitly gate on "tc advanced this cycle").
6. `ExpireArticles` → `SyncOutFeeds` → `SyncSeen` → `Commit` → GC, as today.

**Consolidation path** (`consolidate == true`):

1. Run accounting for `B`.
2. Load `idx/L<tailGen>` + `data/L<tailGen>` (checked exactly like today's
   `checkLatestIdx`, but against `tc`, not `total_art`), and parse the live
   deltas `d<tailGen+1> … d<seq>`.
3. Materialize `concat(deltas) ++ B` through the existing loop (with the §6.1
   count vector): finalized idx/data packs as boundaries dictate, then
   `savePack` the new tails `idx/L<seq+1>` + `data/L<seq+1>`.
4. In memory: `seq++`, `nd = 0`, `na = 0`, `dby = 0`.
5. `SyncIdxSummary` and `SyncMeta` run as today (`SyncMeta` consumes the full
   replayed slice and writes `meta/L<seq>` + any finalized shards/blooms +
   head).
6. Same tail of the cycle as above.

A zero-feed / idle cycle changes nothing: no delta, no consolidation (a store
that goes dormant keeps ≤ `maxDeltas` small deltas alive indefinitely — a
considered trade-off; they are force-cached/edge-cached and drain at the next
dirty cycle that triggers, and G5's rollback path covers the operator who wants
them gone: one `--max-deltas 0` cycle).

### 6.3 Crash consistency

Unchanged in structure — every new name is published to readers only by the
db.gz Commit that names it:

- Delta cycle: a crash after step 2 leaves an orphan `d<seq+1>` that the retry
  overwrites — safe under immutable cache headers for exactly today's reason:
  no client can have learned the name (same argument, and same caveat, as the
  `L<seq+1>` orphan comment in `PutArticles`; the "never speculatively
  prefetch the next generation" rule now covers `d<seq+1>` too).
- Consolidation cycle: identical to today's big-batch cycle (finalized names
  are crash-retry-overwritten before any reader learns them; `Seq`/`nd`/`na`
  flip in memory only after every save succeeds, `Commit` publishes).
- `SyncSeen`'s write-inactive-slot-then-flip-`sf` ordering is untouched.

### 6.4 Feed removal drains the chain (normative, added by the format review)

The consolidation replay derives its as-of-chron header counts from the LIVE
feed set (§6.1). A feed removed while its articles sit in an unconsolidated
chain, whose freed id is then reused by a later add, would make the dead
incarnation's in-chain entries indistinguishable from the new feed's during
the replay — permanently corrupting the finalized headers it writes.
Therefore **`RemoveFeed` drains a live chain — but only when the removed feed
actually has an entry in it** (`DrainDeltas`: a batch-less consolidation + a
warn-only `SyncMeta`). A feed with no in-chain entry (a dormant feed that hasn't
posted within the chain window — the common case) is removed with NO
consolidation: a reused id can never confuse a replay that holds none of the old
incarnation's articles, exactly like the packs-region old entries a reused id
already fences off via `AddFeed`'s `AddIdx`/`Expired` reset. So membership is
checked by only READING the chain (`loadDeltaChain`), not writing it — a dormant
feed stays removable even when a consolidation would fail — and only a chain that
can't be parsed at all (a corrupt segment, an unreachable store) blocks removal,
the one case that genuinely needs store repair first (dropping the
unconsolidated articles can't fix the per-feed counts an unparseable chain can't
be read for). The `cnt`-underflow clamp inside `consolidateTail` survives as
defense-in-depth only.

### 6.5 Invariants (writer-enforced, reader-assumed, inspect-checked)

- **I1 — Chain contiguity:** `data/d<g>.gz` exists for every `g` in
  `(tailGen, seq]`, holding ≥ 1 article each, chron-contiguous, jointly
  covering `[tc, total_art)`.
- **I2 — No finalization stratum inside the delta region:**
  `floor((total_art−1)/5000) == floor((tc−1)/5000)` whenever `nd > 0`.
  Consequence: `numFinalizedIdx(total_art)` and `numFinalizedMeta(total_art)`
  keep working **verbatim** on the reader — every finalized pack those formulas
  name exists, because the batch that would have crossed the stratum was forced
  to consolidate in the same Commit.
- **I3 — Tail pack coverage:** `idx/L<tailGen>` holds exactly
  `tc − numFinalizedIdx·50000` entries; `next_pid`/`pack_off` describe
  consolidated state only (chrons `< tc`).
- **I4 — Accounting equivalence:** `tc = total_art − na` and
  `Σ lines(d<g>) == na`.

## 7. Reader specification

### 7.1 Boot

`init()` fetches: db.gz → (`idx/h<hdrs>` summary when covering, as today) →
`idx/L<tailGen>` → **all `nd` deltas in parallel** (all force-cache; each delta
passes `isLatest=true` so a stale-tab 404 takes the guarded reload, §7.6).
Deltas parse into a resident `deltaArts: IArticle[]` (chron base `tc`).

The reader then materializes **one logical latest IdxPack** spanning
`[nf·50000, total_art)`: the `L<tailGen>` entries extended by the delta
articles' feed ids, with the delta region's bounds entry carrying a sentinel
packId so `getPackRef` can never route it to a data-pack fetch. Every existing
consumer — `countAll`, `countLeft`, `tallyUnread`, `findLeft/Right`,
`packHasCandidate`, `idxHeaders` — sees one uniform latest pack and needs no
per-call-site changes. `numFinalizedIdx`/`numFinalizedMeta` are untouched (I2).

Cold-boot deltas are bytes the landing view was probably about to fetch anyway
(the newest articles), but this is an honest cost increase for a reader that
lands elsewhere: up to `maxDeltas` extra requests, ≤ `maxDeltaBytes`. Both caps
are the tuning levers; the SW and the edge cache absorb repeats.

### 7.2 Article/meta/data resolution

- `loadArticle(chron)`: `chron ≥ tc` → `deltaArts[chron − tc]`, zero fetches.
  Below `tc`, unchanged (`getPackRef` → data pack, latest data pack =
  `data/L<tailGen>`).
- `loadMeta(chron)`: `chron ≥ tc` → project `{f, w: p||a, t}` from the
  resident delta article. Below `tc`: `db.head` window (§7.4), then meta packs
  (`metaReady()`), then the data/ fallback — as today, with `meta/L<tailGen>`
  as the tail shard.
- `metaReady()` becomes: `mp === numFinalizedMeta() && mp·5000 + mt + na === total_art`
  — the meta series is complete when shards + tail cover `tc` and the deltas
  cover the rest. (`mt` counts entries of `meta/L<tailGen>`, i.e. `≤ tc`.)

### 7.3 Search

`search.ts` gains a **delta overlay pass**: fold-match the resident
`deltaArts` titles first (chrons `≥ tc`, newest-first — a cheap in-memory
scan; no bloom needed at ≤ `maxDeltas` batches), then the meta tail, then the
bloom-pruned finalized shards. `available()` follows the new `metaReady()`.

### 7.4 `db.head` interplay

`head`/`hb` stay: they are the *pre-boot-completion* and *post-consolidation*
newest-window (right after consolidation `nd == 0` and there are no resident
deltas — head is then the only zero-fetch source for the landing list, exactly
as today). During a delta run head and deltas overlap; `loadMeta`'s existing
order (head window first) makes that overlap harmless. The delta path keeps
head fresh (§6.2 step 4), so head's coverage never regresses from today's.

### 7.5 Validation

Boot cross-checks (hard error → the §7.6 self-heal, mirroring
`checkLatestIdx`'s philosophy):

- `idx/L<tailGen>` entry count == `tc − nf·50000` (today's check, against `tc`).
- `Σ parsed delta lines == na` and each delta non-empty.

### 7.6 Staleness self-heal

Unchanged mechanism, wider coverage: any live-name 404 (`L<tailGen>` tails or
any `d<g>`) means this tab's db.gz predates the GC grace window →
`assertPackOk`'s sessionStorage-guarded single reload.

### 7.7 refresh() — the headline win

A heartbeat/focus refresh where one delta cycle landed: db.gz (≈10 KB) + one
`d<g>` (≈ batch size). Today the same event costs db.gz + three renamed tails
(~215 KB at a 5k-entry meta tail). A refresh that lands on a consolidation
adopts the new `L<seq>` names exactly as today (the amortized cost that
remains). `applyDb`'s wholesale-rebuild strategy is unchanged — old deltas
re-resolve from the SW/HTTP cache for free.

## 8. GC and the grace window — ⚠ two silent breakages to respec

Both the backend GC and the SW prune currently derive horizons from `seq`
assuming `L<seq>` is the live tail. Under lazy consolidation `seq` runs ahead
of `tailGen`, and **both would delete the live tail packs** if left unchanged.
This section is normative:

- Rationale for the protected window: a tab holds a db.gz at most
  `latestKeep = 2` commits stale; between two consecutive consolidations at
  most `maxDeltas + 1` commits pass, so the stalest tab's
  `tailGen_old ≥ tailGen − 2·(maxDeltas+1)`, and its needed deltas satisfy
  `g > tailGen_old`.
- **Backend `GCLatest` (as implemented, low-water):** cutoff
  `tailGen − keep − 1 − 2·maxDeltas` (one generation more conservative than
  the derivation needs, keeping the codebase's `−keep−1` idiom; reduces to the
  exact pre-delta cutoff at the `maxDeltas = 0` kill switch) marks the grace
  boundary — nothing above it is ever swept. The sweep is a **low-water drain**,
  NOT a fixed trailing window: it clears `(GCLatestSwept, cutoff]` and advances
  the persisted low-water mark `GCLatestSwept` (db.gz `gcs`) ONLY over
  generations it actually cleared. This is normative because `tailGen` JUMPS at
  consolidation (by up to `maxDeltas+1`) and the cutoff jumps with it — further
  still when an operator lowers `--max-deltas` — so any fixed trailing window
  strands every name inside a jump larger than it, and a single missed/failed
  sweep (GC is warn-only, post-Commit) strands them **forever**, since no later
  run's window reaches back that far (the pre-delta "a crash-leaked name is
  still swept by the next advancing run" guarantee, which a fixed window broke
  for `maxDeltas > 2`). The low-water closes the gap: the next advancing run
  resumes exactly where the last stopped, so nothing is ever permanently
  stranded regardless of jump size or config change. Per-run work is bounded by
  `gcMaxSweep` (a large one-time backlog — a long-missed sweep, a big
  `--max-deltas` reduction, or the first run on a store predating `gcs` — drains
  over several runs). Sweeps `idx/L<g>`, `data/L<g>`, `meta/L<g>`, `data/d<g>`,
  gated on tail-generation advance (delta cycles supersede nothing). `gcs` is
  writer-only (frontend/SW ignore it) and left untouched by `BumpGen` (a rebuild
  reuses finalized names but the tail-generation names are unchanged).
- **SW `checkManifest` (respecified, mirrors the backend GC):** reads `gcs`
  alongside `gen`/`seq`/`hdrs`/`mp`; prunes cached `L<g>` and `d<g>` with
  `g ≤ gcs` — the backend GC's OWN low-water. This keeps the cache aligned with
  the store (evict exactly what the store deleted, keep exactly what it still
  serves) and is correct for offline reads at ANY runtime `--max-deltas` without
  the reader knowing that value: a stale open tab needs names only down to its
  own `tailGen_old`, and the grace derivation above gives
  `tailGen_old > cutoff ≥ gcs`, so a name it needs is never evicted. A bare
  `tailGen − LATEST_KEEP` cutoff (this spec's first draft) instead evicts the
  whole just-consolidated chain across a `tailGen` JUMP — losing a still-open
  tab's offline delta read; and a `tailGen − LATEST_KEEP − 2·maxDeltas` cutoff
  can't be computed reader-side without coupling to the build-time `MAX_DELTAS`
  constant (wrong for a non-default runtime). `gcs` in db.gz lags the live sweep
  by one cycle (GC runs post-Commit), a safe direction — the cache keeps a
  just-swept name one cycle longer. Gen-change purge and the `h<g>`/`s<g>`
  prunes (`− LATEST_KEEP`; those counters don't jump) are unchanged; the pinned
  bucket keeps its existing rules (gen-purged, seq-prune-exempt).
- `GCSummaries`/`GCMetaSummaries`: unchanged (keyed on `hdrs`/`mp`, which only
  advance at consolidation).

## 9. Backend read side and ops tooling

- `idx_read.go` (`loadIdxPacks`/`getPackRef`): mirror §7.1 — extend the parsed
  latest pack with delta entries; `chron ≥ tc` resolves content from the
  parsed deltas. One parser, as today.
- `walkArticles` (`db_meta.go`) walks `[from, to)` across packs **and deltas** —
  this is what keeps `ExpireArticles` (whose cutoff can legally land inside the
  delta region; `add_idx` is chron-based and doesn't care) and `SyncOutFeeds`
  correct without changes of their own.
- `srr inspect --validate` new checks: I1 (chain present + contiguous +
  line-counts sum to `na`), I2 (no stratum inside the delta region), I3 (tail
  entry count vs `tc`), fetched_at monotonicity across the `tc` seam, and the
  existing checks re-anchored on `tc` where they read the latest packs.
- `srr art ls`, `pack-inspector` workflows: inherit via `idx_read.go`.

## 10. Grammar / generated-contract changes

- `store.PackSeries`: `{"data", "L"}` → `{"data", "Ld"}`. Falls through to
  `packKeyRe` (immutable Cache-Control, `application/gzip`), the SW's
  `parsePackName` via the regenerated `PACK_SERIES_KINDS`, and
  `sw-grammar.ts`'s per-series strictness (`idx/d3.gz` stays a non-name).
- `srr gen-ts` additions: `MAX_DELTAS` constant; `IDBWire` gains `nd?`, `na?`,
  `dby?` (frontend ignores `dby`, like `recipes`/`out`).
- `frontend data.ts packNamesForFilter` (offline pin): always include the live
  `data/d<g>` names (they are latest-scope for every filter), and the pin
  docs' snapshot caveat covers them as-is.
- Root `CLAUDE.md` Data Contract + `backend/CLAUDE.md` + `frontend/CLAUDE.md`
  sections for the new object class, the `nd`/`na`/`dby` rows, and the
  respecified GC/SW rules.

## 11. Configuration

| Knob | Flag / env | Default | Meaning |
|---|---|---|---|
| `maxDeltas` | `--max-deltas` / `SRR_MAX_DELTAS` | 12 | Chain cap (≈1 h at 5-min cycles). **0 = kill switch**: every dirty cycle consolidates — byte-identical behavior to today (§12.1 pins this). |
| `maxDeltaBytes` | `--max-delta-bytes` / `SRR_MAX_DELTA_BYTES` | 256 KiB | Cap on Σ uncompressed delta bytes (`dby`) — bounds cold-boot delta payload (G4). |

## 12. Testing plan

### 12.1 The consolidation-equivalence property (Go, the anchor test)

Feed the same sequence of batches through (a) the delta path with a final
forced consolidation and (b) `maxDeltas = 0`, against two stores. Assert the
**bytes** of every finalized pack, tail pack, summary, and meta shard are
identical, and db.gz cores are equal modulo `seq` bookkeeping. The writer is
deterministic (stdlib gzip + zopfli on fixed input), so this is a strict
equality test. It structurally catches the §6.1 as-of-count class, boundary
placement, and footer/boundary drift. Sub-cases: batch crossing a 5k stratum
(forced consolidation), batch crossing 50k, data-pack rolls mid-replay,
expiration advancing `add_idx` between delta cycles.

**Known carve-out (feed membership changes mid-chain):** a feed ADDED between
delta cycles widens the consolidation-time `numSlots` snapshot, so a pack
finalized mid-replay can carry more header slots than the per-cycle writer
would have written for the identical history — reader-harmless (the extra
slots are genuinely 0) but not byte-identical. Feed REMOVAL cannot create a
mid-chain divergence at all: it drains first (§6.4).

### 12.2 Contract layer (`frontend/e2e/contract/`, new `delta.e2e.test.ts`)

Real `srr` with `maxDeltas > 0` → real reader:

- Mid-chain store (`nd > 0`): every chron round-trips; counts/filters/search
  agree with `srr inspect`; a delta-region article renders with **zero**
  data/meta pack fetches (request-budget assert via the fetch shim).
- `refresh()` after one delta cycle fetches **exactly** db.gz + the one new
  `d<g>` (the headline contract, pinned as a request budget).
- Consolidation cycle adopted via `refresh()`; a post-consolidation boot has
  no delta fetches.
- Stale-tab: a db.gz older than the grace window 404s on a GC'd delta →
  guarded reload path.
- `metaReady()` arithmetic with `nd > 0`, and the meta-lag fallback intact.
- Empty-store and pre-delta-store bridges (`nd` absent).

### 12.3 Browser + stress layers

- SW: delta cached into `srr-packs-v3` (name grammar), pruned by the §8 rule on
  seq advance, gen-purge unchanged; offline read of a delta-region article.
- Stress: boot request budget at `SRR_STRESS_N` with a full chain
  (≤ `maxDeltas` extra requests), delta-region navigation timing.

## 13. Rollout / rollback

1. Ship the reader first (CF Pages + `srr frontend update`): a reader with this
   spec on a pre-delta store sees `nd` absent and behaves byte-for-byte like
   today (§5). Old tabs keep working — nothing changed on the store yet.
2. Ship the backend with `--max-deltas 0` (dark). Flip to the default once the
   deployed readers are confirmed current (the admin GUI version label /
   `srr.32b.io` check). An old reader meeting `nd > 0` fails on
   `idx/L<seq>` (404 → reload loop → error surface) — that is the one
   coordinated break, taken deliberately per the project's single-operator
   "clean break" precedent.
3. Rollback at any time: set `--max-deltas 0`; the next dirty cycle
   consolidates and the store is structurally pre-delta again (`nd == 0`).
   No rebuild, no `gen --bump`, no purge.

## 14. Interactions and future work

- **Proposal #1 (snapshot/HEAD-pointer commits):** composes cleanly — the
  snapshot manifest would list the live delta names explicitly instead of the
  reader deriving them from `nd`/`seq`, and `tc` validation moves into the
  manifest. Nothing in this spec pre-empts it; `nd`-arithmetic is the only
  part #1 would later subsume.
- **Meta stride shrink / head growth:** deltas reduce the pressure that
  motivated both; re-evaluate after this ships.
- Deliberately not included: per-delta search blooms (resident scan is
  cheaper at this scale), idle-cycle consolidation (dormant chains are cheap
  and self-draining), delta compaction levels (G-non-goal).

## 15. Costs and risks (honest ledger)

- **Complexity:** three new db.gz fields, one new name kind, two respecified GC
  rules, the §6.1 count-vector subtlety, and delta-awareness in
  `walkArticles`/`idx_read.go`/`inspect`. Bounded by the equivalence test and
  by reusing the materialization loop verbatim rather than forking it.
- **Cold boot:** up to `maxDeltas` extra requests / `maxDeltaBytes` bytes for
  first-time visitors (class-B ops scale with cold readers; the edge cache
  absorbs the bytes).
- **Coordinated break:** step 2 of §13 — an operator error (backend flipped
  before readers) shows as reload-loop errors on stale readers until readers
  update or `--max-deltas 0` is restored.
- **What this does NOT fix:** per-cycle db.gz + seen.gz rewrites (~11 KB — the
  floor this design leaves standing; proposal #1's territory), feed-side fetch
  traffic, and consolidation cycles still paying today's full tail rewrite
  (amortized 1/`maxDeltas`).
