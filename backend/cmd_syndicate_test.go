package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// captureOutput captures printJSON output by substituting stdout.
func captureOutput(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	old := stdout
	stdout = &buf
	defer func() { stdout = old }()
	fn()
	return buf.String()
}

func TestSyndicateLsEmpty(t *testing.T) {
	_, _, _ = setupTestDB(t)

	out := captureOutput(t, func() {
		if err := (&SyndicateLsCmd{}).Run(); err != nil {
			t.Fatalf("syndicate ls: %v", err)
		}
	})
	// Should print null (empty slice) or []
	if strings.TrimSpace(out) != "null" && strings.TrimSpace(out) != "[]" {
		t.Errorf("empty ls = %q, want null or []", strings.TrimSpace(out))
	}
}

// TestSyndicateSetPersistsAndLists sets one output feed, then asserts it is
// visible via BOTH read paths — a fresh DB reopen (db.core.Out) and `syndicate
// ls` (the JSON printer) — folding the former set-then-reopen and set-then-ls
// tests that differed only in the read path.
func TestSyndicateSetPersistsAndLists(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}, Limit: 20}).Run(); err != nil {
		t.Fatalf("syndicate set: %v", err)
	}

	// Read path 1: reopen the DB and inspect the persisted entry.
	db2, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(context.Background())
	if len(db2.core.Out) != 1 {
		t.Fatalf("Out len = %d, want 1", len(db2.core.Out))
	}
	o := db2.core.Out[0]
	if o.Name != "foo" || o.Format != "rss" || len(o.Tags) != 1 || o.Tags[0] != "news" || o.Limit != 20 {
		t.Errorf("Out[0] = %+v, want {Name:foo Format:rss Tags:[news] Limit:20}", o)
	}

	// Read path 2: `syndicate ls` prints the same entry.
	out := captureOutput(t, func() {
		if err := (&SyndicateLsCmd{}).Run(); err != nil {
			t.Fatalf("syndicate ls: %v", err)
		}
	})
	var entries []OutFeed
	if err := json.Unmarshal([]byte(out), &entries); err != nil {
		t.Fatalf("unmarshal ls output: %v (raw: %q)", err, out)
	}
	if len(entries) != 1 || entries[0].Name != "foo" || entries[0].Format != "rss" {
		t.Errorf("ls = %+v, want [{Name:foo Format:rss}]", entries)
	}
}

func TestSyndicateSetUpdatesInPlace(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}, Limit: 10}).Run(); err != nil {
		t.Fatalf("syndicate set #1: %v", err)
	}
	// Update same name
	if err := (&SyndicateSetCmd{Name: "foo", Format: "json", Tags: []string{"news"}, Title: "Updated", Limit: 50}).Run(); err != nil {
		t.Fatalf("syndicate set #2: %v", err)
	}

	db2, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(context.Background())

	if len(db2.core.Out) != 1 {
		t.Fatalf("Out len = %d after upsert, want 1", len(db2.core.Out))
	}
	o := db2.core.Out[0]
	if o.Format != "json" || o.Title != "Updated" || o.Limit != 50 {
		t.Errorf("upserted = %+v, want json/Updated/50", o)
	}
}

func TestSyndicateRmRemoves(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("syndicate set: %v", err)
	}
	if err := (&SyndicateRmCmd{Name: "foo"}).Run(); err != nil {
		t.Fatalf("syndicate rm: %v", err)
	}

	db2, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(context.Background())

	if len(db2.core.Out) != 0 {
		t.Errorf("Out len = %d after rm, want 0", len(db2.core.Out))
	}
}

func TestSyndicateSetInvalidFormat(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{}

	err := (&SyndicateSetCmd{Name: "foo", Format: "xml", Tags: []string{"x"}}).Run()
	if err == nil {
		t.Error("expected error for invalid format")
	}
	if !strings.Contains(err.Error(), "format") {
		t.Errorf("error = %v, want mention of 'format'", err)
	}
}

func TestSyndicateSetNoTagsOrFeeds(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{}

	err := (&SyndicateSetCmd{Name: "foo", Format: "rss"}).Run()
	if err == nil {
		t.Error("expected error when neither tags nor feeds specified")
	}
}

