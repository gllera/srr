# External Syndicates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Syndication outputs (`out/<name>.rss|json`) that SRR declares and cleans up but never generates — published by `srr syndicate push <name> [file|-]` and read back by `srr syndicate fetch <name>`.

**Architecture:** One new wire field (`OutFeed.External`, json `ext`). `setOutFeed` (shared by CLI + `PUT /api/syndicate/{name}`) enforces an external-vs-managed validation matrix. `SyncOutFeeds`/`outFeedsSig` operate on the managed subset only. `push`/`fetch` are lock-free (`withDB(false)`, no Commit, db.gz read-only) and reuse `outFileKey`/`outContentType` so header discipline is byte-identical to the sync path.

**Tech Stack:** Go (kong CLI, stdlib `encoding/xml`/`encoding/json`), vanilla-JS webui (`backend/webui/app.js`), `srr gen-ts` codegen.

**Spec:** `docs/superpowers/specs/2026-07-19-external-syndicates-design.md`

---

## Repo execution notes (read first)

- Work from the repo root `/home/gllera/ws/srr` (or a worktree branched off **local** `main` — it may be ahead of `origin/main`).
- Backend tests: `cd backend && go test -run '<Name>' .` — a package-level `var ctx = context.Background()` exists for tests, `setupTestDB(t)` returns `(db *DB, c *DBCore, dir string)` and wires `globals`. `captureOutput(t, fn)` captures the `stdout` package var (`cmd_feeds.go:23`, `var stdout io.Writer = os.Stdout`).
- Gates per task: `cd backend && gofmt -l . && go vet ./...` then the named tests. Before the final commit: `make verify` from the repo root.
- Another live session may edit this repo. Before every commit: `git status --short`, and `git add` **only** the files this plan names — never `git add -A`.
- Commit style: conventional commits (`feat(backend): …`, `docs: …`).

---

### Task 1: `OutFeed.External` wire field + `setOutFeed` validation matrix

**Files:**
- Modify: `backend/db.go` (OutFeed struct, ~line 291)
- Modify: `backend/cmd_syndicate.go` (`SyndicateSetCmd`, `setOutFeed`)
- Modify: `frontend/src/js/format.gen.ts` (regenerated, never hand-edited)
- Test: `backend/cmd_syndicate_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/cmd_syndicate_test.go`:

```go
// External entries are hands-off slots: no selectors, no limit — the fields
// that would imply generation are hard errors, so config never lies.
func TestSyndicateSetExternalValidation(t *testing.T) {
	cases := []struct {
		name string
		cmd  SyndicateSetCmd
		ok   bool
	}{
		{"plain external", SyndicateSetCmd{Name: "x", Format: "rss", External: true}, true},
		{"external with title", SyndicateSetCmd{Name: "x", Format: "json", Title: "T", External: true}, true},
		{"external with tags", SyndicateSetCmd{Name: "x", Format: "rss", External: true, Tags: []string{"a"}}, false},
		{"external with feeds", SyndicateSetCmd{Name: "x", Format: "rss", External: true, FeedIDs: []int{1}}, false},
		{"external with limit", SyndicateSetCmd{Name: "x", Format: "rss", External: true, Limit: 10}, false},
		{"external bad format", SyndicateSetCmd{Name: "x", Format: "xml", External: true}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, c, _ := setupTestDB(t)
			c.Feeds = map[int]*Feed{1: {id: 1, URL: "http://a", Tag: "a"}}
			err := tc.cmd.Run()
			if tc.ok && err != nil {
				t.Fatalf("set: %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

// An external entry persists Limit 0 (no default-50 stamp) and empty selectors.
func TestSyndicateSetExternalPersistsZeroLimit(t *testing.T) {
	_, _, _ = setupTestDB(t)
	if err := (&SyndicateSetCmd{Name: "x", Format: "rss", External: true}).Run(); err != nil {
		t.Fatalf("set: %v", err)
	}
	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(ctx)
	o := db2.core.Out[0]
	if !o.External || o.Limit != 0 || len(o.Tags) != 0 || len(o.Feeds) != 0 {
		t.Errorf("Out[0] = %+v, want external with zero limit/selectors", o)
	}
}

// managed→external keeps the same-key file (now externally owned);
// external→managed re-applies normal validation and the default limit.
func TestSyndicateSetTransitions(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{1: {id: 1, URL: "http://a", Tag: "news"}}
	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("set managed: %v", err)
	}
	if err := db.Put(ctx, "out/foo.rss", strings.NewReader("<rss/>"), true); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", External: true}).Run(); err != nil {
		t.Fatalf("set external: %v", err)
	}
	if n, _ := db.Stat(ctx, "out/foo.rss"); n == 0 {
		t.Error("same-key managed→external transition must keep the file")
	}
	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("set managed again: %v", err)
	}
	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(ctx)
	o := db2.core.Out[0]
	if o.External || o.Limit != outDefaultLimit {
		t.Errorf("Out[0] = %+v, want managed with default limit", o)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test -run 'TestSyndicateSetExternal|TestSyndicateSetTransitions' .`
