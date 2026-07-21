# Parallel asset processing with a global concurrency limit

Date: 2026-06-25
Status: Design approved (pending spec review)

## Problem

Asset self-hosting work — the end-of-pipeline step that, per `#`-marker, runs
`asset-peek` → `SRR_ASSET_PROCESS` transcode → store upload, all inside
`assetFetcher.UploadCacheRef` — currently runs **serially within a feed**:

- `backend/feed.go` `fetchURL`'s second pass loops items one at a time.
- Each item's `mod.RewriteAttrs` walks its marker-bearing attributes
  synchronously, calling `UploadCacheRef` one asset at a time.

The only parallelism is **cross-feed** (`errgroup.SetLimit(globals.Workers)` in
`cmd_fetch.go`). So a single media-heavy feed (e.g. a Telegram channel whose
external ingest downloads one image per message) transcodes all its assets
serially on one feed-worker while the other feed-workers sit idle. The expensive
unit — a `webify`/`SRR_ASSET_PROCESS` transcode — gets no intra-feed parallelism.

## Goal

Process assets in parallel, bounded by a **configurable global limit** that is
**independent of `--workers`** (the feed-fetch concurrency knob).

## Scope

In scope: the asset **upload/transcode step** only — `UploadCacheRef`
(peek + `SRR_ASSET_PROCESS` + store upload), invoked from the end-of-pipeline
asset-rewrite in `feed.go`.

Out of scope: parallelizing `processItem` (the module pipeline, including
`#readability` / `#selfhost` network downloads). The per-feed `*mod.Module`
processor is not goroutine-safe (minify reuses internal buffers), so the pipeline
pass stays serial. The asset uploader, by contrast, is already concurrent-safe
(shared across feed-workers today), which is exactly why this step parallelizes
cleanly.

## Design

### Concurrency model: independent global pool

A new global limit caps the **total** number of asset jobs running concurrently
across **all** feeds, decoupled from `--workers`. A media-heavy feed may use the
whole pool; total concurrent transcodes never exceed the limit regardless of how
assets distribute across feeds.

### Config surface

New global flag on `Globals` (`backend/main.go`):