func TestSyndicateSetUnknownFeedID(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a"},
	}

	err := (&SyndicateSetCmd{Name: "foo", Format: "rss", FeedIDs: []int{999}}).Run()
	if err == nil {
		t.Error("expected error for unknown feed id 999")
	}
	if !strings.Contains(err.Error(), "999") {
		t.Errorf("error = %v, want mention of feed id", err)
	}
}

func TestSyndicateSetDefaultLimit(t *testing.T) {
	_, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	// Limit 0 → default applied
	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("syndicate set: %v", err)
	}

	db2, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(context.Background())

	if db2.core.Out[0].Limit != outDefaultLimit {
		t.Errorf("Limit = %d, want outDefaultLimit (%d)", db2.core.Out[0].Limit, outDefaultLimit)
	}
}

// TestSyndicateRmCleansOutFile verifies that rm deletes the entry's on-store
// out/ file, not just the db.gz entry: a real out/myfeed.rss is seeded, then rm
// must remove it.
func TestSyndicateRmCleansOutFile(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	if err := (&SyndicateSetCmd{Name: "myfeed", Format: "rss", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("syndicate set: %v", err)
	}
	// Seed the rolling output file SyncOutFeeds would have written.
	const outKey = "out/myfeed.rss"
	if err := db.Put(ctx, outKey, strings.NewReader("<rss/>"), true); err != nil {
		t.Fatalf("seed out file: %v", err)
	}
	if n, _ := db.Stat(ctx, outKey); n == 0 {
		t.Fatalf("seed did not create %s", outKey)
	}

	if err := (&SyndicateRmCmd{Name: "myfeed"}).Run(); err != nil {
		t.Fatalf("syndicate rm: %v", err)
	}
	if n, _ := db.Stat(ctx, outKey); n != 0 {
		t.Errorf("%s still present (size %d) after rm; the out/ file was not reaped", outKey, n)
	}
}

// TestSyndicateSetReapsOldFormatFile pins the format-change orphan reap: an
// entry switched rss→json deletes the stale out/<name>.rss while leaving the
// new-format out/<name>.json untouched (setOutFeed only reaps the OLD extension).
func TestSyndicateSetReapsOldFormatFile(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{
		1: {id: 1, URL: "http://a", Tag: "news"},
	}

	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("syndicate set rss: %v", err)
	}
	// Both the current (rss) file and a future (json) file exist on the store.
	if err := db.Put(ctx, "out/foo.rss", strings.NewReader("<rss/>"), true); err != nil {
		t.Fatalf("seed rss: %v", err)
	}
	if err := db.Put(ctx, "out/foo.json", strings.NewReader("{}"), true); err != nil {
		t.Fatalf("seed json: %v", err)
	}

	if err := (&SyndicateSetCmd{Name: "foo", Format: "json", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("syndicate set json: %v", err)
	}

	if n, _ := db.Stat(ctx, "out/foo.rss"); n != 0 {
		t.Errorf("out/foo.rss still present (size %d); the stale-format file was not reaped", n)
	}
	if n, _ := db.Stat(ctx, "out/foo.json"); n == 0 {
		t.Error("out/foo.json was deleted; the reap must only remove the OLD extension")
	}

	db2, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(context.Background())
	if len(db2.core.Out) != 1 || db2.core.Out[0].Format != "json" {
		t.Errorf("Out = %+v, want a single json entry", db2.core.Out)
	}
}

// An entry stored with an EMPTY format (a hand-edited or pre-validation
// db.gz) must not delete its own live output. setOutFeed reaps by comparing
// resolved KEYS, not raw formats: outFileKey defaults anything that is not
// "json" to .rss, so ""→"rss" resolves to the same out/<name>.rss the new
// config names — comparing the format strings saw a change and deleted it.
func TestSyndicateSetEmptyOldFormatKeepsOutFile(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{1: {id: 1, URL: "http://a", Tag: "news"}}
	c.Out = []OutFeed{{Name: "foo", Format: "", Tags: []string{"news"}, Limit: 50}}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
	if err := db.Put(ctx, "out/foo.rss", strings.NewReader("<rss/>"), true); err != nil {
		t.Fatalf("seed rss: %v", err)
	}

	if err := (&SyndicateSetCmd{Name: "foo", Format: "rss", Tags: []string{"news"}}).Run(); err != nil {
		t.Fatalf("syndicate set rss: %v", err)
	}
	if n, _ := db.Stat(ctx, "out/foo.rss"); n == 0 {
		t.Error("out/foo.rss was deleted; the reap removed the very file the new config names")
	}
	// The upsert must still have happened — otherwise this passes for a no-op.
	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(ctx)
	if len(db2.core.Out) != 1 || db2.core.Out[0].Format != "rss" {
		t.Errorf("Out = %+v, want a single entry with format rss", db2.core.Out)
	}
}

// A Rm failure on a file that IS present is fatal, and must leave the config
// intact so a retry still names the file — the whole reason the Rm precedes
// Commit. This holds for a stray sibling too, not just the configured
// extension: dropping the entry would strand a real file that no config names
// and nothing can ever delete (the store has no List).
func TestSyndicateRmFailsWhenPresentFileCannotBeRemoved(t *testing.T) {
	for _, tc := range []struct{ name, format, failKey string }{
		{"configured extension", "rss", "out/foo.rss"},
		{"stray sibling", "json", "out/foo.rss"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, c, _ := setupTestDB(t)
			c.Feeds = map[int]*Feed{1: {id: 1, URL: "http://a", Tag: "news"}}
			c.Out = []OutFeed{{Name: "foo", Format: tc.format, Tags: []string{"news"}, Limit: 50}}
			// Both files genuinely exist on the store.
			for _, k := range []string{"out/foo.rss", "out/foo.json"} {
				if err := db.Put(ctx, k, strings.NewReader("x"), true); err != nil {
					t.Fatalf("seed %s: %v", k, err)
				}
			}

			db.Backend = &rmFailBackend{Backend: db.Backend, key: tc.failKey}
			if err := removeOutFeed(ctx, db, "foo"); err == nil {
				t.Fatalf("removeOutFeed returned nil though present %s could not be deleted", tc.failKey)
			}
			if len(db.core.Out) != 1 {
				t.Errorf("Out = %+v, want the entry still configured so a retry can reap the file", db.core.Out)
			}
		})
	}
}