Expected: compile error — `unknown field External in struct literal of type SyndicateSetCmd`.

- [ ] **Step 3: Implement**

In `backend/db.go`, add to the `OutFeed` struct after the `Limit` field:

```go
	// External marks an externally-updated output: SRR reserves the slot
	// (name, key, listing, rm cleanup) but never generates its bytes —
	// SyncOutFeeds skips it; `srr syndicate push`/`fetch` are the only writers.
	External bool `json:"ext,omitempty"`
```

In `backend/cmd_syndicate.go`, add to `SyndicateSetCmd` after `Limit`:

```go
	External bool `short:"x" help:"Externally-updated output: SRR reserves the slot but never generates its bytes. Publish with 'srr syndicate push', read back with 'srr syndicate fetch'. Takes no tags/feeds/limit."`
```

In `SyndicateSetCmd.Run`, pass it through: add `External: o.External,` to the `OutFeed{…}` literal.

In `setOutFeed`, replace the selector/limit validation block (the `if len(in.Tags) == 0 && len(in.Feeds) == 0 {` check through the `if in.Limit <= 0 {` default) with:

```go
	if in.External {
		// A hands-off slot: the fields that would imply generation are hard
		// errors, so a stored entry never lies about how its file is produced.
		if len(in.Tags) > 0 || len(in.Feeds) > 0 {
			return fmt.Errorf("external syndicate takes no selectors (tags/feeds)")
		}
		if in.Limit > 0 {
			return fmt.Errorf("external syndicate takes no limit")
		}
	} else {
		if len(in.Tags) == 0 && len(in.Feeds) == 0 {
			return fmt.Errorf("at least one of tags or feeds must be non-empty")
		}
		for _, id := range in.Feeds {
			if _, err := db.FeedByID(id); err != nil {
				return fmt.Errorf("feed id %d: unknown", id)
			}
		}
		if in.Limit <= 0 {
			in.Limit = outDefaultLimit
		}
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test -run 'TestSyndicate' .`
Expected: PASS (new tests and all pre-existing `TestSyndicate*` tests).

- [ ] **Step 5: Regenerate the TS contract**

Run: `make generate && make generate-check` from the repo root.
Expected: `frontend/src/js/format.gen.ts` now contains `ext?: boolean` in `IOutFeedWire`; generate-check exits 0.

- [ ] **Step 6: Commit**

```bash
git status --short   # confirm only the four files below are yours
git add backend/db.go backend/cmd_syndicate.go backend/cmd_syndicate_test.go frontend/src/js/format.gen.ts
git commit -m "feat(backend): OutFeed.External — declare externally-updated syndication slots"
```

---

### Task 2: `SyncOutFeeds` + `outFeedsSig` operate on managed entries only

**Files:**
- Modify: `backend/db_out.go` (`SyncOutFeeds` ~line 31, `outFeedsSig` ~line 67)
- Test: `backend/db_out_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/db_out_test.go` (it already imports what these need except possibly `io`; add `io` to the imports if absent):

```go
// SyncOutFeeds must never write an external entry's file — it is externally
// owned. The managed sibling proves the cycle still ran.
func TestSyncOutFeedsSkipsExternalEntries(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.CdnURL = "https://cdn.example.com"
	defer func() { globals.CdnURL = "" }()
	c.Feeds = map[int]*Feed{1: {id: 1, URL: "http://a", Tag: "news"}}
	c.Out = []OutFeed{
		{Name: "x", Format: "rss", External: true},
		{Name: "m", Format: "rss", Tags: []string{"news"}, Limit: 50},
	}
	if err := db.Put(ctx, "out/x.rss", strings.NewReader("EXTERNAL"), true); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}

	rc, err := db.Get(ctx, "out/x.rss", false)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(data) != "EXTERNAL" {
		t.Errorf("out/x.rss = %q; SyncOutFeeds overwrote an external slot", data)
	}
}

// A store with ONLY external entries is a silent no-op even without a CDN URL
// (external slots don't need one), and its signature is empty like the no-out
// case — an idle cycle never rewrites anything.
func TestSyncOutFeedsAllExternalIsNop(t *testing.T) {
	db, c, _ := setupTestDB(t)
	globals.CdnURL = "" // deliberately unset: must not matter
	c.Out = []OutFeed{{Name: "x", Format: "rss", External: true}}

	if err := db.SyncOutFeeds(ctx); err != nil {
		t.Fatalf("SyncOutFeeds: %v", err)
	}
	if n, _ := db.Stat(ctx, "out/x.rss"); n != 0 {
		t.Error("SyncOutFeeds wrote an external slot")
	}
	if sig := db.outFeedsSig(); sig != "" {
		t.Errorf("outFeedsSig = %q, want empty for an all-external store", sig)
	}
}

// External-entry config edits must not un-gate managed rewrites; a
// managed↔external transition must.
func TestOutFeedsSigIgnoresExternalEntries(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{1: {id: 1, URL: "http://a", Tag: "news"}}
	c.Out = []OutFeed{
		{Name: "m", Format: "rss", Tags: []string{"news"}, Limit: 50},
		{Name: "x", Format: "rss", External: true},
	}
	sig1 := db.outFeedsSig()

	c.Out[1].Title = "renamed"
	if sig2 := db.outFeedsSig(); sig2 != sig1 {
		t.Error("editing an external entry changed the signature")
	}

	c.Out[1] = OutFeed{Name: "x", Format: "rss", Tags: []string{"news"}, Limit: 50}
	if sig3 := db.outFeedsSig(); sig3 == sig1 {
		t.Error("external→managed transition did not change the signature")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test -run 'TestSyncOutFeedsSkipsExternal|TestSyncOutFeedsAllExternal|TestOutFeedsSigIgnoresExternal' .`
