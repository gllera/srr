# Per-Feed Article Expiration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-feed `expire-days` retention: each fetch cycle logically deletes articles older than N days (bumps `add_idx`, accumulates a new `xp` counter) and physically deletes their `assets/…` objects; the reader corrects its header-shortcut counts by `xp` and stops returning expired search hits.

**Architecture:** A new `DB.ExpireArticles` step in the fetch cycle (after `SyncOutFeeds`, before `Commit`, warn-only, abort-all on any failure so retries are idempotent). Two new `Feed` fields (`exp`, `xp`) ride db.gz and the generated TS wire types. Frontend changes are surgical: one subtraction in `idx.ts countLeft`'s header shortcut, one skip in `search.ts` shard matching, one live count in `config.ts`.

**Tech Stack:** Go (backend, `golang.org/x/net/html` already vendored), TypeScript + vitest (frontend), the existing e2e contract harness (real `srrb` binary + jsdom reader).

**Spec:** `docs/superpowers/specs/2026-07-03-article-expiration-design.md`

---

## Pre-flight (STOP — coordinate first)

The working tree has **pre-existing uncommitted changes** in files this plan also touches: `backend/CLAUDE.md`, `backend/cmd_fetch.go`, `backend/serve_fetch.go`, `backend/serve_fetch_test.go`, `backend/serve_overview.go`, `backend/serve_overview_test.go`, `backend/webui/app.css`, `backend/webui/app.js`. **Ask the user to commit (or stash) that in-flight work before executing this plan** — otherwise the scoped `git add` in Tasks 4, 6, and 10 would sweep unrelated changes into this feature's commits. Do not proceed past this point without a clean status for those files.

Also per repo memory: never pull/rebase local `main`; commit directly on `main` (house style — recent features are direct commits).

## File Structure

| File | Change |
|---|---|
| `backend/feed.go` | Add `ExpireDays`/`Expired` fields to `Feed` |
| `backend/cmd_feeds.go` | `feedView.expire_days`/read-only `expired`; `-e/--expire-days` on add/upd; negative-value validation in `normalizeFeed` |
| `backend/db_out.go` | Factor `parseBodyFragment` + `visitAssetAttrs` out of `rewriteAssetURLs` |
| `backend/db_expire.go` (new) | `ExpireArticles` + `collectAssetRefs` |
| `backend/db_expire_test.go` (new) | Unit tests for both |
| `backend/cmd_fetch.go` | Call `ExpireArticles` before `Commit` (warn-only) |
| `backend/fetch_loop_test.go` | Cycle-integration test |
| `backend/cmd_inspect_check.go` | Replace `first < add_idx` issue with range sanity checks; `feedIDStats` drops `first` |
| `backend/cmd_inspect_report.go` | `filterReport`/`listTagsReport` use live counts (`TotalArt − Expired`) |
| `backend/serve_feeds.go` | `feedListView` gains `expire_days`/`expired` |
| `backend/serve_overview.go` | Tag buckets sum live counts |
| `backend/webui/app.js` | "Expire after days" field in the feed modal |
| `frontend/src/js/format.gen.ts` | Regenerated (`make generate`) |
| `frontend/src/js/idx.ts` | `countLeft` optional `expired` param + subtraction |
| `frontend/src/js/data.ts` | Build `expiredCounts` lookup in `init`, thread to both `countLeft` call sites |
| `frontend/src/js/search.ts` | Skip hits with `chron < add_idx` |
| `frontend/src/js/config.ts` | Info dialog "Articles" = live count |
| `backend/gen_expire_test.go` (new) | Gated e2e fixture-store generator |
| `frontend/e2e/contract/expire.e2e.test.ts` (new) | End-to-end contract test |
| `CLAUDE.md`, `backend/CLAUDE.md`, `frontend/CLAUDE.md` | Docs |

All backend test commands run from `backend/`: `go test -run <Name> .` — or `make test-be` for the full suite. Frontend from `frontend/`: `npx vitest run src/js/<file>` — or `make test-fe`.

---

### Task 1: Feed fields + CLI + wire types

**Files:**
- Modify: `backend/feed.go` (Feed struct, after `NoTitle`)
- Modify: `backend/cmd_feeds.go` (`feedView`, `viewOf`, `writeFeedView`, `normalizeFeed`, `AddCmd`, `UpdCmd`)
- Modify: `frontend/src/js/format.gen.ts` (via `make generate` — never by hand)
- Test: `backend/cmd_feeds_test.go`

- [ ] **Step 1: Write the failing tests** (append to `backend/cmd_feeds_test.go`)

```go
func TestFeedExpireDaysApplyRoundTrip(t *testing.T) {
	db, _, _ := setupTestDB(t)
	views := []*feedView{{Title: "A", URL: "https://example.com/f.xml", ExpireDays: 30}}
	if err := applyViews(ctx, db, views); err != nil {
		t.Fatalf("applyViews: %v", err)
	}
	ch := db.core.Feeds[0]
	if ch.ExpireDays != 30 {
		t.Fatalf("ExpireDays = %d, want 30", ch.ExpireDays)
	}
	if v := viewOf(ch); v.ExpireDays != 30 {
		t.Fatalf("viewOf ExpireDays = %d, want 30", v.ExpireDays)
	}
}

func TestWriteFeedViewIgnoresExpired(t *testing.T) {
	// Expired is server-owned read-only state (like Error): an apply/edit
	// round-trip must never zero or overwrite the counter.
	ch := &Feed{Expired: 7}
	writeFeedView(ch, &feedView{Title: "A", URL: "https://example.com/f.xml", ExpireDays: 3, Expired: 99})
	if ch.Expired != 7 {
		t.Fatalf("Expired = %d, want 7 (read-only)", ch.Expired)
	}
	if ch.ExpireDays != 3 {
		t.Fatalf("ExpireDays = %d, want 3", ch.ExpireDays)
	}
}

func TestNormalizeFeedRejectsNegativeExpireDays(t *testing.T) {
	err := normalizeFeed(&Feed{Title: "A", URL: "https://example.com/f.xml", ExpireDays: -1}, map[string]Recipe{})
	if err == nil {
		t.Fatal("want error for negative expire days")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test -run 'TestFeedExpireDaysApplyRoundTrip|TestWriteFeedViewIgnoresExpired|TestNormalizeFeedRejectsNegativeExpireDays' .`
Expected: compile FAIL (`unknown field ExpireDays`).

- [ ] **Step 3: Implement.** In `backend/feed.go`, after the `NoTitle` field:

```go
	// ExpireDays is the per-feed retention window in days: each fetch cycle
	// expires this feed's articles fetched more than ExpireDays·24h ago —
	// their assets/ objects are deleted and AddIdx is bumped past them (see
	// db_expire.go). 0 = keep forever (the default).
	ExpireDays int `json:"exp,omitempty"`
	// Expired is the cumulative count of this feed's expired idx entries (the
	// entries in [incarnation start, AddIdx)). Finalized idx headers are
	// immutable all-time cumulative counts (writeIdxHeader sources them from
	// TotalArt), so readers subtract Expired to count only visible articles.
	// Starts at 0 on AddFeed (id reuse included); never decreases otherwise.
	Expired int `json:"xp,omitempty"`
```

In `backend/cmd_feeds.go`:
- `normalizeFeed`: add before the recipe check:
```go
	if ch.ExpireDays < 0 {
		return fmt.Errorf("expire days must be >= 0 (got %d)", ch.ExpireDays)
	}
```
- `feedView`: add after `NoTitle`:
```go
	ExpireDays int `json:"expire_days,omitempty" yaml:"expire_days,omitempty"`
	// Expired is read-only (server-owned, like Error): reported by ls/show/
	// edit, never applied back by writeFeedView.
	Expired int `json:"expired,omitempty" yaml:"expired,omitempty"`
```
- `viewOf`: add `ExpireDays: ch.ExpireDays,` and `Expired: ch.Expired,`.
- `writeFeedView`: add `ch.ExpireDays = v.ExpireDays` (do **NOT** copy `v.Expired`).
- `AddCmd`: add field `Expire *int \`short:"e" name:"expire-days" optional:"" help:"Expire articles after N days (0 = keep forever)."\`` and in `Run()` next to the Tag/Recipe copies: `if o.Expire != nil { v.ExpireDays = *o.Expire }`.
- `UpdCmd`: same field; extend the guard to `if o.Title == nil && o.Tag == nil && o.Recipe == nil && o.URL == nil && o.Expire == nil` and set `if o.Expire != nil { ch.ExpireDays = *o.Expire }` before `normalizeFeed`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test -run 'TestFeedExpire|TestWriteFeedView|TestNormalizeFeed' . && go test .`
Expected: PASS (full package too — `feed apply`/`edit` tests must stay green).

- [ ] **Step 5: Regenerate the TS contract**

Run: `cd /home/gllera/ws/srr && make generate && git diff --stat frontend/src/js/format.gen.ts`
Expected: `IFeedWire` gains `exp?: number // ExpireDays` and `xp?: number // Expired`. Then `make generate-check` passes.

- [ ] **Step 6: Commit**

```bash
git add backend/feed.go backend/cmd_feeds.go backend/cmd_feeds_test.go frontend/src/js/format.gen.ts
git commit -m "feat(backend): per-feed expire-days + expired counter fields"
```

---

### Task 2: Factor the asset-attr walk in db_out.go

**Files:**
- Modify: `backend/db_out.go:363-425` (`rewriteAssetURLs`)
- Test: existing `backend/db_out_test.go` (behavior unchanged — refactor only)

- [ ] **Step 1: Refactor.** In `backend/db_out.go`, above `rewriteAssetURLs`, add:

```go
// parseBodyFragment parses content as an HTML body fragment. Callers treat a
// parse failure as "leave the content alone" — published content is immutable.
func parseBodyFragment(content string) ([]*html.Node, error) {
	return html.ParseFragment(strings.NewReader(content), &html.Node{
		Type:     html.ElementNode,
		Data:     "body",
		DataAtom: atom.Body,
	})
}

// visitAssetAttrs calls fn on each attribute in the outAssetAttrs
// element/attribute set, depth-first across nodes. Shared by rewriteAssetURLs
// (CDN-prefixing) and collectAssetRefs (expiration harvesting) so the two
// can't drift on which attributes carry asset keys.
func visitAssetAttrs(nodes []*html.Node, fn func(a *html.Attribute)) {
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if attrs, ok := outAssetAttrs[n.Data]; ok {
				for _, name := range attrs {
					for i := range n.Attr {
						if n.Attr[i].Key == name {
							fn(&n.Attr[i])
						}
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	for _, n := range nodes {
		walk(n)
	}
}
```

Rewrite `rewriteAssetURLs`'s body to use them (identical behavior):

```go
func rewriteAssetURLs(content, cdn string) (string, error) {
	if content == "" {
		return content, nil
	}
	// Fast path: no relative asset refs. We check for common relative prefixes.
	if !strings.Contains(content, "assets/") {
		return content, nil
	}
	nodes, err := parseBodyFragment(content)
	if err != nil {
		// Unparseable: leave untouched.
		return content, nil
	}
	changed := false
	visitAssetAttrs(nodes, func(a *html.Attribute) {
		// Only CDN-prefix self-hosted asset keys (flat
		// assets/<hex>/<hex>.ext) — never arbitrary relative URLs, or a
		// real relative <a href> would be repointed to the CDN host.
		if strings.HasPrefix(a.Val, "assets/") {
			a.Val = joinURL(cdn, a.Val)
			changed = true
		}
	})
	if !changed {
		return content, nil
	}
	var b strings.Builder
	for _, n := range nodes {
		if err := html.Render(&b, n); err != nil {
			return "", fmt.Errorf("render: %w", err)
		}
	}
	return b.String(), nil
}
```

- [ ] **Step 2: Run the existing out-feed tests (refactor gate)**

Run: `cd backend && go test -run TestSyncOutFeeds . && go test .`
Expected: PASS, no behavior change.

- [ ] **Step 3: Commit**

```bash
git add backend/db_out.go
git commit -m "refactor(backend): factor asset-attr walk out of rewriteAssetURLs"
```

---

### Task 3: `ExpireArticles` core (db_expire.go)

**Files:**
- Create: `backend/db_expire.go`
- Create: `backend/db_expire_test.go`

- [ ] **Step 1: Write the failing tests.** Create `backend/db_expire_test.go`:

```go
package main

import (
	"os"
	"path/filepath"
	"testing"
)

const (
	expNow  int64 = 1_700_000_000
	old20d        = expNow - 20*86400 // older than a 10-day window
	fresh1d       = expNow - 1*86400  // inside any window
)

// putExpireBatch writes one batch through the production path with a chosen
// fetched_at (the same db.core.FetchedAt mechanism one fetch cycle uses).
func putExpireBatch(t *testing.T, db *DB, fetchedAt int64, items []*Item) {
	t.Helper()
	db.core.FetchedAt = fetchedAt
	if _, err := db.PutArticles(ctx, items); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
}

func mustWriteAsset(t *testing.T, dir, key string) string {
	t.Helper()
	p := filepath.Join(dir, key)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("asset-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func assetGone(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(path)
	return os.IsNotExist(err)
}

func TestExpireNoConfiguredFeedsIsNoop(t *testing.T) {
	db, core, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, old20d, []*Item{{Feed: ch, Title: "old"}})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if ch.AddIdx != 0 || ch.Expired != 0 || core.TotalArticles != 1 {
		t.Fatalf("state changed: AddIdx=%d Expired=%d total=%d", ch.AddIdx, ch.Expired, core.TotalArticles)
	}
}

func TestExpireBumpsAddIdxAndExpired(t *testing.T) {
	db, _, _ := setupTestDB(t)
	fast := &Feed{Title: "fast", URL: "https://a.example/f", ExpireDays: 10}
	slow := &Feed{Title: "slow", URL: "https://b.example/f"}
	for _, f := range []*Feed{fast, slow} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}
	// chron: 0=fast(old) 1=slow(old) 2=fast(old) | 3=fast(fresh)
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: fast, Title: "o1"}, {Feed: slow, Title: "o2"}, {Feed: fast, Title: "o3"},
	})
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: fast, Title: "f1"}})

	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if fast.AddIdx != 3 || fast.Expired != 2 {
		t.Fatalf("fast AddIdx=%d Expired=%d, want 3/2", fast.AddIdx, fast.Expired)
	}
	if slow.AddIdx != 0 || slow.Expired != 0 {
		t.Fatalf("slow AddIdx=%d Expired=%d, want 0/0 (no policy)", slow.AddIdx, slow.Expired)
	}
	// TotalArt is the immutable all-time count (idx headers derive from it).
	if fast.TotalArt != 3 || slow.TotalArt != 1 {
		t.Fatalf("TotalArt fast=%d slow=%d, want 3/1 (all-time)", fast.TotalArt, slow.TotalArt)
	}
}

func TestExpireCutoffBoundaryKeepsExactAge(t *testing.T) {
	db, _, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	// fetched_at == cutoff exactly: NOT expired (strictly-older-than contract).
	putExpireBatch(t, db, expNow-10*86400, []*Item{{Feed: ch, Title: "edge"}})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	if ch.AddIdx != 0 || ch.Expired != 0 {
		t.Fatalf("boundary article expired: AddIdx=%d Expired=%d", ch.AddIdx, ch.Expired)
	}
}

func TestExpireDeletesAssetsSharedOrNot(t *testing.T) {
	db, _, dir := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	kOld1 := "assets/aa/1111111111111111.webp"
	kOld2 := "assets/bb/2222222222222222.webp"
	kFresh := "assets/cc/3333333333333333.webp"
	pOld1, pOld2 := mustWriteAsset(t, dir, kOld1), mustWriteAsset(t, dir, kOld2)
	pFresh := mustWriteAsset(t, dir, kFresh)

	// Two expired articles share kOld1 (dedup: one Rm); the fresh article's
	// own asset must survive.
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: ch, Title: "o1", Content: `<img src="` + kOld1 + `"><a href="` + kOld2 + `">d</a>`},
		{Feed: ch, Title: "o2", Content: `<video src="` + kOld1 + `" poster="http://x.example/p.jpg"></video>`},
	})
	putExpireBatch(t, db, fresh1d, []*Item{
		{Feed: ch, Title: "f1", Content: `<img src="` + kFresh + `">`},
	})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if !assetGone(t, pOld1) || !assetGone(t, pOld2) {
		t.Fatal("expired assets not deleted")
	}
	if assetGone(t, pFresh) {
		t.Fatal("fresh asset deleted")
	}
}

func TestExpireRmFailureAbortsAll(t *testing.T) {
	db, _, dir := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	key := "assets/aa/1111111111111111.webp"
	// A non-empty DIRECTORY at the key path makes local Rm (os.Remove) fail.
	if err := os.MkdirAll(filepath.Join(dir, key, "block"), 0o755); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: ch, Title: "o1", Content: `<img src="` + key + `">`},
	})
	if err := db.ExpireArticles(ctx, expNow); err == nil {
		t.Fatal("want error from failing Rm")
	}
	if ch.AddIdx != 0 || ch.Expired != 0 {
		t.Fatalf("state applied despite Rm failure: AddIdx=%d Expired=%d", ch.AddIdx, ch.Expired)
	}
}

func TestExpireSecondRunIsNoop(t *testing.T) {
	db, _, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, old20d, []*Item{{Feed: ch, Title: "o1"}})
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: ch, Title: "f1"}})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	if ch.AddIdx != 1 || ch.Expired != 1 {
		t.Fatalf("second run changed state: AddIdx=%d Expired=%d, want 1/1", ch.AddIdx, ch.Expired)
	}
}

func TestExpirePerFeedCutoffs(t *testing.T) {
	db, _, _ := setupTestDB(t)
	// Different windows: a 20-day-old article expires only for the 10-day feed.
	short := &Feed{Title: "short", URL: "https://a.example/f", ExpireDays: 10}
	long := &Feed{Title: "long", URL: "https://b.example/f", ExpireDays: 30}
	for _, f := range []*Feed{short, long} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: short, Title: "s"}, {Feed: long, Title: "l"},
	})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	if short.AddIdx != 1 || short.Expired != 1 {
		t.Fatalf("short AddIdx=%d Expired=%d, want 1/1", short.AddIdx, short.Expired)
	}
	if long.AddIdx != 0 || long.Expired != 0 {
		t.Fatalf("long AddIdx=%d Expired=%d, want 0/0", long.AddIdx, long.Expired)
	}
}

func TestCollectAssetRefs(t *testing.T) {
	keys := map[string]struct{}{}
	content := `<img src="assets/aa/1111111111111111.webp">` +
		`<video src="assets/bb/2222222222222222.webm" poster="assets/cc/3333333333333333.webp"></video>` +
		`<audio src="assets/dd/4444444444444444.opus"></audio>` +
		`<a href="assets/ee/5555555555555555.pdf">doc</a>` +
		`<img src="https://x.example/ext.jpg"><a href="relative/path.html">r</a>`
	collectAssetRefs(content, keys)
	want := []string{
		"assets/aa/1111111111111111.webp",
		"assets/bb/2222222222222222.webm",
		"assets/cc/3333333333333333.webp",
		"assets/dd/4444444444444444.opus",
		"assets/ee/5555555555555555.pdf",
	}
	if len(keys) != len(want) {
		t.Fatalf("collected %d keys, want %d: %v", len(keys), len(want), keys)
	}
	for _, k := range want {
		if _, ok := keys[k]; !ok {
			t.Fatalf("missing key %s", k)
		}
	}
	// Fast path + empty content contribute nothing and never error.
	collectAssetRefs("", keys)
	collectAssetRefs("<p>no asset refs at all</p>", keys)
	if len(keys) != len(want) {
		t.Fatalf("no-ref content added keys: %v", keys)
	}
}
```


- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test -run 'TestExpire|TestCollectAssetRefs' .`
Expected: compile FAIL (`undefined: ExpireArticles` / `collectAssetRefs`).

- [ ] **Step 3: Implement.** Create `backend/db_expire.go`:

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"golang.org/x/net/html"
)

// errExpireDone stops the expiration walk at the first article young enough
// to keep: fetched_at is globally monotone in chron order (each batch is
// stamped with its cycle timestamp), so nothing past it can be expired. A
// third package sentinel beside errNotFeed/errNotAsset — walkArticles'
// callback contract has no other early-stop channel.
var errExpireDone = errors.New("expire walk done")

// ExpireArticles applies each feed's ExpireDays retention policy: articles
// of that feed fetched more than ExpireDays·24h before now are expired —
// every assets/ key their content references is deleted from the store and
// the feed's AddIdx is bumped past them (logical deletion; packs are
// immutable). Feed.Expired accumulates the expired entry count so readers
// can correct the immutable idx-header cumulative counts (visible-before-P
// == header count − Expired for packs past AddIdx — see the data contract).
//
// All-or-nothing: any walk or delete failure returns before ANY AddIdx/
// Expired change is applied, so the next cycle recomputes the same window
// and retries idempotently (Rm is silent on missing). NOTE (accepted design
// trade-off): there is no liveness check — an asset shared with a still-live
// article is deleted too; the reader collapses the broken media and
// `srr asset heal --create` is the repair path.
func (o *DB) ExpireArticles(ctx context.Context, now int64) error {
	c := &o.core
	cutoffs := map[int]int64{} // feed id → fetched_at cutoff (exclusive)
	minStart := c.TotalArticles
	var maxCutoff int64
	for id, ch := range c.Feeds {
		if ch.ExpireDays <= 0 {
			continue
		}
		cutoffs[id] = now - int64(ch.ExpireDays)*86400
		minStart = min(minStart, ch.AddIdx)
		maxCutoff = max(maxCutoff, cutoffs[id])
	}
	if len(cutoffs) == 0 || minStart >= c.TotalArticles {
		return nil
	}

	newAddIdx := map[int]int{}
	newlyExpired := map[int]int{}
	assetKeys := map[string]struct{}{}
	cur := minStart
	err := o.walkArticles(ctx, minStart, c.TotalArticles, func(ad *ArticleData) error {
		chron := cur
		cur++
		if ad.FetchedAt >= maxCutoff {
			return errExpireDone
		}
		cutoff, ok := cutoffs[ad.FeedID]
		if !ok || chron < c.Feeds[ad.FeedID].AddIdx || ad.FetchedAt >= cutoff {
			return nil
		}
		newAddIdx[ad.FeedID] = chron + 1
		newlyExpired[ad.FeedID]++
		collectAssetRefs(ad.Content, assetKeys)
		return nil
	})
	if err != nil && !errors.Is(err, errExpireDone) {
		return fmt.Errorf("expire walk: %w", err)
	}
	if len(newAddIdx) == 0 {
		return nil
	}

	for key := range assetKeys {
		if err := o.Rm(ctx, key); err != nil {
			return fmt.Errorf("delete %s: %w", key, err)
		}
	}

	expired := 0
	for id, idx := range newAddIdx {
		ch := c.Feeds[id]
		ch.AddIdx = idx
		ch.Expired += newlyExpired[id]
		expired += newlyExpired[id]
	}
	slog.Info("expired articles", "articles", expired, "assets", len(assetKeys), "feeds", len(newAddIdx))
	return nil
}

// collectAssetRefs adds every self-hosted asset key (assets/…) referenced by
// content's media/link attributes (the outAssetAttrs set, via the shared
// visitAssetAttrs walk) to keys. Same fast path as rewriteAssetURLs;
// unparseable HTML contributes nothing — the content already published
// as-is, and an error here would wedge retention forever.
func collectAssetRefs(content string, keys map[string]struct{}) {
	if content == "" || !strings.Contains(content, "assets/") {
		return
	}
	nodes, err := parseBodyFragment(content)
	if err != nil {
		return
	}
	visitAssetAttrs(nodes, func(a *html.Attribute) {
		if strings.HasPrefix(a.Val, "assets/") {
			keys[a.Val] = struct{}{}
		}
	})
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && gofmt -w . && go test -run 'TestExpire|TestCollectAssetRefs' . && go test .`
Expected: PASS. (If `TestExpireRmFailureAbortsAll` fails because local `Rm` maps the non-empty-dir error to nil, check `store/local.go rmErr` — only missing-file maps to nil; adapt the failure injection if needed, e.g. `os.Chmod` the parent dir to 0o500 with a cleanup restore.)

- [ ] **Step 5: Commit**

```bash
git add backend/db_expire.go backend/db_expire_test.go
git commit -m "feat(backend): ExpireArticles — per-feed retention with asset deletion"
```

---

### Task 4: Fetch-cycle wiring

**Files:**
- Modify: `backend/cmd_fetch.go` (between the `SyncOutFeeds` block and `db.Commit`, ~line 305)
- Test: `backend/fetch_loop_test.go`

- [ ] **Step 1: Write the failing test** (append to `backend/fetch_loop_test.go`; helpers `seedFeed` in `cmd_serve_test.go`, `rssServer` in `serve_fetch_test.go`, `allowLoopback` nearby — all same package)

```go
// TestFetchCycleExpiresArticles verifies the cycle wiring: a feed with
// expire-days set sheds its over-age backlog (AddIdx/Expired bumped, asset
// deleted) during a normal fetch cycle, before Commit publishes it.
func TestFetchCycleExpiresArticles(t *testing.T) {
	db, _, dir := setupTestDB(t)
	allowLoopback(t)
	ch := &Feed{Title: "Old", URL: rssServer(t), ExpireDays: 30}
	seedFeed(t, db, ch)

	key := "assets/aa/00112233445566aa.webp"
	p := mustWriteAsset(t, dir, key)
	db.core.FetchedAt = time.Now().Unix() - 40*86400
	if _, err := db.PutArticles(ctx, []*Item{{Feed: ch, Title: "stale", Content: `<img src="` + key + `">`}}); err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := (&FetchCmd{}).fetchLoop(ctx, newFetchClient(1)); err != nil {
		t.Fatalf("fetchLoop: %v", err)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		got := d.core.Feeds[0]
		if got.AddIdx != 1 || got.Expired != 1 {
			t.Fatalf("AddIdx=%d Expired=%d, want 1/1", got.AddIdx, got.Expired)
		}
		return nil
	})
	if !assetGone(t, p) {
		t.Fatalf("asset %s not deleted by the cycle", key)
	}
}
```

