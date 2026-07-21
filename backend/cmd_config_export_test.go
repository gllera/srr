package main

import (
	"bytes"
	"strings"
	"testing"
)

// captureCmdStdout redirects the `stdout` command seam (not os.Stdout, which
// utils_test.go's captureStdout covers) for one test.
func captureCmdStdout(t *testing.T) *bytes.Buffer {
	t.Helper()
	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })
	return &out
}

// The whole point of these verbs: OPML drops everything but title+url, so a
// restore from it silently fetches the wrong content. Configure a store with
// every writable field set, export it, import into a FRESH store, and require
// the configuration to come back identical.
func TestConfigExportImportRoundTrip(t *testing.T) {
	setupEmptyDB(t)
	mustRun := func(c interface{ Run() error }) {
		t.Helper()
		if err := c.Run(); err != nil {
			t.Fatalf("Run: %v", err)
		}
	}
	mustRun(&RecipeSetCmd{Name: "read", Pipe: []string{"#readability", "#default"}})
	mustRun(&DedupCmd{Days: intPtr(45)})
	mustRun(&AddCmd{
		Title: strPtr("Alpha"), URL: strPtr("https://a.example.com/feed"),
		Tag: strPtr("news"), Recipe: strPtr("read"),
		Ingest: strPtr("#feed"), Pipe: []string{"#minify"},
		Expire: intPtr(30), DedupDays: intPtr(7), DedupTitle: boolPtr(true),
	})
	mustRun(&AddCmd{Title: strPtr("Beta"), URL: strPtr("https://b.example.com/feed")})
	mustRun(&SyndicateSetCmd{Name: "news", Format: "rss", Tags: []string{"news"}, Limit: 20})

	out := captureCmdStdout(t)
	mustRun(&ExportAllCmd{})
	doc := out.String()
	for _, want := range []string{
		`"dedup_days": 45`, `"recipe": "read"`, `"#readability"`, `"expire_days": 30`,
		`"dedup_title": true`, `"tag": "news"`, `"format": "rss"`,
	} {
		if !strings.Contains(doc, want) {
			t.Fatalf("export missing %s:\n%s", want, doc)
		}
	}
	// Fetch state is bookkeeping, not config — it must NOT ride along.
	for _, never := range []string{`"wm"`, `"etag"`, `"add_idx"`, `"expired"`, `"content_bytes"`} {
		if strings.Contains(doc, never) {
			t.Errorf("export leaked fetch state %s", never)
		}
	}

	// Restore into a fresh store and compare the configuration.
	setupEmptyDB(t)
	if err := (&ImportAllCmd{in: strings.NewReader(doc)}).Run(); err != nil {
		t.Fatalf("ImportAllCmd: %v", err)
	}
	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)

	if db.core.DedupDays != 45 {
		t.Errorf("store dedup default = %d, want 45", db.core.DedupDays)
	}
	if r := db.core.Recipes["read"]; len(r.Pipe) != 2 || r.Pipe[0] != "#readability" {
		t.Errorf("recipe read = %+v, want the exported pipe", r)
	}
	if len(db.core.Out) != 1 || db.core.Out[0].Name != "news" || db.core.Out[0].Limit != 20 {
		t.Errorf("syndication = %+v, want the exported slot", db.core.Out)
	}
	var alpha *Feed
	for _, ch := range db.Feeds() {
		if ch.URL == "https://a.example.com/feed" {
			alpha = ch
		}
	}
	if alpha == nil {
		t.Fatal("Alpha not restored")
	}
	if alpha.Title != "Alpha" || alpha.Tag != "news" || alpha.Recipe != "read" ||
		alpha.Ingest != "#feed" || len(alpha.Pipe) != 1 || alpha.Pipe[0] != "#minify" ||
		alpha.ExpireDays != 30 || alpha.DedupDays != 7 || !alpha.DedupTitle {
		t.Errorf("Alpha restored lossily: %+v", alpha)
	}

	// Idempotent: importing the same document again updates in place (matched
	// by url) instead of duplicating the feeds.
	before := len(db.Feeds())
	if err := (&ImportAllCmd{in: strings.NewReader(doc)}).Run(); err != nil {
		t.Fatalf("second import: %v", err)
	}
	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close(ctx)
	if len(db2.Feeds()) != before {
		t.Errorf("re-import changed feed count %d → %d, want idempotent", before, len(db2.Feeds()))
	}
}

// A document that fails validation must leave the store completely untouched —
// the whole import is staged behind the validation pass.
func TestConfigImportRejectsInvalidDocumentAtomically(t *testing.T) {
	setupEmptyDB(t)
	if err := (&AddCmd{Title: strPtr("Keep"), URL: strPtr("https://keep.example.com/feed")}).Run(); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, doc, want string }{
		{"unknown recipe", `{"version":1,"feeds":[{"title":"X","url":"https://x.example.com/f","recipe":"nope"}]}`, "recipe"},
		{"bad url", `{"version":1,"feeds":[{"title":"X","url":"not-a-url"}]}`, "invalid url"},
		{"duplicate url", `{"version":1,"feeds":[{"title":"X","url":"https://x.example.com/f"},{"title":"Y","url":"https://x.example.com/f"}]}`, "duplicate"},
		{"negative store dedup", `{"version":1,"dedup_days":-1,"feeds":[]}`, "dedup_days"},
		{"future version", `{"version":99,"feeds":[]}`, "newer than this srr"},
		{"bad syndicate format", `{"version":1,"feeds":[],"out":[{"name":"n","format":"xml","tags":["t"]}]}`, "format"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := (&ImportAllCmd{in: strings.NewReader(c.doc)}).Run()
			if err == nil {
				t.Fatal("import accepted an invalid document")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("error = %v, want it to mention %q", err, c.want)
			}
			db, derr := NewDB(ctx, false)
			if derr != nil {
				t.Fatal(derr)
			}
			defer db.Close(ctx)
			if len(db.Feeds()) != 1 {
				t.Errorf("store mutated by a rejected import: %d feeds, want 1", len(db.Feeds()))
			}
		})
	}
}