Expected: FAIL — `TestSyncOutFeedsAllExternalIsNop` (sig is currently non-empty for an all-external store) and `TestOutFeedsSigIgnoresExternalEntries` (editing the external entry changes the sig). `TestSyncOutFeedsSkipsExternalEntries` may already pass — pre-fix, an external entry has an empty include set and lands in `syncOneOutFeed`'s "no matching feeds; skipping" warn path, which spares the file only *accidentally*; the test pins the behavior so it survives once the skip becomes deliberate.

- [ ] **Step 3: Implement**

In `backend/db_out.go`, add below `outFeedsSig`:

```go
// managedOut returns the entries SyncOutFeeds generates — every non-External
// one. External entries are push-updated slots the fetch cycle must never
// write (see `srr syndicate push`); they are also excluded from outFeedsSig,
// so their config edits never un-gate a managed rewrite.
func (o *DB) managedOut() []OutFeed {
	var m []OutFeed
	for _, of := range o.core.Out {
		if !of.External {
			m = append(m, of)
		}
	}
	return m
}
```

In `SyncOutFeeds`, replace the body up to the loop:

```go
	managed := o.managedOut()
	if len(managed) == 0 {
		// Nothing to generate. Deliberately BEFORE the CDN check: a store with
		// only external slots needs no SRR_CDN_URL and must not warn about it.
		return nil
	}
	cdn := globals.CdnURL
	if cdn == "" {
		slog.Warn("syndication enabled but SRR_CDN_URL unset; skipping out/* feeds")
		return nil
	}

	failed := 0
	for _, of := range managed {
		if err := o.syncOneOutFeed(ctx, of, cdn); err != nil {
			slog.Warn("sync out feed", "name", of.Name, "error", err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d syndication output(s) failed", failed, len(managed))
	}
	return nil
```

(The old `if len(o.core.Out) == 0` guard is subsumed; delete it.)

In `outFeedsSig`, switch the encoded slice to the managed subset:

```go
	managed := o.managedOut()
	if len(managed) == 0 {
		return ""
	}
	var b strings.Builder
	_ = json.NewEncoder(&b).Encode(managed)
```