// setOutFeed's old-format reap runs BEFORE the Commit for the same reason
// removeOutFeed's does: once the config names the new extension, nothing can
// ever delete the old file (the store has no List). So a Rm failure on a file
// that IS present must fail the upsert with the config — and therefore the only
// name that file has — left intact.
func TestSyndicateSetFailsWhenOldFormatFileCannotBeReaped(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{1: {id: 1, URL: "http://a", Tag: "news"}}
	c.Out = []OutFeed{{Name: "foo", Format: "rss", Tags: []string{"news"}, Limit: 50}}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
	if err := db.Put(ctx, "out/foo.rss", strings.NewReader("<rss/>"), true); err != nil {
		t.Fatalf("seed rss: %v", err)
	}

	db.Backend = &rmFailBackend{Backend: db.Backend, key: "out/foo.rss"}
	in := OutFeed{Name: "foo", Format: "json", Tags: []string{"news"}, Limit: 50}
	if err := setOutFeed(ctx, db, in); err == nil {
		t.Fatal("setOutFeed returned nil though the present out/foo.rss could not be reaped")
	}
	if len(db.core.Out) != 1 || db.core.Out[0].Format != "rss" {
		t.Errorf("Out = %+v, want the old rss entry intact so a retry still names out/foo.rss", db.core.Out)
	}
}

