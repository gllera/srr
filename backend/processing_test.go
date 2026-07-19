package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"srr/ingest"
	"srr/mod"
)

func init() {
	mod.Register("test-mutate-guid", func() mod.Processor {
		return func(_ context.Context, _ mod.Params, i *mod.RawItem) error {
			i.GUID++
			return nil
		}
	})
	mod.Register("test-mutate-published", func() mod.Processor {
		return func(_ context.Context, _ mod.Params, i *mod.RawItem) error {
			t := time.Unix(1, 0)
			i.Published = &t
			return nil
		}
	})
	// sentinel-later: sets a recognisable string so we can assert it was/wasn't run.
	mod.Register("test-sentinel-later", func() mod.Processor {
		return func(_ context.Context, _ mod.Params, i *mod.RawItem) error {
			i.Title = "RAN_SENTINEL"
			return nil
		}
	})
}

// processItem must reject any module that mutates GUID or Published —
// downstream dedup, ordering, and storage assume those two fields are
// stable for the lifetime of the item. The same rule applies whether
// the module is built-in or external.
func TestProcessItemRejectsImmutableFieldChange(t *testing.T) {
	now := time.Unix(1700000000, 0)
	tests := []struct {
		name   string
		module string
		want   string
	}{
		{"internal GUID", "#test-mutate-guid", "changed GUID"},
		{"internal Published", "#test-mutate-published", "changed Published"},
		{"external GUID", `jq -c '.guid = 99999'`, "changed GUID"},
		{"external Published", `jq -c '.published = "2000-01-01T00:00:00Z"'`, "changed Published"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			item := &mod.RawItem{GUID: 42, Title: "t", Content: "c", Link: "http://example.com", Published: &now}
			err := processItem(context.Background(), mod.New(), []string{tt.module}, item)
			wantErr(t, err, tt.want)
		})
	}
}

// A pipeline step that hard-errors (here a shell mod exiting non-zero) must have
// its error wrapped by processItem as `module "<name>" failed`, attributing the
// offending step — distinct from the GUID/Published-immutability errors, which
// fire on a step that returns nil but mutates a frozen field.
func TestProcessItemWrapsModuleError(t *testing.T) {
	item := &mod.RawItem{GUID: 1, Title: "t", Content: "c", Link: "http://example.com"}
	err := processItem(context.Background(), mod.New(), []string{"exit 1"}, item)
	if err == nil {
		t.Fatal("expected an error from a failing module step, got nil")
	}
	if !strings.Contains(err.Error(), `module "exit 1" failed`) {
		t.Errorf("err = %v, want it to contain `module \"exit 1\" failed`", err)
	}
}

const hostileHTML = `<p>safe text</p><script>window.x=1</script><img src=x onerror="window.x=1">`

// Sanitization is NOT implicit: dangerous markup is only neutralized when the
// resolved pipe actually contains #sanitize. processItem normalizes/strips
// control chars but does not sanitize HTML on its own, so a pipe that omits
// #sanitize ships executable markup straight to the reader. This pins the
// trust boundary — the default root pipe ["#sanitize","#minify"] is the guard.
func TestProcessItemSanitizeIsExplicit(t *testing.T) {
	ctx := context.Background()

	// No #sanitize → hostile nodes survive verbatim.
	for _, pipe := range [][]string{nil, {"#minify"}} {
		item := &mod.RawItem{Content: hostileHTML, Link: "http://example.com"}
		if err := processItem(ctx, mod.New(), pipe, item); err != nil {
			t.Fatalf("processItem(pipe=%v): %v", pipe, err)
		}
		if !strings.Contains(item.Content, "<script") || !strings.Contains(item.Content, "onerror") {
			t.Errorf("pipe %v unexpectedly neutralized hostile content: %q", pipe, item.Content)
		}
	}

	// With #sanitize → script element and event handler are gone, safe text stays.
	item := &mod.RawItem{Content: hostileHTML, Link: "http://example.com"}
	if err := processItem(ctx, mod.New(), []string{"#sanitize"}, item); err != nil {
		t.Fatalf("processItem(#sanitize): %v", err)
	}
	if strings.Contains(item.Content, "<script") || strings.Contains(item.Content, "onerror") {
		t.Errorf("#sanitize left dangerous content: %q", item.Content)
	}
	if !strings.Contains(item.Content, "safe text") {
		t.Errorf("#sanitize dropped safe content: %q", item.Content)
	}
}