(the per-feed `Tag`/`AddIdx` suffix loop stays unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test -run 'TestSyncOutFeeds|TestOutFeedsSig' .`
Expected: PASS, including all pre-existing SyncOutFeeds tests.

- [ ] **Step 5: Commit**

```bash
git status --short
git add backend/db_out.go backend/db_out_test.go
git commit -m "feat(backend): SyncOutFeeds/outFeedsSig skip external syndication slots"
```

---

### Task 3: `srr syndicate push <name> [path|-]`

**Files:**
- Modify: `backend/cmd_syndicate.go` (new subcommand + helpers)
- Modify: `backend/main.go` — nothing (the subcommand registers via the `SyndicateGroup` struct)
- Test: `backend/cmd_syndicate_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/cmd_syndicate_test.go`. Add `"io"` to its imports.

```go
const testRSSDoc = `<rss version="2.0"><channel><title>t</title></channel></rss>`
const testJSONFeedDoc = `{"version":"https://jsonfeed.org/version/1.1","title":"t","items":[]}`

// readStoreKey reads a raw store object for assertions.
func readStoreKey(t *testing.T, db *DB, key string) string {
	t.Helper()
	rc, err := db.Get(ctx, key, false)
	if err != nil {
		t.Fatalf("read %s: %v", key, err)
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read %s: %v", key, err)
	}
	return string(data)
}

func seedExternalOut(t *testing.T, format string) (*DB, *DBCore) {
	t.Helper()
	db, c, _ := setupTestDB(t)
	c.Out = []OutFeed{{Name: "x", Format: format, External: true}}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
	return db, c
}

func TestSyndicatePushRSSFromStdin(t *testing.T) {
	db, _ := seedExternalOut(t, "rss")
	if err := (&SyndicatePushCmd{Name: "x", in: strings.NewReader(testRSSDoc)}).Run(); err != nil {
		t.Fatalf("push: %v", err)
	}
	if got := readStoreKey(t, db, "out/x.rss"); got != testRSSDoc {
		t.Errorf("out/x.rss = %q, want the pushed payload verbatim", got)
	}
}

func TestSyndicatePushJSONFromFile(t *testing.T) {
	db, _ := seedExternalOut(t, "json")
	path := filepath.Join(t.TempDir(), "feed.json")
	if err := os.WriteFile(path, []byte(testJSONFeedDoc), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := (&SyndicatePushCmd{Name: "x", Path: path}).Run(); err != nil {
		t.Fatalf("push: %v", err)
	}
	if got := readStoreKey(t, db, "out/x.json"); got != testJSONFeedDoc {
		t.Errorf("out/x.json = %q, want the pushed payload verbatim", got)
	}
}

// Push is lock-free: it must succeed while another process holds .locked,
// and it must not modify db.gz.
func TestSyndicatePushLockFreeAndDBUntouched(t *testing.T) {
	db, _ := seedExternalOut(t, "rss")
	before := readStoreKey(t, db, "db.gz")

	locker, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	defer locker.Close(ctx)

	if err := (&SyndicatePushCmd{Name: "x", in: strings.NewReader(testRSSDoc)}).Run(); err != nil {
		t.Fatalf("push under a held lock: %v", err)
	}
	if after := readStoreKey(t, db, "db.gz"); after != before {
		t.Error("push modified db.gz")
	}
}

func TestSyndicatePushRejections(t *testing.T) {
	cases := []struct {
		name    string
		format  string
		payload string
		errPart string
	}{
		{"malformed xml", "rss", "<rss><unclosed>", "XML"},
		{"wrong root", "rss", "<feed/>", "root element"},
		{"non-json", "json", "not json", "JSON"},
		{"json without version marker", "json", `{"title":"t"}`, "JSON Feed"},
		{"empty payload", "rss", "", "empty"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, _ := seedExternalOut(t, tc.format)
			err := (&SyndicatePushCmd{Name: "x", in: strings.NewReader(tc.payload)}).Run()
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), tc.errPart) {
				t.Errorf("error = %v, want mention of %q", err, tc.errPart)
			}
			key := outFileKey(db.core.Out[0])
			if n, _ := db.Stat(ctx, key); n != 0 {
				t.Errorf("%s was written despite the rejected payload", key)
			}
		})
	}
}

func TestSyndicatePushOverCap(t *testing.T) {
	old := maxOutPayload
	maxOutPayload = 8
	defer func() { maxOutPayload = old }()

	_, _ = seedExternalOut(t, "rss")
	err := (&SyndicatePushCmd{Name: "x", in: strings.NewReader(testRSSDoc)}).Run()
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("err = %v, want over-cap rejection", err)
	}
}

func TestSyndicatePushUnknownAndManaged(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{1: {id: 1, URL: "http://a", Tag: "news"}}
	c.Out = []OutFeed{{Name: "m", Format: "rss", Tags: []string{"news"}, Limit: 50}}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("seed commit: %v", err)
	}

	err := (&SyndicatePushCmd{Name: "nope", in: strings.NewReader(testRSSDoc)}).Run()
	if err == nil || !strings.Contains(err.Error(), "unknown syndication output") {
		t.Fatalf("err = %v, want unknown-name error", err)
	}
	err = (&SyndicatePushCmd{Name: "m", in: strings.NewReader(testRSSDoc)}).Run()
	if err == nil || !strings.Contains(err.Error(), "managed") {
		t.Fatalf("err = %v, want managed-entry rejection", err)
	}
}

// A stored entry with an unsafe name (hand-edited db.gz) must not resolve to
// a write outside out/ — findOutFeed re-checks validOutName, the same
// defense-in-depth syncOneOutFeed runs on the generate path.
func TestSyndicatePushUnsafeStoredName(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.Out = []OutFeed{{Name: "../../evil", Format: "rss", External: true}}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
	err := (&SyndicatePushCmd{Name: "../../evil", in: strings.NewReader(testRSSDoc)}).Run()
	if err == nil || !strings.Contains(err.Error(), "unsafe name") {
		t.Fatalf("err = %v, want unsafe-name rejection", err)
	}
}
```

Add `"os"` and `"path/filepath"` to the test file's imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test -run 'TestSyndicatePush' .`
Expected: compile error — `undefined: SyndicatePushCmd` (and `maxOutPayload`).

- [ ] **Step 3: Implement**