// The tolerated case is narrow and provable: the object is NOT there. A store
// that answers DELETE with 405/403 rather than 404 on a key that never existed
// must not make the entry undeletable.
func TestSyndicateRmToleratesRmErrorOnAbsentFile(t *testing.T) {
	db, c, _ := setupTestDB(t)
	c.Feeds = map[int]*Feed{1: {id: 1, URL: "http://a", Tag: "news"}}
	c.Out = []OutFeed{{Name: "foo", Format: "rss", Tags: []string{"news"}, Limit: 50}}
	if err := db.Put(ctx, "out/foo.rss", strings.NewReader("<rss/>"), true); err != nil {
		t.Fatalf("seed rss: %v", err)
	}

	// The sibling .json was never written; make its delete error anyway.
	db.Backend = &rmFailBackend{Backend: db.Backend, key: "out/foo.json"}
	if err := removeOutFeed(ctx, db, "foo"); err != nil {
		t.Fatalf("removeOutFeed wedged on an absent sibling: %v", err)
	}
	if len(db.core.Out) != 0 {
		t.Errorf("Out = %+v, want the entry removed", db.core.Out)
	}
	if n, _ := db.Stat(ctx, "out/foo.rss"); n != 0 {
		t.Errorf("out/foo.rss still present (size %d); the configured file was not reaped", n)
	}
}

// TestSyndicateSetNameValidation verifies that unsafe names (path traversal,
// empty, ".", "..") are rejected and that a valid name still works.
func TestSyndicateSetNameValidation(t *testing.T) {
	unsafeNames := []string{
		"../../db",
		"../idx/0",
		"a/b",
		"..",
		".",
		"",
		"foo bar",
		"foo\x00bar",
	}
	for _, name := range unsafeNames {
		t.Run("reject_"+name, func(t *testing.T) {
			_, c, _ := setupTestDB(t)
			c.Feeds = map[int]*Feed{
				1: {id: 1, URL: "http://a", Tag: "x"},
			}
			err := (&SyndicateSetCmd{
				Name:   name,
				Format: "rss",
				Tags:   []string{"x"},
			}).Run()
			if err == nil {
				t.Errorf("syndicate set %q: expected error, got nil", name)
			}
		})
	}

	// A valid name must succeed and persist.
	t.Run("accept_valid", func(t *testing.T) {
		_, c, _ := setupTestDB(t)
		c.Feeds = map[int]*Feed{
			1: {id: 1, URL: "http://a", Tag: "x"},
		}
		if err := (&SyndicateSetCmd{
			Name:   "valid-feed_1.0",
			Format: "rss",
			Tags:   []string{"x"},
		}).Run(); err != nil {
			t.Fatalf("syndicate set valid name: %v", err)
		}
	})
}

func TestOutContentType(t *testing.T) {
	cases := map[string]string{
		"rss":  "application/rss+xml",
		"json": "application/feed+json",
		"":     "application/rss+xml", // default branch mirrors outFileKey
	}
	for format, want := range cases {
		if got := outContentType(OutFeed{Format: format}); got != want {
			t.Errorf("outContentType(%q) = %q, want %q", format, got, want)
		}
	}
}

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

// The cap reads one byte past it (io.LimitReader(src, max+1)) and compares with
// >, so exactly-at-cap must pass and one byte over must not — the boundary the
// far-over test above cannot distinguish.
func TestSyndicatePushCapBoundary(t *testing.T) {
	old := maxOutPayload
	defer func() { maxOutPayload = old }()

	t.Run("exactly at cap", func(t *testing.T) {
		maxOutPayload = int64(len(testRSSDoc))
		db, _ := seedExternalOut(t, "rss")
		if err := (&SyndicatePushCmd{Name: "x", in: strings.NewReader(testRSSDoc)}).Run(); err != nil {
			t.Fatalf("push at exactly the cap was rejected: %v", err)
		}
		if n, _ := db.Stat(ctx, "out/x.rss"); n != int64(len(testRSSDoc)) {
			t.Errorf("stored size = %d, want the whole %d-byte payload", n, len(testRSSDoc))
		}
	})

	t.Run("one byte over cap", func(t *testing.T) {
		maxOutPayload = int64(len(testRSSDoc)) - 1
		db, _ := seedExternalOut(t, "rss")
		err := (&SyndicatePushCmd{Name: "x", in: strings.NewReader(testRSSDoc)}).Run()
		if err == nil || !strings.Contains(err.Error(), "exceeds") {
			t.Fatalf("err = %v, want over-cap rejection one byte past the cap", err)
		}
		if n, _ := db.Stat(ctx, "out/x.rss"); n != 0 {
			t.Errorf("out/x.rss written (size %d) despite the over-cap payload", n)
		}
	})
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