// TestProcessItemDropShortCircuit verifies that when a pipeline step sets
// i.Drop=true, processItem returns nil immediately, skips all subsequent steps,
// and does NOT run the post-loop Title/Link/Content normalization.
func TestProcessItemDropShortCircuit(t *testing.T) {
	now := time.Now()
	// HTML title with an entity; if normalization ran, it would be decoded.
	item := &mod.RawItem{
		GUID:      42,
		Title:     "&amp;",
		Content:   "  some content  ",
		Link:      "http://example.com",
		Published: &now,
	}
	// Pipeline: #filter drops on title match → sentinel step must NOT run.
	pipe := []string{"#filter drop_title=/amp/", "#test-sentinel-later"}
	err := processItem(context.Background(), mod.New(), pipe, item)
	if err != nil {
		t.Fatalf("processItem returned error on drop: %v", err)
	}
	if !item.Drop {
		t.Error("expected i.Drop=true after #filter drop step")
	}
	// The sentinel step must NOT have run.
	if item.Title == "RAN_SENTINEL" {
		t.Error("sentinel step ran after drop — short-circuit failed")
	}
	// Post-loop normalization must NOT have run: Title should be untouched raw value.
	if item.Title != "&amp;" {
		t.Errorf("Title was normalized (%q) on a dropped item — normalization ran when it shouldn't", item.Title)
	}
	// Content whitespace not collapsed.
	if item.Content != "  some content  " {
		t.Errorf("Content was normalized on a dropped item: %q", item.Content)
	}
}

// TestProcessItemDropByExternalMod checks that an external mod emitting
// {"drop":true} also triggers the short-circuit.
func TestProcessItemDropByExternalMod(t *testing.T) {
	now := time.Now()
	item := &mod.RawItem{
		GUID:      7,
		Title:     "title",
		Content:   "content",
		Link:      "http://example.com",
		Published: &now,
	}
	pipe := []string{`echo '{"drop":true}'`, "#test-sentinel-later"}
	err := processItem(context.Background(), mod.New(), pipe, item)
	if err != nil {
		t.Fatalf("processItem returned error on drop: %v", err)
	}
	if !item.Drop {
		t.Error("expected i.Drop=true after external drop signal")
	}
	if item.Title == "RAN_SENTINEL" {
		t.Error("sentinel step ran after external drop — short-circuit failed")
	}
}