In `backend/cmd_syndicate.go`:

Extend the imports to:

```go
import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"log/slog"
	"os"
	"regexp"
	"strings"

	"srr/store"
)
```

Add the subcommand to `SyndicateGroup`:

```go
	Push SyndicatePushCmd `cmd:"" help:"Publish an external syndication output from a file or stdin."`
```

Add below `SyndicateRmCmd`:

```go
// maxOutPayload caps a pushed syndication payload (64 MiB, consistent with
// the subprocess-stdout and frontend-download caps). A var, not a const:
// tests shrink it to exercise the rejection without a 64 MiB buffer.
var maxOutPayload int64 = 64 << 20

// SyndicatePushCmd publishes an external syndication output: payload from a
// file (or stdin), validated for well-formedness, written with the exact
// header discipline SyncOutFeeds uses. Lock-free: db.gz is read, never
// written, so a push never contends with a running fetch cycle.
type SyndicatePushCmd struct {
	Name string `arg:"" help:"Output feed name (must be declared with --external)."`
	Path string `arg:"" optional:"" default:"-" help:"Payload file; '-' (the default) reads stdin."`

	in io.Reader // test seam; defaults to os.Stdin
}

func (o *SyndicatePushCmd) Run() error {
	return withDB(false, func(ctx context.Context, db *DB) error {
		entry, err := findOutFeed(db, o.Name)
		if err != nil {
			return err
		}
		if !entry.External {
			return fmt.Errorf("syndication output %q is managed (generated from selectors each fetch cycle); a pushed file would be overwritten — recreate it with --external", o.Name)
		}

		src := o.in
		if src == nil {
			src = os.Stdin
		}
		if o.Path != "" && o.Path != "-" {
			f, err := os.Open(o.Path)
			if err != nil {
				return err
			}
			defer f.Close()
			src = f
		}
		payload, err := io.ReadAll(io.LimitReader(src, maxOutPayload+1))
		if err != nil {
			return fmt.Errorf("read payload: %w", err)
		}
		if int64(len(payload)) > maxOutPayload {
			return fmt.Errorf("payload exceeds %d bytes", maxOutPayload)
		}
		if len(payload) == 0 {
			return fmt.Errorf("empty payload — a generator with nothing to publish should not push")
		}
		if err := validateOutPayload(entry.Format, payload); err != nil {
			return err
		}

		key := outFileKey(*entry)
		if err := db.AtomicPut(ctx, key, bytes.NewReader(payload), store.ObjectMeta{ContentType: outContentType(*entry)}); err != nil {
			return fmt.Errorf("publish %s: %w", key, err)
		}
		if globals.CdnURL != "" {
			slog.Info("published syndication output", "key", key, "bytes", len(payload), "url", joinURL(globals.CdnURL, key))
		} else {
			slog.Info("published syndication output", "key", key, "bytes", len(payload))
		}
		return nil
	})
}

// findOutFeed resolves a syndication entry by name (pointer into core.Out).
// Defense-in-depth like syncOneOutFeed's validOutName re-check: a stored name
// is deserialized straight from db.gz, and push/fetch resolve outFileKey from
// it — a hand-edited "../../db" must not traverse out of out/ on local/SFTP.
func findOutFeed(db *DB, name string) (*OutFeed, error) {
	for i := range db.core.Out {
		if db.core.Out[i].Name == name {
			if !validOutName(name) {
				return nil, fmt.Errorf("syndication output %q has an unsafe name", name)
			}
			return &db.core.Out[i], nil
		}
	}
	return nil, fmt.Errorf("unknown syndication output %q — declare it first: srr syndicate set %s -f rss|json --external", name, name)
}

// validateOutPayload is the push-time well-formedness gate: a broken
// generator must not blank the published feed. rss ⇒ well-formed XML with an
// <rss> root; json ⇒ a JSON object carrying the JSON Feed version marker.
func validateOutPayload(format string, data []byte) error {
	if format == "json" {
		var probe struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(data, &probe); err != nil {
			return fmt.Errorf("payload is not valid JSON: %w", err)
		}
		if !strings.HasPrefix(probe.Version, "https://jsonfeed.org/version/") {
			return fmt.Errorf("payload is not a JSON Feed (missing the jsonfeed.org version marker)")
		}
		return nil
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	root := ""
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("payload is not well-formed XML: %w", err)
		}
		if se, ok := tok.(xml.StartElement); ok && root == "" {
			root = se.Name.Local
		}
	}
	if root != "rss" {
		return fmt.Errorf("payload root element is %q, want <rss> (the entry's declared format is rss)", root)
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test -run 'TestSyndicate' .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status --short
git add backend/cmd_syndicate.go backend/cmd_syndicate_test.go
git commit -m "feat(backend): srr syndicate push — publish an external syndication output"
```

---