```
AssetWorkers int  `default:"${nproc}" env:"SRR_ASSET_WORKERS"
  help:"Max assets processed concurrently across all feeds (peek/transcode/upload)."`
```
(No short flag — `-w` stays `Workers`'s; this knob is long-form only.)

- Default `${nproc}` via the existing `kong.Vars` mechanism (same Var as
  `Workers`), so `--help` shows the machine's CPU count.
- Post-parse floor in `main.go` (next to the existing `Workers` floor):
  `if globals.AssetWorkers < 1 { globals.AssetWorkers = runtime.NumCPU() }`.
- **Independent of `--workers`**: defaults to nproc regardless of `-w`. Setting
  `-w 4` to reduce feed-fetch load does NOT lower asset concurrency unless
  `--asset-workers` is also set. (Decision: independent nproc default, chosen over
  inheriting `--workers`.)
- No data-contract impact: not a format atom, so no `srr gen-ts` /
  `format.gen.ts` change. `srr config` prints it automatically (it reflects the
  `Globals` struct); `SRR_ASSET_WORKERS` derives conventionally from the field
  name, so no special annotation.

### Mechanism

1. `fetchRun` (`backend/feed.go`) gains a run-scoped field
   `assetSem chan struct{}` — the **global** semaphore, shared across every
   feed-worker (like `cacheDir` and `assets` already are).

2. `cmd_fetch.go` `fetch` builds it once:
   `run.assetSem = make(chan struct{}, globals.AssetWorkers)`.

3. `assetFetcher` and `UploadCacheRef` are **untouched**. They are already
   concurrent-safe: `seen` is a `sync.Map`, and the store-existence check +
   `AtomicPut` idempotency are the documented cross-worker-race backstop. All
   existing `newAssetFetcher(...)` test call sites stay as-is.

4. The inline asset-upload block in `fetchURL`'s second pass is extracted into a
   method `(run *fetchRun) uploadAssets(ctx context.Context, c *Feed, items []*Item) error`:

   - The pipeline pass (`processItem`) stays **serial** and now just builds
     `items` with un-rewritten content (markers intact).
   - `uploadAssets` fans out over `items` with a per-feed
     `errgroup.WithContext(ctx)`. Each **marker-bearing** item runs in a
     goroutine that:
     - acquires `run.assetSem` cancellation-awarely:
       `select { case run.assetSem <- struct{}{}: case <-gctx.Done(): return gctx.Err() }`,
       `defer func(){ <-run.assetSem }()`;
     - runs `mod.RewriteAttrs(items[k].Content, fn)` where `fn` is the existing
       `UploadCacheRef` + `errNotAsset` closure (unchanged policy: not-a-marker →
       decline, genuine upload failure → return error);
     - writes the result back to `items[k].Content` in place (distinct items per
       goroutine ⇒ no data race).
   - `g.Wait()` returns the first hard error, which fails the whole feed —
     identical feed-level atomicity to today (feed state untouched on error,
     self-heals next fetch; a permanently-rejected asset wedges the feed).

5. **Gating** (keeps the no-self-hosting common case zero-overhead): extract the
   cheap check already at the top of `RewriteAttrs` into an exported helper in
   `mod/helper_assets.go`:
   `func HasAssetMarkers(content string) bool { return strings.Contains(content, "#") && markerShapeRe.MatchString(content) }`.
   `RewriteAttrs` uses `!HasAssetMarkers(content)` for its early return.
   `uploadAssets` uses it to skip items with no markers entirely — no goroutine,
   no semaphore slot — so feeds that don't self-host behave exactly as today.

6. **Nil-safe for tests**: `uploadAssets` branches on `cap(run.assetSem)`
   (`cap(nil) == 0`). When 0, it runs the rewrite serially inline — byte-identical
   to current behavior — so the many `fetchRun{...}` literals in `feed_test.go`
   that don't set the field need no changes.

### Order & determinism

`uploadAssets` mutates `items[k].Content` in place by index, so the `items` slice
order is preserved regardless of goroutine completion order. (Final article order
is set later by `cmd_fetch`'s sort by `Published` anyway.)

## Accepted trade-off (YAGNI)

With intra-feed parallelism, two items in the **same** feed referencing the
**same** marker can both miss the `seen` memo and both run the transcode. This is
**correct** (store-existence check + `AtomicPut` dedup the upload) but wastes CPU
on the redundant transcode. The dominant case (one unique image per message) has
no duplicates, so we **accept** this rather than add `golang.org/x/sync/singleflight`.

Future option (not implemented now): a `singleflight.Group` keyed on the marker
string (or source hash) would collapse concurrent identical sources to one
transcode, restoring the serial code's intra-feed dedup. Left out per YAGNI.

## Testing

New test at the `fetchRun.uploadAssets` level (in `feed_test.go` or
`assets_test.go`), using a fake `store.Backend`:

1. **Correctness**: a feed with N marker-bearing items + some marker-less items —
   assert every marker is rewritten to its `assets/...` key and marker-less items
   are untouched.
2. **Feed-level atomicity**: a backend that fails one `AtomicPut` makes
   `uploadAssets` return an error (whole feed fails).
3. **Concurrency bound**: a barrier-style fake backend (each job signals arrival
   and blocks until released) asserts that **no more than `AssetWorkers` jobs run
   concurrently**. Barrier-based, not timing-based, so it is not flaky.
4. **Gating**: marker-less items never acquire a semaphore slot / never reach the
   backend.

Full check: `make verify-be` (vet + gofmt + build + existing asset/feed tests +
`generate-check`).

## Files touched

- `backend/main.go` — `Globals.AssetWorkers` flag + post-parse floor.
- `backend/cmd_fetch.go` — build `run.assetSem` from `globals.AssetWorkers`.
- `backend/feed.go` — `fetchRun.assetSem` field; extract `uploadAssets`; replace
  the inline per-item `RewriteAttrs` call in `fetchURL`.
- `backend/mod/helper_assets.go` — export `HasAssetMarkers`; use it in
  `RewriteAttrs`.
- `backend/feed_test.go` / `backend/assets_test.go` — concurrency + correctness
  tests.
- `backend/CLAUDE.md` + root `CLAUDE.md` — document `SRR_ASSET_WORKERS` and the
  parallel asset step.