// Every article gets its language detected BEFORE the pipeline runs (so pipe
// steps like #filter keep_lang can read i.Lang): the stamp fills Lang from a
// confident detection, runs on any pipe (including none), never clobbers a
// declared value, and stays empty on the fail-open path. Fixture texts mirror
// mod/helper_lang_test.go's probe-verified confidences (Spanish → spa 1.0,
// short text → below the 24-rune gate).
func TestProcessItemStampsLang(t *testing.T) {
	const spanish = "El rápido zorro marrón salta sobre el perro perezoso mientras el sol de la mañana se eleva lentamente sobre el tranquilo campo español."
	ctx := context.Background()

	// Confident detection, no pipe at all → stamped.
	item := &mod.RawItem{Content: spanish, Link: "http://example.com"}
	if err := processItem(ctx, mod.New(), nil, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if item.Lang != "es" {
		t.Errorf("Lang = %q, want %q (always-on stamp with empty pipe)", item.Lang, "es")
	}

	// A declared value survives — the stamp never clobbers.
	item = &mod.RawItem{Content: spanish, Link: "http://example.com", Lang: "fr"}
	if err := processItem(ctx, mod.New(), []string{"#minify"}, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if item.Lang != "fr" {
		t.Errorf("Lang = %q, want declared %q preserved", item.Lang, "fr")
	}

	// Below the detection gate → Lang stays empty (fail-open).
	item = &mod.RawItem{Title: "Hi", Content: "Too short", Link: "http://example.com"}
	if err := processItem(ctx, mod.New(), nil, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if item.Lang != "" {
		t.Errorf("Lang = %q, want empty below the detection gate", item.Lang)
	}

	// The stamp precedes the pipeline, so even an item a later step drops
	// carries its detection — the order keep_lang depends on.
	item = &mod.RawItem{Title: "drop me", Content: spanish, Link: "http://example.com"}
	if err := processItem(ctx, mod.New(), []string{"#filter drop_title=/drop/"}, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if !item.Drop {
		t.Fatal("expected i.Drop=true")
	}
	if item.Lang != "es" {
		t.Errorf("Lang = %q on a dropped item, want %q (stamp runs before the pipe)", item.Lang, "es")
	}
}

// The post-pipe detection retry fires whenever the text DetectLang judged is
// no longer the text we hold. The guard compares the inputs themselves, never
// their sizes: the detection gate is a rune count of extracted TEXT while bytes
// are mostly markup, so "grew" and "got longer" are different questions.
func TestProcessItemPostPipeDetection(t *testing.T) {
	const spanish = "El rápido zorro marrón salta sobre el perro perezoso mientras el sol de la mañana se eleva lentamente sobre el tranquilo campo español."
	ctx := context.Background()
	grow := fmt.Sprintf("jq -c '.content = %q'", spanish)

	// Too short to detect up front; a step replaces it past the gate → stamped.
	item := &mod.RawItem{Content: "corto", Link: "http://example.com"}
	if err := processItem(ctx, mod.New(), []string{grow}, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if item.Lang != "es" {
		t.Errorf("Lang = %q, want %q — replaced content must be re-detected", item.Lang, "es")
	}

	// The regression: a byte-HEAVY, text-POOR teaser replaced by a byte-light,
	// text-rich body. This is exactly what #readability does to a feed whose
	// teaser is an inline data: image, and a `len(content) > len(pre)` guard
	// skipped it — silently disabling the retry for the case it exists for.
	teaser := `<a href="x"><img src="data:image/png;base64,` + strings.Repeat("A", 3000) + `"></a><p>Leer</p>`
	item = &mod.RawItem{Content: teaser, Link: "http://example.com"}
	if err := processItem(ctx, mod.New(), []string{grow}, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if len(item.Content) >= len(teaser) {
		t.Fatalf("precondition: content should have SHRUNK in bytes (%d -> %d)", len(teaser), len(item.Content))
	}
	if item.Lang != "es" {
		t.Errorf("Lang = %q, want %q — a text-rich body that is byte-smaller must still re-detect", item.Lang, "es")
	}

	// Unchanged inputs skip the retry: DetectLang is pure, so the answer cannot
	// differ. Observable only as the same fail-open empty.
	item = &mod.RawItem{Content: "corto pero no detectable", Link: "http://example.com"}
	if err := processItem(ctx, mod.New(), nil, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if item.Lang != "" {
		t.Errorf("Lang = %q, want empty", item.Lang)
	}
}

// TestProcessItemKeepLangUsesStampedLang is the integration pin for the
// restored #filter keep_lang: it consumes the i.Lang the pre-pipe stamp set —
// no detection of its own — dropping a confidently-foreign article, keeping an
// in-list one, and keeping anything the detector was unsure about (fail-open).
func TestProcessItemKeepLangUsesStampedLang(t *testing.T) {
	const spanish = "El rápido zorro marrón salta sobre el perro perezoso mientras el sol de la mañana se eleva lentamente sobre el tranquilo campo español."
	ctx := context.Background()

	// Auto-detected es ∉ {en} → dropped.
	item := &mod.RawItem{Content: spanish, Link: "http://example.com"}
	if err := processItem(ctx, mod.New(), []string{"#filter keep_lang=en"}, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if !item.Drop {
		t.Error("expected Drop=true: stamped es is outside keep_lang=en")
	}

	// Auto-detected es ∈ {en,es} → kept, stamp intact.
	item = &mod.RawItem{Content: spanish, Link: "http://example.com"}
	if err := processItem(ctx, mod.New(), []string{"#filter keep_lang=en,es"}, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if item.Drop || item.Lang != "es" {
		t.Errorf("Drop=%v Lang=%q, want kept with Lang=\"es\"", item.Drop, item.Lang)
	}

	// Below the detection gate → Lang empty → fail-open keep.
	item = &mod.RawItem{Title: "Hi", Content: "Too short", Link: "http://example.com"}
	if err := processItem(ctx, mod.New(), []string{"#filter keep_lang=en"}, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if item.Drop {
		t.Error("expected Drop=false: empty Lang fails open")
	}

	// A declared value drives the decision — Spanish text declared fr is
	// dropped by keep_lang=es (the declaration is authoritative, not the text).
	item = &mod.RawItem{Content: spanish, Link: "http://example.com", Lang: "fr"}
	if err := processItem(ctx, mod.New(), []string{"#filter keep_lang=es"}, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if !item.Drop || item.Lang != "fr" {
		t.Errorf("Drop=%v Lang=%q, want dropped with declared \"fr\" intact", item.Drop, item.Lang)
	}
}

// A content-mutating mod placed AFTER #sanitize can reintroduce dangerous
// markup, because processItem does not re-sanitize at the end. This documents
// and guards the ordering invariant: #sanitize must be the LAST content-
// mutating mod in any pipe. If a future change adds a final sanitize pass,
// this test will fail and should be updated to assert the markup is stripped.
func TestProcessItemSanitizeOrderingHazard(t *testing.T) {
	item := &mod.RawItem{Content: "<p>safe</p>", Link: "http://example.com"}
	pipe := []string{"#sanitize", `jq -c '.content="<script>evil</script>"'`}
	if err := processItem(context.Background(), mod.New(), pipe, item); err != nil {
		t.Fatalf("processItem: %v", err)
	}
	if !strings.Contains(item.Content, "<script>evil</script>") {
		t.Fatalf("post-#sanitize shell mod output should survive unsanitized (ordering hazard), got %q", item.Content)
	}
}

// parseFeedTitle is a test helper that drives a raw RSS title string through
// the real ParseFeed->processItem path and returns the stored title.
// The rssTitle argument is embedded verbatim between <title>...</title> tags,
// so numeric character references like &#x9b; are decoded by the XML parser
// before processItem ever sees the value — exactly the path a real feed takes.
func parseFeedTitle(t *testing.T, rssTitle string) string {
	t.Helper()
	feed := []byte(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>` +
		`<item><title>` + rssTitle + `</title><link>http://example.com</link></item>` +
		`</channel></rss>`)
	var got string
	_, err := ingest.ParseFeed(feed, func(i *mod.RawItem) error {
		if err := processItem(context.Background(), mod.New(), nil, i); err != nil {
			return err
		}
		got = i.Title
		return nil
	})
	if err != nil {
		t.Fatalf("ParseFeed: %v", err)
	}
	return got
}

// C1 controls (U+0080-U+009F) injected via numeric character references
// (e.g. &#x9b;) survive XML entity decoding and html.UnescapeString but must
// be stripped from Title just as they are from Link and Content. Verified
// codepoints: U+0080 (first), U+009B (CSI, mid-range), U+009F (last).
// Normal titles with spaces and unicode letters must be preserved verbatim.
func TestProcessItemTitleStripsC1Controls(t *testing.T) {
	// C1 controls injected via numeric refs in RSS XML. After XML parsing and
	// html.UnescapeString they are real C1 runes — processItem must strip them.
	c1cases := []struct {
		name     string
		rssTitle string // embedded verbatim in RSS XML; numeric refs are XML-decoded
		want     string
	}{
		{"U+0080 (first C1)", "Hello&#x80;World", "HelloWorld"},
		{"U+009B (CSI)", "Hello&#x9b;World", "HelloWorld"},
		{"U+009F (last C1)", "Hello&#x9f;World", "HelloWorld"},
		{"C1 at start", "&#x9b;Title", "Title"},
		{"C1 at end", "Title&#x9b;", "Title"},
		{"only C1", "&#x80;&#x9b;&#x9f;", ""},
		{"C1 between spaces", "A &#x9b; B C", "A B C"},
	}
	for _, tc := range c1cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseFeedTitle(t, tc.rssTitle)
			for _, r := range got {
				if r >= 0x80 && r <= 0x9f {
					t.Errorf("C1 control U+%04X survived in title %q", r, got)
				}
			}
			if got != tc.want {
				t.Errorf("title = %q, want %q", got, tc.want)
			}
		})
	}

	// Normal titles: spaces, unicode letters, and punctuation must survive intact.
	normalCases := []struct {
		name     string
		rssTitle string
		want     string
	}{
		{"plain ASCII", "Hello World", "Hello World"},
		{"unicode letters", "Héllo Wörld", "Héllo Wörld"},
		{"leading/trailing spaces collapsed", "  Hello  World  ", "Hello World"},
		{"high BMP codepoints", "日本語タイトル", "日本語タイトル"},
	}
	for _, tc := range normalCases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseFeedTitle(t, tc.rssTitle)
			if got != tc.want {
				t.Errorf("title = %q, want %q", got, tc.want)
			}
		})
	}
}