### Task 4: `srr syndicate fetch <name>`

**Files:**
- Modify: `backend/cmd_syndicate.go`
- Test: `backend/cmd_syndicate_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/cmd_syndicate_test.go`:

```go
// push→fetch round-trips the exact bytes to stdout (pipe-clean).
func TestSyndicateFetchRoundTrip(t *testing.T) {
	_, _ = seedExternalOut(t, "rss")
	if err := (&SyndicatePushCmd{Name: "x", in: strings.NewReader(testRSSDoc)}).Run(); err != nil {
		t.Fatalf("push: %v", err)
	}
	got := captureOutput(t, func() {
		if err := (&SyndicateFetchCmd{Name: "x"}).Run(); err != nil {
			t.Fatalf("fetch: %v", err)
		}
	})
	if got != testRSSDoc {
		t.Errorf("fetch = %q, want the pushed payload verbatim", got)
	}
}

// fetch is read-only and therefore works on managed entries too — reading
// what SyncOutFeeds last generated is legitimate inspection.
func TestSyndicateFetchManagedEntry(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{1: {id: 1, URL: "http://a", Tag: "news"}}
	c.Out = []OutFeed{{Name: "m", Format: "rss", Tags: []string{"news"}, Limit: 50}}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
	if err := db.Put(ctx, "out/m.rss", strings.NewReader("<rss/>"), true); err != nil {
		t.Fatalf("seed: %v", err)
	}
	got := captureOutput(t, func() {
		if err := (&SyndicateFetchCmd{Name: "m"}).Run(); err != nil {
			t.Fatalf("fetch: %v", err)
		}
	})
	if got != "<rss/>" {
		t.Errorf("fetch = %q, want the synced file", got)
	}
}

func TestSyndicateFetchMissingAndUnknown(t *testing.T) {
	_, _ = seedExternalOut(t, "rss") // declared but never pushed

	err := (&SyndicateFetchCmd{Name: "x"}).Run()
	if err == nil || !strings.Contains(err.Error(), "out/x.rss") {
		t.Fatalf("err = %v, want missing-object error naming the key", err)
	}
	err = (&SyndicateFetchCmd{Name: "nope"}).Run()
	if err == nil || !strings.Contains(err.Error(), "unknown syndication output") {
		t.Fatalf("err = %v, want unknown-name error", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test -run 'TestSyndicateFetch' .`
Expected: compile error — `undefined: SyndicateFetchCmd`.

- [ ] **Step 3: Implement**

In `backend/cmd_syndicate.go`, add to `SyndicateGroup`:

```go
	Fetch SyndicateFetchCmd `cmd:"" help:"Print a syndication output's currently published file to stdout."`
```

Add below `SyndicatePushCmd`:

```go
// SyndicateFetchCmd streams the currently published out/<name>.<ext> to
// stdout — the read counterpart of push, enabling stateless read-modify-write
// generators (`srr syndicate fetch x | merge | srr syndicate push x`).
// Read-only, so it works on managed entries too; lock-free like push. The
// payload goes to stdout alone (diagnostics ride stderr), no cap, no
// validation — it returns exactly what is published.
type SyndicateFetchCmd struct {
	Name string `arg:"" help:"Output feed name."`
}

func (o *SyndicateFetchCmd) Run() error {
	return withDB(false, func(ctx context.Context, db *DB) error {
		entry, err := findOutFeed(db, o.Name)
		if err != nil {
			return err
		}
		key := outFileKey(*entry)
		rc, err := db.Get(ctx, key, true)
		if err != nil {
			return fmt.Errorf("read %s: %w", key, err)
		}
		if rc == nil {
			return fmt.Errorf("no published file at %s (nothing pushed or synced yet)", key)
		}
		defer rc.Close()
		if _, err := io.Copy(stdout, rc); err != nil {
			return fmt.Errorf("write payload: %w", err)
		}
		return nil
	})
}
```

