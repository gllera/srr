# Parallel Asset Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Process self-hosted assets concurrently within a feed, bounded by a configurable global pool (`SRR_ASSET_WORKERS` / `--asset-workers`) that is independent of `--workers`.

**Architecture:** A run-global semaphore (`fetchRun.assetSem`) caps total concurrent asset jobs across all feeds. `feed.go`'s inline per-item upload block becomes `(*fetchRun).uploadAssets`, which fans out marker-bearing items via a per-feed `errgroup` while each goroutine acquires the shared semaphore. The pipeline pass (`processItem`) stays serial; `UploadCacheRef`/`assetFetcher` are untouched (already concurrent-safe). Marker-less items are skipped via a new exported `mod.HasAssetMarkers`, so non-self-hosting feeds keep zero overhead and a nil semaphore runs serially (test parity).

**Tech Stack:** Go 1.26, `golang.org/x/sync/errgroup`, `alecthomas/kong` flags, existing `store.Backend` fakes in `assets_test.go`.

Spec: `docs/superpowers/specs/2026-06-25-parallel-asset-processing-design.md`

---

## File Structure

- `backend/mod/helper_assets.go` — add exported `HasAssetMarkers`; `RewriteAttrs` reuses it.
- `backend/mod/helper_assets_test.go` — unit test for `HasAssetMarkers`.
- `backend/main.go` — `Globals.AssetWorkers` flag + post-parse floor.
- `backend/feed.go` — `fetchRun.assetSem` field; new `(*fetchRun).uploadAssets`; `fetchURL` second pass no longer inlines the upload; add `errgroup` import.
- `backend/cmd_fetch.go` — build `run.assetSem` from `globals.AssetWorkers`.
- `backend/feed_test.go` — concurrency-bound + correctness/gating + feed-fail tests for `uploadAssets`.
- `backend/CLAUDE.md` + root `CLAUDE.md` — document the new flag and the parallel step.

---

## Task 1: Export `mod.HasAssetMarkers`

**Files:**
- Modify: `backend/mod/helper_assets.go` (the early-return in `RewriteAttrs`, ~line 69)
- Test: `backend/mod/helper_assets_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/mod/helper_assets_test.go`:

```go
func TestHasAssetMarkers(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"img marker", `<img src="#/a.jpg">`, true},
		{"anchor marker", `<a href="#/doc.pdf">x</a>`, true},
		{"single-quoted marker", `<img src='#/a.jpg'>`, true},
		{"bare fragment anchor", `<a href="#section">x</a>`, true}, // shape matches; fn declines later
		{"plain hash text", `<p>cost is #1 today</p>`, false},
		{"no hash at all", `<p><img src="https://x/a.jpg"></p>`, false},
		{"empty", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := HasAssetMarkers(c.in); got != c.want {
				t.Errorf("HasAssetMarkers(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}
```

Note: `#section` returns `true` here because `HasAssetMarkers` is the cheap *shape* gate (`=["']?#`); the actual not-a-marker decline still happens in `UploadCacheRef` via `errNotAsset`. This matches `RewriteAttrs`'s existing pre-parse behavior exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./mod/ -run TestHasAssetMarkers -v`
Expected: FAIL — `undefined: HasAssetMarkers`.

- [ ] **Step 3: Add the helper and reuse it in `RewriteAttrs`**

In `backend/mod/helper_assets.go`, add after the `markerShapeRe` var (after ~line 58):

```go
// HasAssetMarkers reports whether content can carry any "#"-upload marker. A
// marker is always a whole attribute value, so content without the `=["']?#`
// shape holds none — this is the cheap pre-check (memchr-speed common case:
// #feed feeds never emit markers). The asset-upload pass uses it to skip
// marker-less items without spawning a goroutine; RewriteAttrs uses it to skip
// the HTML parse entirely.
func HasAssetMarkers(content string) bool {
	return strings.Contains(content, "#") && markerShapeRe.MatchString(content)
}
```

Then replace the early-return condition in `RewriteAttrs` (the block at ~line 69):

```go
	// A marker is always a whole attribute value, so content without the
	// `=["']?#` shape can hold none: skip the parse entirely.
	if !HasAssetMarkers(content) {
		return content, nil
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./mod/ -run 'TestHasAssetMarkers|TestRewriteAttrs' -v`
Expected: PASS (new test + existing RewriteAttrs tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/mod/helper_assets.go backend/mod/helper_assets_test.go
git commit -m "refactor(assets): export mod.HasAssetMarkers; reuse in RewriteAttrs"
```

---

## Task 2: Add `--asset-workers` flag

**Files:**
- Modify: `backend/main.go:37` (Globals, after `AssetPeek`) and `backend/main.go:214-216` (post-parse floor)

- [ ] **Step 1: Add the flag field**

In `backend/main.go`, in the `Globals` struct, add immediately after the `AssetPeek` field (line 37):

```go
	AssetWorkers int    `                             env:"SRR_ASSET_WORKERS" default:"${nproc}" help:"Max assets processed concurrently across all feeds (peek/transcode/upload). Independent of --workers."`
```

- [ ] **Step 2: Add the post-parse floor**

In `backend/main.go`, immediately after the existing `Workers` floor (lines 214-216):

```go
	if globals.Workers < 1 {
		globals.Workers = runtime.NumCPU()
	}
	if globals.AssetWorkers < 1 {
		globals.AssetWorkers = runtime.NumCPU()
	}
```

(`${nproc}` is already registered in `kong.Vars`; `runtime` is already imported.)

- [ ] **Step 3: Build and smoke-check the flag**

Run:
```bash
cd backend && go build -o /tmp/srr-aw . && /tmp/srr-aw config asset-workers
```
Expected: prints a single integer (the nproc default), no error. Also:
```bash
SRR_ASSET_WORKERS=3 /tmp/srr-aw config asset-workers
```
Expected: prints `3`.

- [ ] **Step 4: Commit**

```bash
git add backend/main.go
git commit -m "feat(assets): add --asset-workers/SRR_ASSET_WORKERS global flag"
```

---

## Task 3: Extract `uploadAssets` (serial, behavior-preserving)

This is a pure refactor: move the inline upload block out of `fetchURL` into a `fetchRun` method with no behavior change. Verified by existing tests.

**Files:**
- Modify: `backend/feed.go` — imports (add errgroup is deferred to Task 4; not needed yet), `fetchURL` second pass (~lines 311-386), add `uploadAssets` method.

- [ ] **Step 1: Replace the inline upload block in `fetchURL`**

In `backend/feed.go`, the second-pass loop currently builds `items` and rewrites `i.Content` inline via `mod.RewriteAttrs`. Replace the whole block (from `// Second pass:` at ~line 311 down to the `items = append(...)` that closes the loop at ~line 386) with this loop that builds `items` *without* rewriting, then calls `uploadAssets`:

```go
	// Second pass: run the module pipeline for the items committed to ingestion.
	// Asset self-hosting (the "#"-marker upload) is deferred to uploadAssets below
	// so it can run concurrently across the feed's items.
	var items []*Item
	for _, cand := range candidates {
		i := cand.item
		// Only bg-class items (dateless or at/above the new watermark) can be in
		// dropped — anything below maxPub is protected by Watermark next fetch.
		if _, skip := dropped[i.GUID]; skip {
			continue
		}
		if err := processItem(ctx, processor, pipeline, i); err != nil {
			// One bad item must not discard the whole feed's batch. Config errors
			// are caught up front by Validate, so this is a per-item runtime
			// failure: skip just this item. Its GUID stays in boundary, so it is
			// not retried next fetch.
			slog.Warn("dropping item: pipeline error", "url", c.URL, "link", i.Link, "err", err)
			continue
		}
		// A pipeline step may deliberately drop an item (i.Drop=true). Its GUID was
		// already recorded in boundary above, so it stays deduped without storing.
		if i.Drop {
			continue
		}
		items = append(items, &Item{
			Feed:      c,
			Title:     i.Title,
			Content:   i.Content,
			Link:      i.Link,
			Published: cand.pub,
		})
	}

	// Store-side end-of-pipeline step (kept out of processItem, which stays a
	// pure, store-free transform): self-host each item's "#"-marked assets.
	if err := run.uploadAssets(ctx, items); err != nil {
		return nil, err
	}
```

- [ ] **Step 2: Add the `uploadAssets` method**

In `backend/feed.go`, add this method (place it right after `fetchURL`, before `uint32Set`):

```go
// uploadAssets runs the end-of-pipeline self-hosting step on each item's
// content: it scans the item's self-hostable attributes (img/video/audio src,
// video poster, a href — see mod.RewriteAttrs) for "#"-upload markers naming a
// file the fetcher left in run.cacheDir (e.g. "#/photo.jpg") and rewrites each
// to its final assets/ store key. A "#..." naming no such file is an ordinary
// in-page fragment, left as-is (declined via errNotAsset).
//
// A failed upload (store error, or an UploadCacheRef guard tripping on
// oversize/traversal) hard-fails the whole feed by returning the error: the
// caller leaves feed state (watermark, dedup, etag) untouched, so a transient
// store failure self-heals next fetch while a permanently-rejected asset wedges
// the feed until fixed.
//
// Marker-less items are skipped without any work (the common case: #feed feeds
// emit no markers). Concurrency is added in uploadAssets's parallel path (see
// run.assetSem); this serial form is the cap(assetSem)==0 fallback.
func (run *fetchRun) uploadAssets(ctx context.Context, items []*Item) error {
	for _, i := range items {
		if !mod.HasAssetMarkers(i.Content) {
			continue
		}
		if err := run.rewriteItemAssets(ctx, i); err != nil {
			return err
		}
	}
	return nil
}

// rewriteItemAssets rewrites one item's "#"-upload markers to assets/ keys via
// UploadCacheRef. errNotAsset references (bare #fragments, paths escaping the
// cache dir) are declined and left untouched; any other upload failure is
// returned (failing the feed).
func (run *fetchRun) rewriteItemAssets(ctx context.Context, i *Item) error {
	content, err := mod.RewriteAttrs(i.Content, func(local string) (string, bool, error) {
		key, err := run.assets.UploadCacheRef(ctx, run.cacheDir, local)
		switch {
		case err == nil:
			return key, true, nil
		case errors.Is(err, errNotAsset):
			return "", false, nil
		default:
			return "", false, fmt.Errorf("self-host asset %q: %w", local, err)
		}
	})
	if err != nil {
		return err
	}
	i.Content = content
	return nil
}
```

- [ ] **Step 3: Build and run the existing asset/feed tests (no behavior change)**

Run: `cd backend && go build ./... && go test . -run 'Feed|UploadCacheRef|Fetch' -count=1`
Expected: PASS — the extraction is behavior-preserving, so all existing feed/asset tests pass unchanged.

- [ ] **Step 4: Commit**

```bash
git add backend/feed.go
git commit -m "refactor(assets): extract fetchRun.uploadAssets from fetchURL (serial)"
```

---

## Task 4: Parallelize `uploadAssets` with the global semaphore

**Files:**
- Modify: `backend/feed.go` — add `errgroup` import, `fetchRun.assetSem` field, parallel path in `uploadAssets`.
- Modify: `backend/cmd_fetch.go:119-126` — set `run.assetSem`.
- Test: `backend/feed_test.go`

- [ ] **Step 1: Write the failing concurrency + correctness tests**

Append to `backend/feed_test.go`:

```go
// gateBackend wraps a store.Backend to make AtomicPut block on a per-call
// release, so a test can drive exactly how many uploads run concurrently and
// assert the observed peak never exceeds the semaphore cap. Deterministic: no
// sleeps — the test releases jobs one at a time and watches arrivals.
type gateBackend struct {
	store.Backend
	mu      sync.Mutex
	cur     int
	max     int
	arrived chan struct{} // one send per AtomicPut entry
	release chan struct{} // one receive unblocks one AtomicPut
}

func (g *gateBackend) AtomicPut(ctx context.Context, key string, r io.Reader, meta store.ObjectMeta) error {
	g.mu.Lock()
	g.cur++
	if g.cur > g.max {
		g.max = g.cur
	}
	g.mu.Unlock()
	g.arrived <- struct{}{}
	<-g.release
	g.mu.Lock()
	g.cur--
	g.mu.Unlock()
	return g.Backend.AtomicPut(ctx, key, r, meta)
}

// assetItems builds n items each referencing a distinct cache file (distinct
// bytes ⇒ distinct source hash ⇒ no seen/existence dedup), plus the cache dir.
func assetItems(t *testing.T, n int) (string, []*Item) {
	t.Helper()
	cacheDir := t.TempDir()
	items := make([]*Item, n)
	for k := 0; k < n; k++ {
		name := fmt.Sprintf("a%d.jpg", k)
		writeCacheFile(t, cacheDir, name, fmt.Sprintf("BYTES-%d", k))
		items[k] = &Item{Content: fmt.Sprintf(`<p><img src="#/%s"></p>`, name)}
	}
	return cacheDir, items
}

func TestUploadAssetsConcurrencyBound(t *testing.T) {
	const limit, n = 2, 3
	gate := &gateBackend{
		Backend: tempStore(t),
		arrived: make(chan struct{}),
		release: make(chan struct{}),
	}
	cacheDir, items := assetItems(t, n)
	run := &fetchRun{
		assets:   newAssetFetcher(gate, 1<<20, ""),
		cacheDir: cacheDir,
		assetSem: make(chan struct{}, limit),
	}

	done := make(chan error, 1)
	go func() { done <- run.uploadAssets(context.Background(), items) }()

	// Exactly `limit` jobs reach AtomicPut and block.
	for k := 0; k < limit; k++ {
		<-gate.arrived
	}
	// Release one → frees a slot → the (limit+1)-th job now arrives. Proves the
	// cap both holds (only `limit` arrived first) and makes progress.
	gate.release <- struct{}{}
	<-gate.arrived
	// Release the rest.
	for k := 0; k < n-1; k++ {
		gate.release <- struct{}{}
	}
	if err := <-done; err != nil {
		t.Fatalf("uploadAssets: %v", err)
	}
	if gate.max > limit {
		t.Errorf("peak concurrency = %d, want <= %d", gate.max, limit)
	}
	for k, it := range items {
		if strings.Contains(it.Content, "#/") {
			t.Errorf("item %d not rewritten: %q", k, it.Content)
		}
		if !strings.Contains(it.Content, "assets/") {
			t.Errorf("item %d missing assets/ key: %q", k, it.Content)
		}
	}
}

func TestUploadAssetsRewritesAndSkipsMarkerless(t *testing.T) {
	be := tempStore(t)
	cacheDir, marked := assetItems(t, 2)
	plain := &Item{Content: `<p>no markers, cost #1</p>`}
	items := append(marked, plain)
	run := &fetchRun{
		assets:   newAssetFetcher(be, 1<<20, ""),
		cacheDir: cacheDir,
		assetSem: make(chan struct{}, 4),
	}
	if err := run.uploadAssets(context.Background(), items); err != nil {
		t.Fatalf("uploadAssets: %v", err)
	}
	for k := 0; k < 2; k++ {
		if !strings.Contains(items[k].Content, "assets/") {
			t.Errorf("marked item %d not rewritten: %q", k, items[k].Content)
		}
	}
	if plain.Content != `<p>no markers, cost #1</p>` {
		t.Errorf("marker-less item mutated: %q", plain.Content)
	}
}

func TestUploadAssetsFailsFeedOnUploadError(t *testing.T) {
	be := &failMidWriteBackend{Backend: tempStore(t), writeOK: 2}
	cacheDir, items := assetItems(t, 2)
	run := &fetchRun{
		assets:   newAssetFetcher(be, 1<<20, ""),
		cacheDir: cacheDir,
		assetSem: make(chan struct{}, 4),
	}
	if err := run.uploadAssets(context.Background(), items); err == nil {
		t.Fatal("expected uploadAssets to fail the feed, got nil")
	}
}
```

Confirm `feed_test.go`'s import block contains `context`, `fmt`, `io`, `strings`, `sync`, `testing`, and `srrb/store`. Add any missing (`io`, `sync`, `srrb/store` are the likely additions).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test . -run TestUploadAssets -v`
Expected: FAIL — `fetchRun` has no field `assetSem` (compile error).

- [ ] **Step 3: Add the `assetSem` field and the parallel path**

In `backend/feed.go`, add `errgroup` to the import block:

```go
import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"

	"srrb/ingest"
	"srrb/mod"

	"golang.org/x/sync/errgroup"
)
```

Add the field to the `fetchRun` struct (after `recipes`):

```go
	// assetSem is the run-global asset-processing pool (SRR_ASSET_WORKERS): every
	// feed's uploadAssets acquires a slot per marker-bearing item, so the total
	// number of concurrent peek/transcode/upload jobs across ALL feeds this run is
	// capped at cap(assetSem). A nil / zero-capacity channel (unit tests) makes
	// uploadAssets run serially — identical to the pre-parallel behaviour.
	assetSem chan struct{}
```

Replace the body of `uploadAssets` with the gated serial + parallel branch:

```go
func (run *fetchRun) uploadAssets(ctx context.Context, items []*Item) error {
	// Serial fallback: no asset pool configured (unit tests with a nil channel).
	if cap(run.assetSem) == 0 {
		for _, i := range items {
			if !mod.HasAssetMarkers(i.Content) {
				continue
			}
			if err := run.rewriteItemAssets(ctx, i); err != nil {
				return err
			}
		}
		return nil
	}

	// Parallel: one goroutine per marker-bearing item, each acquiring a slot from
	// the run-global pool so concurrent asset jobs across all feeds stay capped at
	// cap(assetSem). The per-feed errgroup returns the first hard error and
	// cancels its siblings (gctx), failing the whole feed.
	g, gctx := errgroup.WithContext(ctx)
	for _, i := range items {
		if !mod.HasAssetMarkers(i.Content) {
			continue
		}
		g.Go(func() error {
			select {
			case run.assetSem <- struct{}{}:
			case <-gctx.Done():
				return gctx.Err()
			}
			defer func() { <-run.assetSem }()
			return run.rewriteItemAssets(gctx, i)
		})
	}
	return g.Wait()
}
```

(Loop var `i` is per-iteration on Go 1.26 — no reshadow needed, matching `cmd_fetch.go`'s `for _, ch := range ...` style.)

- [ ] **Step 4: Wire the semaphore in `cmd_fetch.go`**

In `backend/cmd_fetch.go`, in the `run := &fetchRun{...}` literal (lines 119-126), add the `assetSem` field:

```go
		run := &fetchRun{
			client:    client,
			engine:    engine,
			assets:    assets,
			cacheDir:  cacheDir,
			fetchedAt: db.core.FetchedAt,
			recipes:   db.core.Recipes,
			assetSem:  make(chan struct{}, globals.AssetWorkers),
		}
```

- [ ] **Step 5: Run the new tests (with the race detector)**

Run: `cd backend && go test . -run TestUploadAssets -race -count=1 -v`
Expected: PASS — all three tests, no data race.

- [ ] **Step 6: Commit**

```bash
git add backend/feed.go backend/cmd_fetch.go backend/feed_test.go
git commit -m "feat(assets): parallel asset processing bounded by SRR_ASSET_WORKERS"
```

---

## Task 5: Documentation

**Files:**
- Modify: `backend/CLAUDE.md` (Asset self-hosting section + the `cmd_fetch.go` bullet)
- Modify: `CLAUDE.md` (root — the `SRR_ASSET_PROCESS` / asset discussion if it enumerates asset env vars)

- [ ] **Step 1: Document the flag and parallel step in `backend/CLAUDE.md`**

In `backend/CLAUDE.md`, in the `cmd_fetch.go` architecture bullet, note that the asset-upload step now fans out. Find the `assetFetcher.UploadCacheRef` paragraph in the "Asset self-hosting" section and add a sentence describing parallelism. Add this to the `cmd_fetch.go` bullet (after the `errgroup ... SetLimit(globals.Workers)` sentence):

```markdown
The end-of-pipeline asset-upload step is parallel too: `Feed.fetchURL` defers self-hosting to `fetchRun.uploadAssets`, which fans out marker-bearing items over a per-feed `errgroup` while each goroutine acquires `fetchRun.assetSem` — the **run-global** asset pool sized by `SRR_ASSET_WORKERS`/`--asset-workers` (default nproc, independent of `--workers`), so total concurrent peek/transcode/upload jobs across all feeds is capped regardless of how assets distribute across feeds. Marker-less items (`mod.HasAssetMarkers` is false) skip the fan-out; a nil/zero-cap semaphore runs serially.
```

And in the "Per-asset pre-upload processing (`SRR_ASSET_PROCESS` …)" paragraph of the "Asset self-hosting" subsection, add:

```markdown
Asset jobs run concurrently across a feed's items, bounded globally by `SRR_ASSET_WORKERS` (`fetchRun.assetSem`); a same-feed marker referenced by two items may, under concurrency, transcode twice (the store-existence check + `AtomicPut` still dedup the upload — correct, just redundant CPU; accepted over a `singleflight`).
```

- [ ] **Step 2: Document the env var in root `CLAUDE.md`**

In the root `CLAUDE.md`, this repo is the home-server doc — the SRR-specific flag does not belong there. Skip root `CLAUDE.md` unless it already enumerates `SRR_` asset vars (it does not). No change.

- [ ] **Step 3: Commit**

```bash
git add backend/CLAUDE.md
git commit -m "docs(assets): document SRR_ASSET_WORKERS and parallel upload step"
```

---

## Task 6: Full verification

- [ ] **Step 1: Run the backend verify pipeline**

Run: `make verify-be`
Expected: PASS — vet + gofmt check + build + tests + generate-check all green. (`format.gen.ts` is unaffected: `AssetWorkers` is a flag, not a format atom, so `generate-check` stays clean.)

- [ ] **Step 2: Targeted race run of the asset tests**

Run: `cd backend && go test . -run 'TestUploadAssets|TestUploadCacheRef' -race -count=1`
Expected: PASS, no data race.

- [ ] **Step 3: Final commit (if any formatting changed)**

```bash
git add -A && git commit -m "chore(assets): gofmt after parallel asset processing" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** flag (Task 2) ✓; global semaphore + fan-out (Task 4) ✓; `processItem` stays serial (Task 3 leaves it untouched) ✓; gating via `HasAssetMarkers` (Task 1) ✓; nil-safe serial fallback (Task 3/4) ✓; concurrency-bound + correctness + feed-fail tests (Task 4) ✓; docs (Task 5) ✓; accepted duplicate-transcode trade-off documented (Task 5) ✓.
- **Type consistency:** `uploadAssets(ctx, items)` and `rewriteItemAssets(ctx, i)` signatures match across Tasks 3-4; `fetchRun.assetSem chan struct{}` defined in Task 4, set in `cmd_fetch.go` same task; `mod.HasAssetMarkers(string) bool` used in Task 1 and Task 3/4.
- **No placeholders:** every code/test block is complete and runnable.