(Add `"time"` to the file's imports if absent.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test -run TestFetchCycleExpiresArticles .`
Expected: FAIL — `AddIdx=0 Expired=0, want 1/1` (no wiring yet).

- [ ] **Step 3: Implement.** In `backend/cmd_fetch.go`, immediately after the `SyncOutFeeds` block (`o.lastOutSig = sig` / its closing brace) and before `if err := db.Commit(ctx)`:

```go
		// Warn-only: retention is maintenance — a failed walk or asset delete
		// must not block committing the durable article batch. ExpireArticles
		// applies nothing on failure, so the next cycle recomputes the same
		// window and retries idempotently (Rm is silent on missing). The
		// AddIdx/Expired bumps it does apply ride this cycle's Commit.
		if err := db.ExpireArticles(ctx, db.core.FetchedAt); err != nil {
			slog.Warn("expire articles", "error", err)
		}
```

(`db.core.FetchedAt` is the cycle's start timestamp — the same value `run.fetchedAt` snapshots.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test -run 'TestFetchCycle|TestFetchLoop' . && go test .`
Expected: PASS.

- [ ] **Step 5: Commit** (pre-flight guaranteed `cmd_fetch.go` was clean of unrelated changes)

```bash
git add backend/cmd_fetch.go backend/fetch_loop_test.go
git commit -m "feat(backend): run article expiration in every fetch cycle"
```

---

### Task 5: Inspect validator + report math

**Files:**
- Modify: `backend/cmd_inspect_check.go` (`feedIDStats` ~line 85, `checkDBMeta` ~line 130-151)
- Modify: `backend/cmd_inspect_report.go` (`filterReport` ~lines 75-121, `listTagsReport` ~line 126+)
- Test: `backend/cmd_inspect_check_test.go`

- [ ] **Step 1: Write the failing test** (append to `backend/cmd_inspect_check_test.go`; the fetcher is the same closure `InspectCmd.openFetcher` builds — `db.readGz` over the open test DB — and packs load through the shared `idx_read.go` reader)

```go
// TestDBMetaCleanAfterExpiration: a store whose feed has expired a prefix
// (AddIdx mid-history, Expired > 0) must validate clean — entries before
// AddIdx are expected there, and total_art stays the all-time idx count.
func TestDBMetaCleanAfterExpiration(t *testing.T) {
	db, core, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, old20d, []*Item{{Feed: ch, Title: "o1"}, {Feed: ch, Title: "o2"}})
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: ch, Title: "f1"}})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatal(err)
	}
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	if issues := checkDBMeta(fetch, core, packs); issues != 0 {
		t.Fatalf("checkDBMeta reported %d issues on an expired store", issues)
	}
}

// TestDBMetaFlagsOutOfRangeExpired: xp outside [0, total_art] is corruption.
func TestDBMetaFlagsOutOfRangeExpired(t *testing.T) {
	db, core, _ := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: ch, Title: "f1"}})
	ch.Expired = 5 // > TotalArt(1)
	fetch := func(key string) ([]byte, error) { return db.readGz(ctx, key) }
	packs, err := loadIdxPacks(fetch, core)
	if err != nil {
		t.Fatalf("loadIdxPacks: %v", err)
	}
	if issues := checkDBMeta(fetch, core, packs); issues == 0 {
		t.Fatal("checkDBMeta missed out-of-range Expired")
	}
}
```

(`putExpireBatch`/`old20d`/`fresh1d`/`expNow` come from Task 3's `db_expire_test.go` — same package.)

- [ ] **Step 2: Run to verify state** — the first test FAILS today (the `first < AddIdx` check fires), the second FAILS to compile or misses. Run: `cd backend && go test -run TestDBMeta .`

- [ ] **Step 3: Implement.** In `backend/cmd_inspect_check.go`:
- `feedIDStats`: drop the `first` map (return only `count map[int]int`; delete its tracking loop lines).
- In `checkDBMeta`, replace

```go
		if first, ok := idxFirst[id]; ok && first < sub.AddIdx {
			fmt.Printf("[db-meta] sub %d (%q): add_idx=%d but first idx occurrence at chron %d\n",
				id, sub.Title, sub.AddIdx, first)
			issues++
		}
```

with

```go
		// Entries before add_idx are expected (expiration, feed-id reuse);
		// add_idx and the expired counter just have to stay in range.
		if sub.AddIdx < 0 || sub.AddIdx > core.TotalArticles {
			fmt.Printf("[db-meta] sub %d (%q): add_idx=%d out of range [0, %d]\n",
				id, sub.Title, sub.AddIdx, core.TotalArticles)
			issues++
		}
		if sub.Expired < 0 || sub.Expired > sub.TotalArt {
			fmt.Printf("[db-meta] sub %d (%q): expired=%d out of range [0, total_art=%d]\n",
				id, sub.Title, sub.Expired, sub.TotalArt)
			issues++
		}
```

and update the `feedIDStats` call site (`idxCount, idxFirst := feedIDStats(packs)` → `idxCount := feedIDStats(packs)`).

In `backend/cmd_inspect_report.go`:
- `filterReport`: `feedTotal += core.Feeds[id].TotalArt` → `feedTotal += core.Feeds[id].TotalArt - core.Feeds[id].Expired`; extend the per-feed print to `... total_art=%d add_idx=%d expired=%d\n` with `ch.Expired`; update the label to `filter.feedTotal (sum of feed.total_art - expired)`.
- `listTagsReport`: both `articles += ch.TotalArt` sites → `articles += ch.TotalArt - ch.Expired` (untagged and tagged branches).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test -run 'TestDBMeta|TestFeedCounts' . && go test .`
Expected: PASS (including the pre-existing inspect tests).

- [ ] **Step 5: Commit**

```bash
git add backend/cmd_inspect_check.go backend/cmd_inspect_check_test.go backend/cmd_inspect_report.go
git commit -m "feat(backend): inspect understands expiration (range checks, live filter counts)"
```

---

### Task 6: Serve API + webui

**Files:**
- Modify: `backend/serve_feeds.go` (`feedListView` + `listViewOf`)
- Modify: `backend/serve_overview.go:50` (tag buckets)
- Modify: `backend/webui/app.js` (`openFeedModal`, ~line 498)
- Test: `backend/serve_feeds_test.go`

- [ ] **Step 1: Write the failing test** (append to `backend/serve_feeds_test.go`; `doReq`/`newMux`/`stubPassthroughResolve`/`seedFeed` are the file's existing helpers)

```go
func TestServeFeedExpireDaysRoundTrip(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubPassthroughResolve()
	seedFeed(t, db, &Feed{Title: "Old", URL: "https://u.example/feed", Expired: 7})

	// expire_days is writable; expired is server-owned (like error) — a
	// client echoing it back must not overwrite the counter.
	body := `{"title":"Old","url":"https://u.example/feed","expire_days":30,"expired":99}`
	rec := doReq(t, newMux(), "PUT", "/api/feeds/0", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var got feedListView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ExpireDays != 30 || got.Expired != 7 {
		t.Fatalf("echo expire_days=%d expired=%d, want 30/7", got.ExpireDays, got.Expired)
	}
	err := withDB(false, func(_ context.Context, d *DB) error {
		ch, e := d.FeedByID(0)
		if e != nil {
			return e
		}
		if ch.ExpireDays != 30 || ch.Expired != 7 {
			t.Fatalf("stored ExpireDays=%d Expired=%d, want 30/7", ch.ExpireDays, ch.Expired)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestOverviewTagCountsAreLive(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "A", URL: "https://a.example/f", Tag: "news", TotalArt: 10, Expired: 4})

	rec := doReq(t, newMux(), "GET", "/api/overview", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var ov overviewView
	if err := json.Unmarshal(rec.Body.Bytes(), &ov); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(ov.Tags) != 1 || ov.Tags[0].Articles != 6 {
		t.Fatalf("tags = %+v, want one bucket with 6 live articles", ov.Tags)
	}
}
```

(If `tagCount`'s article field name differs from `Articles`, mirror the real struct in `serve_overview.go`/`serve_feeds.go`.)

- [ ] **Step 2: Run to verify it fails** — `cd backend && go test -run TestServeFeedExpire .` → FAIL (field dropped).

- [ ] **Step 3: Implement.**
- `serve_feeds.go` `feedListView`: add after `TotalArt`:
```go
	ExpireDays int `json:"expire_days,omitempty"`
	Expired    int `json:"expired,omitempty"`
```
  and in `listViewOf`: `ExpireDays: ch.ExpireDays, Expired: ch.Expired,`.
- `serve_overview.go`: `tc.Articles += ch.TotalArt` → `tc.Articles += ch.TotalArt - ch.Expired` (live counts — the overview is a display projection).
- `webui/app.js` `openFeedModal`:
```js
  const v = f || { title: "", url: "", tag: "", recipe: "", no_title: false, expire_days: 0 };
  // … after the noTitle input:
  const expire = el("input", { id: "f_expire", type: "number", min: "0", step: "1",
    value: v.expire_days ? String(v.expire_days) : "" });
```
  add to the save body: `expire_days: Math.max(0, Math.floor(Number(expire.value) || 0)),`
  and to the dialog children, after the recipe row:
```js
    el("label", {}, "Expire after days (0 = keep forever)"), expire,
```

- [ ] **Step 4: Run tests** — `cd backend && go test . && go vet ./...` → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/serve_feeds.go backend/serve_overview.go backend/webui/app.js backend/serve_feeds_test.go
git commit -m "feat(backend): expire-days in serve API + webui feed editor, live tag counts"
```
(Adjust the test filename in `git add` to wherever Step 1 landed.)

---

### Task 7: Frontend counting correction

**Files:**
- Modify: `frontend/src/js/idx.ts` (`IdxPack.countLeft` interface + implementation, ~line 178)
- Modify: `frontend/src/js/data.ts` (`init` ~line 79, `countAll` ~line 193, `countLeft` ~line 198)
- Test: `frontend/src/js/idx.test.ts`

- [ ] **Step 1: Write the failing tests** (append inside `describe("makeIdxPack.countLeft")` in `idx.test.ts`)

```ts
   it("subtracts per-feed expired from the header shortcut", () => {
      const buf = buildBuf({ feedCounts: { 1: 200 }, entries: [e(1)] })
      const pack = makeIdxPack(buf, 1, 1, SLOTS)
      const feeds = new Map([[1, 0]])
      const xp = new Uint32Array(SLOTS)
      xp[1] = 40
      // 200 all-time in earlier packs − 40 expired = 160 visible, +1 own entry
      expect(pack.countLeft(IDX_PACK_SIZE, feeds, lk(feeds), xp)).toBe(160)
      expect(pack.countLeft(IDX_PACK_SIZE + 1, feeds, lk(feeds), xp)).toBe(161)
   })

   it("clamps a corrected prior count at 0", () => {
      const buf = buildBuf({ feedCounts: { 1: 10 }, entries: [e(1)] })
      const pack = makeIdxPack(buf, 1, 1, SLOTS)
      const feeds = new Map([[1, 0]])
      const xp = new Uint32Array(SLOTS)
      xp[1] = 999 // defensive: corrupt xp must not go negative
      expect(pack.countLeft(IDX_PACK_SIZE, feeds, lk(feeds), xp)).toBe(0)
   })

   it("without an expired lookup keeps today's counts", () => {
      const buf = buildBuf({ feedCounts: { 1: 200 }, entries: [e(1)] })
      const pack = makeIdxPack(buf, 1, 1, SLOTS)
      const feeds = new Map([[1, 0]])
      expect(pack.countLeft(IDX_PACK_SIZE, feeds, lk(feeds))).toBe(200)
   })
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/js/idx.test.ts`
Expected: FAIL (extra argument / 200 ≠ 160).

- [ ] **Step 3: Implement.**
- `idx.ts` `IdxPack` interface: `countLeft(chronIdx: number, feeds: Map<number, number>, lookup: Int32Array, expired?: Uint32Array): number`.
- `idx.ts` implementation — replace the header-shortcut loop:

```ts
      countLeft(chronIdx: number, feeds: Map<number, number>, lookup: Int32Array, expired?: Uint32Array): number {
         pack.parse()
         let count = 0
         for (const [feedId, addIdx] of feeds) {
            if (addIdx < baseChron) {
               // Finalized headers are immutable ALL-TIME cumulative counts;
               // expiration moves add_idx mid-history without rewriting them,
               // so subtract the feed's expired total (db.gz xp) to count only
               // visible entries. Clamped: a corrupt xp must not go negative.
               const prior = countAt(pack.header.feedCounts, feedId) - (expired ? countAt(expired, feedId) : 0)
               count += Math.max(0, prior)
            }
         }
```
  (the per-entry scan below is unchanged).
- `data.ts`: module-level `let expiredCounts = new Uint32Array(0)` next to `slots`; in `init()` right after `slots` is computed:

```ts
   // Per-feed expired totals (db.gz xp), threaded into countLeft so the
   // immutable header cumulative counts are corrected to visible articles.
   expiredCounts = new Uint32Array(slots)
   for (const ch of Object.values(db.feeds)) expiredCounts[ch.id] = ch.xp ?? 0
```
  and pass it at both call sites:
```ts
   return latestIdx.countLeft(db.total_art, feeds, makeFeedsLookup(feeds, slots), expiredCounts)
   // …
   return (await fetchIdxPack(n)).countLeft(chronIdx, feeds, makeFeedsLookup(feeds, slots), expiredCounts)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/js/idx.test.ts && npm test`
Expected: PASS (whole unit suite — nav/data mocks are signature-compatible since the param is optional).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/js/idx.ts frontend/src/js/data.ts frontend/src/js/idx.test.ts
git commit -m "feat(frontend): correct header-shortcut counts by per-feed expired (xp)"
```

---

### Task 8: Frontend search filter + live info count

**Files:**
- Modify: `frontend/src/js/search.ts` (`matchShard`, ~line 124)
- Modify: `frontend/src/js/config.ts` (~line 476)
- Test: `frontend/src/js/search.test.ts`, `frontend/src/js/config.test.ts`

- [ ] **Step 1: Write the failing tests.**
In `search.test.ts`, append inside `describe("search")` (its `beforeEach` builds two finalized shards + a latest tail, every entry `f: 1` via `entryBytes`'s default, and reassigns `mockData.db` without a `feeds` key — which is exactly the deleted-feed shape):

```ts
   it("filters hits expired by their feed's add_idx", async () => {
      // Every fixture entry belongs to feed 1. Expiring everything below
      // shard 1 (add_idx = META_PACK_SIZE) must drop shard-0 hits while
      // shard-1 and latest-tail hits survive.
      mockData.db.feeds = { 1: { add_idx: META_PACK_SIZE } }
      const batches = await collect(search.search("alpha"))
      expect(batches.flat().map((h) => h.chron)).toEqual([2 * META_PACK_SIZE, META_PACK_SIZE])
   })

   it("keeps hits whose feed record is gone (deleted-feed tombstone)", async () => {
      // No feeds record at all (the suite default) — deleted-feed hits keep
      // the status quo and still render with the tombstone title.
      const batches = await collect(search.search("alpha"))
      expect(batches.flat()).toHaveLength(3)
   })
```

In `config.test.ts`, append beside the existing "opens a feed detail card" test (same `data.groupFeedsByTag`/`mount` scaffolding):

```ts
   it("shows the live article count (total_art − xp) in the detail card", async () => {
      data.groupFeedsByTag.mockReturnValue({
         tagged: new Map(),
         sortedTags: [],
         untagged: [feed({ id: 5, title: "Feed5", url: "http://example.com/rss", total_art: 10, xp: 4 })],
      })
      nav.unreadCounts.mockResolvedValue(new Map([[5, 0]]))
      const config = await mount()
      config.open()
      $('.srr-config-filter a[data-value="5"] .srr-info-btn').dispatchEvent(
         new MouseEvent("click", { bubbles: true, cancelable: true }),
      )
      // dt "Articles" and dd "6" concatenate in textContent.
      expect($(".srr-info-body").textContent).toContain("Articles6")
   })
```

- [ ] **Step 2: Run to verify they fail** — `cd frontend && npx vitest run src/js/search.test.ts src/js/config.test.ts` → FAIL.

- [ ] **Step 3: Implement.**
- `search.ts` `matchShard` — after `const e = shard.entries[i]`:

```ts
      const ch = data.db.feeds?.[e.f]
      // Expired articles (chron < their feed's add_idx) are logically deleted
      // everywhere else (list/nav/counts); search must not resurrect them.
      // A deleted feed keeps the status quo (tombstone render). The optional
      // chain is load-bearing: search.test.ts's mock db omits `feeds`
      // (production data.init always normalizes it). If ESLint flags the
      // chain as unnecessary, read via a local `const feeds = data.db.feeds as
      // IDB["feeds"] | undefined` instead of weakening the mock.
      if (ch && baseChron + i < ch.add_idx) continue
```
- `config.ts`: `addRow(content.dl, "Articles", String(ch.total_art))` → `addRow(content.dl, "Articles", String(ch.total_art - (ch.xp ?? 0)))`.

- [ ] **Step 4: Run tests** — `cd frontend && npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/js/search.ts frontend/src/js/search.test.ts frontend/src/js/config.ts frontend/src/js/config.test.ts
git commit -m "feat(frontend): search skips expired articles; live count in feed info"
```

---

### Task 9: E2e contract test

**Files:**
- Create: `backend/gen_expire_test.go` (gated fixture generator, `genbig_test.go` precedent)
- Create: `frontend/e2e/contract/expire.e2e.test.ts`

- [ ] **Step 1: Create the generator** — `backend/gen_expire_test.go`:

```go
package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestGenExpireStore is a gated fixture generator (genbig_test.go precedent):
// it writes, through the production write path, a small store whose first
// batch is 40 days old — so a subsequent REAL `srrb art fetch` cycle (real
// wall clock, no time seam in the binary) expires it. Consumed by
// frontend/e2e/contract/expire.e2e.test.ts.
func TestGenExpireStore(t *testing.T) {
	out := os.Getenv("SRR_GENEXPIRE_OUT")
	if out == "" {
		t.Skip("set SRR_GENEXPIRE_OUT=<dir> to generate the expiration e2e fixture store")
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	globals = &Globals{PackSize: 200, Store: out, Workers: 1, MaxFeedSize: defaultMaxFeedSize, CacheDir: t.TempDir()}
	finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
	t.Cleanup(func() { finalGzip = gzipBest })

	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(ctx)

	// Unreachable URLs: the e2e fetch cycle fails both feeds (ferr) but the
	// cycle still runs the expire step and commits — exactly the contract.
	exp := &Feed{Title: "Expiring", URL: "http://127.0.0.1:9/exp.xml", ExpireDays: 30}
	keep := &Feed{Title: "Keeper", URL: "http://127.0.0.1:9/keep.xml"}
	for _, f := range []*Feed{exp, keep} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}

	const assetOld = "assets/aa/1111111111111111.webp"
	const assetKeep = "assets/bb/2222222222222222.webp"
	for _, k := range []string{assetOld, assetKeep} {
		p := filepath.Join(out, k)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("asset-bytes"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now().Unix()
	put := func(fetchedAt int64, items []*Item) {
		db.core.FetchedAt = fetchedAt
		written, err := db.PutArticles(ctx, items)
		if err != nil {
			t.Fatalf("PutArticles: %v", err)
		}
		if err := db.SyncIdxSummary(ctx); err != nil {
			t.Fatalf("SyncIdxSummary: %v", err)
		}
		if err := db.SyncMeta(ctx, written); err != nil {
			t.Fatalf("SyncMeta: %v", err)
		}
		if err := db.Commit(ctx); err != nil {
			t.Fatalf("Commit: %v", err)
		}
	}
	put(now-40*86400, []*Item{
		{Feed: exp, Title: "ancient exquisite zebra", Published: now - 40*86400, Content: `<img src="` + assetOld + `">`},
		{Feed: keep, Title: "keeper ancient story", Published: now - 40*86400 + 1, Content: `<img src="` + assetKeep + `">`},
	})
	put(now-86400, []*Item{
		{Feed: exp, Title: "fresh flamingo news", Published: now - 86400, Content: "<p>fresh</p>"},
	})
}
```

- [ ] **Step 2: Create the e2e test** — `frontend/e2e/contract/expire.e2e.test.ts`. Model imports/setup on `search.e2e.test.ts` (it mounts the reader AND dynamic-imports the fresh `search` module) and `harness.ts` (`srr`, `makeStore`, `inspectValidate`, the `storeTotalArt` gunzip-db.gz pattern; generator spawn per `stressStore`):

```ts
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { gunzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { inspectValidate, makeStore, srr } from "../harness"
import { mountReader, type MountedReader } from "./mount"
import { rmSync } from "node:fs"

const REPO = resolve(__dirname, "../../..")
const ASSET_OLD = "assets/aa/1111111111111111.webp"
const ASSET_KEEP = "assets/bb/2222222222222222.webp"

describe("article expiration (writer↔reader contract)", () => {
   let dir: string
   let mounted: MountedReader

   beforeAll(async () => {
      dir = makeStore()
      execFileSync("go", ["test", "-run", "TestGenExpireStore", "-count=1", "."], {
         cwd: resolve(REPO, "backend"),
         stdio: "inherit",
         env: { ...process.env, SRR_GENEXPIRE_OUT: dir },
      })
      // The REAL fetch cycle: both feeds fail (unreachable), the expire step
      // still runs and commits. Feed "Expiring" (id 0) sheds its 40-day-old
      // article; "Keeper" (id 1) has no policy.
      await srr(dir, "art", "fetch")
      mounted = await mountReader(dir)
   }, 120_000)

   afterAll(() => rmSync(dir, { recursive: true, force: true }))

   it("bumps add_idx and xp in db.gz; total_art untouched", () => {
      const db = JSON.parse(gunzipSync(readFileSync(join(dir, "db.gz"))).toString("utf8"))
      expect(db.feeds[0].add_idx).toBe(1)
      expect(db.feeds[0].xp).toBe(1)
      expect(db.feeds[0].total_art).toBe(2) // all-time, immutable headers
      expect(db.feeds[1].add_idx ?? 0).toBe(0)
      expect(db.total_art).toBe(3)
   })

   it("deletes the expired article's asset, keeps live ones", () => {
      expect(existsSync(join(dir, ASSET_OLD))).toBe(false)
      expect(existsSync(join(dir, ASSET_KEEP))).toBe(true)
   })

   it("reader counts only visible articles for the expiring feed", () => {
      const { data } = mounted
      const feeds = new Map([[0, data.db.feeds[0].add_idx ?? 0]])
      expect(data.countAll(feeds)).toBe(1) // fresh only
   })

   it("expired article stays addressable (immutable packs)", async () => {
      const { data } = mounted
      const art = await data.loadArticle(0)
      expect(art.t).toBe("ancient exquisite zebra")
   })

   it("search skips the expired title but finds live ones", async () => {
      // Import the fresh search module the same way search.e2e.test.ts does
      // (after mountReader's vi.resetModules, so it binds the mounted data).
      const search = await import("../../src/js/search")
      const collect = async (q: string) => {
         const hits = []
         for await (const batch of search.search(q)) hits.push(...batch)
         return hits
      }
      expect(await collect("zebra")).toHaveLength(0) // expired
      expect(await collect("flamingo")).toHaveLength(1) // fresh, same feed
      expect(await collect("keeper")).toHaveLength(1) // other feed, no policy
   })

   it("srr inspect --validate is clean", async () => {
      expect(await inspectValidate(dir)).toContain("OK")
   })
})
```

Verify against `search.e2e.test.ts` how the fresh `search` module import interacts with `mountReader` (import order after `vi.resetModules`) and against `inspect.e2e.test.ts` what exact "OK" string `--validate` prints — adjust the two assertions to match the established patterns.

- [ ] **Step 3: Run**

Run: `cd /home/gllera/ws/srr && make test-contract`
Expected: all contract suites PASS including the new one.

- [ ] **Step 4: Commit**

```bash
git add backend/gen_expire_test.go frontend/e2e/contract/expire.e2e.test.ts
git commit -m "test(e2e): article expiration writer↔reader contract"
```

---

### Task 10: Docs + full verify + format audit

**Files:**
- Modify: `CLAUDE.md` (root — Data Contract), `backend/CLAUDE.md`, `frontend/CLAUDE.md`

- [ ] **Step 1: Docs.**
- Root `CLAUDE.md`, Feeds (`IFeed`) section: add `exp`/`xp` to the field list line and append: `exp` (ExpireDays) is the per-feed retention window in days (0 = keep forever): each fetch cycle expires articles fetched more than that long ago — their `assets/…` objects are deleted (no liveness check by design; content-hash re-upload and `asset heal --create` are the repair paths) and `add_idx` is bumped past them (logical deletion; packs/idx headers are immutable). `xp` (Expired) is the cumulative expired-entry count: finalized idx headers hold all-time cumulative counts, so readers compute visible-before-pack-P as `header count − xp` once `add_idx < P.base`. Per-feed `total_art` stays all-time (it sources the idx headers via `writeIdxHeader`); store-level `total_art` stays the chronIdx addressing atom.
- `backend/CLAUDE.md`: add a `db_expire.go` bullet (ExpireArticles semantics: fetched_at clock, contiguous-prefix invariant, abort-all-on-failure idempotent retry, errExpireDone sentinel, collectAssetRefs sharing visitAssetAttrs with db_out.go); extend the `cmd_fetch.go` cycle order to `… → SyncOutFeeds → ExpireArticles → Commit → GC sweeps`; note the inspect changes (range checks replace the first-occurrence check; filter/tag report live counts) and the `-e/--expire-days` flags + read-only `expired` in feedView/feedListView.
- `frontend/CLAUDE.md`: in the `idx.ts` row note `countLeft`'s optional `expired` lookup (header-shortcut correction, clamped); in `data.ts` the `expiredCounts` build in `init`; in `search.ts` the add_idx hit filter; in `config.ts` the live Articles count.

- [ ] **Step 2: Full verify**

Run: `cd /home/gllera/ws/srr && make verify`
Expected: PASS (lint, format, both test suites, builds, generate-check, contract layer).

- [ ] **Step 3: Format-contract audit.** Dispatch the `idx-format-reviewer` agent over the diff (it audits writer/reader symmetry — this feature touches the counting contract on both sides). Address any CONFIRMED findings before the final commit.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md backend/CLAUDE.md frontend/CLAUDE.md
git commit -m "docs: article expiration (exp/xp) in the data contract"
```

---

## Plan Self-Review notes

- **Spec coverage**: data model (T1), harvest factoring (T2), ExpireArticles + crash/abort semantics (T3), cycle placement + warn-only (T4), inspect (T5), serve/webui/live counts (T6), reader counting correction (T7), search filter + info dialog (T8), e2e with aged-store generator + validate (T9), docs + verify + idx-format-reviewer (T10). Trade-offs need no code (documented in spec + comments).
- **Known soft spots the implementer must resolve in place** (flagged inline): the local-`Rm` failure injection in `TestExpireRmFailureAbortsAll` (verify `store/local.go rmErr` semantics; fallback given), the `tagCount` field name in Task 6's overview test, and the fresh-`search`-module import order in the e2e (follow `search.e2e.test.ts`).
- **Type consistency**: `ExpireDays`/`Expired` (Go), `exp`/`xp` (wire), `expire_days`/`expired` (feedView/feedListView), `expiredCounts: Uint32Array` (data.ts), `expired?: Uint32Array` (idx.ts param) — used consistently across tasks.