(`stdout` is the existing package seam in `cmd_feeds.go:23`; `captureOutput` swaps it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test -run 'TestSyndicate' .`
Expected: PASS.

- [ ] **Step 5: Run the full backend gate**

Run: `cd backend && gofmt -l . && go vet ./... && go test ./...`
Expected: no gofmt output, vet clean, all tests PASS.

- [ ] **Step 6: Commit**

```bash
git status --short
git add backend/cmd_syndicate.go backend/cmd_syndicate_test.go
git commit -m "feat(backend): srr syndicate fetch — print the published output to stdout"
```

---

### Task 5: Serve API pin + webui external checkbox

**Files:**
- Modify: `backend/webui/app.js` (`renderSyndicate` ~line 1089, `openOutModal` ~line 1143)
- Test: `backend/cmd_serve_test.go`

- [ ] **Step 1: Write the failing test** (API only — the webui has no JS test layer)

Append to `backend/cmd_serve_test.go`:

```go
// The PUT handler shares setOutFeed, so external entries round-trip through
// the API with the same validation matrix as the CLI.
func TestServeSyndicatePutExternal(t *testing.T) {
	setupTestDB(t)

	rec := doReq(t, newMux(), "PUT", "/api/syndicate/x", `{"format":"rss","ext":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT external = %d (%s), want 200", rec.Code, rec.Body)
	}
	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(ctx)
	if len(db2.core.Out) != 1 || !db2.core.Out[0].External {
		t.Errorf("Out = %+v, want one external entry", db2.core.Out)
	}

	rec = doReq(t, newMux(), "PUT", "/api/syndicate/y", `{"format":"rss","ext":true,"tags":["a"]}`)
	if rec.Code == http.StatusOK {
		t.Error("external entry with selectors was accepted; setOutFeed matrix not enforced")
	}

	rec = doReq(t, newMux(), "GET", "/api/overview", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ext":true`) {
		t.Errorf("overview = %d %q, want 200 carrying \"ext\":true", rec.Code, rec.Body)
	}
}
```

(Add `"strings"` to the test file's imports if absent.)

- [ ] **Step 2: Run test — it should already PASS**

Run: `cd backend && go test -run 'TestServeSyndicatePutExternal' .`
Expected: PASS with zero handler changes — this test *pins* that the shared `setOutFeed` gives the API the matrix for free. If it fails, the sharing broke; fix that, don't fork validation.

- [ ] **Step 3: Implement the webui changes**

In `backend/webui/app.js`:

**(a)** In `renderSyndicate`, mark external rows — replace the format cell

```js
      el("td", {}, el("span", { class: "chip" }, o.format)),
```

with:

```js
      el("td", {}, el("span", { class: "chip" }, o.format),
        ...(o.ext ? [" ", el("span", { class: "chip" }, "external")] : [])),
```

**(b)** In `openOutModal`, wire the checkbox. Replace the block from `const v = o || …` through `const err = el("div", { class: "formerr" });` with:

```js
  const v = o || { name: "", title: "", format: "rss", tags: [], feeds: [], limit: 50, ext: false };
  const name = el("input", { value: v.name, disabled: isEdit ? "" : null });
  const fmt = el("select", {}, el("option", { value: "rss" }, "rss"), el("option", { value: "json" }, "json"));
  fmt.value = v.format;
  const title = el("input", { value: v.title || "" });
  // External outputs are hands-off slots (updated via `srr syndicate push`):
  // the selector/limit rows make no sense there and the server rejects them,
  // so the whole block hides while the box is checked.
  const ext = el("input", { type: "checkbox", onchange: () => (selWrap.hidden = ext.checked) });
  ext.checked = !!v.ext;
  // Selectors are picked from the snapshot (union of tags ∪ feeds), not typed
  // as raw names/ids — the operator shouldn't need to know feed numbers.
  const [tagsBox, tagSel] = checkList(
    snapshot.tags.filter((t) => t.tag)
      .map((t) => ({ value: t.tag, label: `${t.tag} (${t.feeds} feed${t.feeds === 1 ? "" : "s"})` })),
    v.tags || []);
  const [feedsBox, feedSel] = checkList(
    snapshot.feeds.map((f) => ({ value: f.id, label: f.title })),
    v.feeds || []);
  const limit = el("input", { type: "number", value: v.limit || 50 });
  const selWrap = el("div", {},
    el("label", {}, "Tags"), tagsBox,
    el("label", {}, "Feeds"), feedsBox,
    el("label", {}, "Limit"), limit);
  selWrap.hidden = ext.checked;
  const err = el("div", { class: "formerr" });
```

**(c)** In the `save` button handler, make the body conditional — replace the `const body = {…};` literal with:

```js
    const body = ext.checked
      ? { title: title.value.trim(), format: fmt.value, ext: true }
      : { title: title.value.trim(), format: fmt.value,
          tags: [...tagSel], feeds: [...feedSel], limit: Number(limit.value) || 0 };
```

**(d)** In the `outDialog.replaceChildren(…)` call, replace the four selector rows

```js
    el("label", {}, "Tags"), tagsBox,
    el("label", {}, "Feeds"), feedsBox,
    el("label", {}, "Limit"), limit,
```

with:

```js
    el("label", { class: "check" }, ext, "External — updated via srr syndicate push"),
    selWrap,
```

- [ ] **Step 4: Verify the build + smoke the GUI**

Run: `cd backend && go build -o /tmp/srr-check . && go test -run 'TestServe' .`
Expected: build OK (app.js is `//go:embed`ed), serve tests PASS.

Manual smoke (optional but recommended): `./dist/srr serve -o <tmpstore>` is NOT needed — the embedded webui is minified at server startup, so source-greps against a running server won't match; rely on the API test and a visual check when the feature ships.

- [ ] **Step 5: Commit**

```bash
git status --short
git add backend/webui/app.js backend/cmd_serve_test.go
git commit -m "feat(backend): webui external-syndicate checkbox + API matrix pin"
```

---

### Task 6: Documentation + full verify

**Files:**
- Modify: `CLAUDE.md` (repo root — the `out` row of the db.gz table)
- Modify: `backend/CLAUDE.md` (`cmd_syndicate.go` and `db_out.go` bullets)
- Modify: `backend/README.md` (syndication section)

- [ ] **Step 1: Root `CLAUDE.md`** — in the db.gz field table's `out` row, append before the final sentence "Managed via `srr syndicate`.":

```
An entry with `ext: true` is **external**: SRR reserves the slot (name, key, listing, rm cleanup) but never generates its bytes — `SyncOutFeeds`/`outFeedsSig` skip it (it needs no `SRR_CDN_URL`), it takes no tags/feeds/limit, and it is written only by `srr syndicate push <name> [file|-]` (stdin default, 64 MiB cap, well-formedness-validated, lock-free — db.gz is read, never written) and read back by `srr syndicate fetch <name>` (published bytes to stdout; works on managed entries too).
```

- [ ] **Step 2: `backend/CLAUDE.md`** — extend the `cmd_syndicate.go` bullet: after the `rm` description, add:

```
`push <name> [path|-]` (publish an **external** entry's file: payload from stdin/file, 64 MiB cap (`maxOutPayload`, test-shrinkable var), well-formedness gate `validateOutPayload` — rss ⇒ full XML token walk + `<rss>` root, json ⇒ object with the jsonfeed.org `version` marker — then `AtomicPut` with `outContentType`, byte-identical header discipline to `syncOneOutFeed`; lock-free `withDB(false)`, refuses managed entries), `fetch <name>` (stream the published file to the `stdout` seam — read-only, managed entries allowed, missing object is a hard error naming the key). `setOutFeed`'s matrix: external entries reject selectors/limit and persist `Limit: 0`; `findOutFeed` resolves by name.
```

And extend the `db_out.go` bullet: after the `SyncOutFeeds(ctx)` intro, add:

```
Both `SyncOutFeeds` and `outFeedsSig` operate on `managedOut()` (the non-`External` subset): external slots are never written by the cycle, their config edits never un-gate managed rewrites, and an all-external store is a silent no-op even without `SRR_CDN_URL` (the zero-managed return precedes the CDN warn).
```

- [ ] **Step 3: `backend/README.md`** — in the syndication section (search for "syndicate"), add a subsection:

```markdown
### External outputs

`srr syndicate set digest -f rss --external` declares a slot SRR never generates:
the fetch cycle skips it, and its file is published by an external tool on its own
schedule. `--external` takes no `-g`/`-i`/`-l` (there is nothing to generate).

    gen-digest | srr syndicate push digest      # publish (stdin is the default)
    srr syndicate push digest feed.rss          # publish from a file
    srr syndicate fetch digest                  # print the published file to stdout
    srr syndicate fetch digest | merge | srr syndicate push digest   # read-modify-write

`push` validates well-formedness before writing (rss ⇒ XML with an `<rss>` root;
json ⇒ a JSON Feed `version` marker), caps the payload at 64 MiB, stamps the same
Content-Type/Cache-Control as generated outputs, and is lock-free — it never
contends with a running fetch cycle. `fetch` streams exactly the published bytes
to stdout (works for managed outputs too); a slot that has never been published
is a hard error, so a first-run read-modify-write pipeline bootstraps with
`srr syndicate fetch digest || true`. `rm` deletes an external slot's file like
any other.
```

- [ ] **Step 4: Full verify**

Run: `make verify` from the repo root.
Expected: lint + format + tests + build (both projects) + e2e contract all green. (`generate-check` passes because Task 1 committed the regenerated `format.gen.ts`.)

- [ ] **Step 5: Commit**

```bash
git status --short
git add CLAUDE.md backend/CLAUDE.md backend/README.md
git commit -m "docs: external syndication slots — declare/push/fetch workflow"
```

---

## Self-review checklist (run after all tasks)

- Spec §1 wire field → Task 1; §2 matrix + transitions → Task 1; §3 sync/sig → Task 2; §4 push → Task 3, fetch → Task 4; §5 API/GUI → Task 5; §6 rm/ls → covered by existing tests (no change); concurrency model → `TestSyndicatePushLockFreeAndDBUntouched`; docs → Task 6.
- Deliberately NOT implemented (spec "Out of scope"): HTTP push endpoint, remote-URL pull, scheduled generators, formats beyond rss/json, `srr inspect` out/ checks.
- Rollout reminder for the operator (not a code task): update srr binaries on gateway/bastion/dmz **before** declaring the first external entry — an older binary's Commit strips `ext` from db.gz.
