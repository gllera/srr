package mod

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"
)

// makeFilterItem returns a RawItem suitable for filter tests.
func makeFilterItem(title, content string) *RawItem {
	now := time.Now()
	return &RawItem{
		GUID:      1,
		Title:     title,
		Content:   content,
		Link:      "http://example.com",
		Published: &now,
	}
}

// runFilter runs the given #filter token against item and returns any error.
// It uses a fresh Module so registrations from init() are present.
func runFilter(t *testing.T, token string, item *RawItem) error {
	t.Helper()
	m := New()
	return m.Process(context.Background(), token, item)
}

// TestFilterDropTitle verifies case-insensitive drop_title=/regex/i matching.
func TestFilterDropTitle(t *testing.T) {
	// "Sponsored: Foo" should be dropped when title matches /sponsored/i.
	item := makeFilterItem("Sponsored: A Great Product", "buy now")
	if err := runFilter(t, "#filter drop_title=/sponsored/i", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item.Drop {
		t.Error("expected Drop=true for title matching drop_title=/sponsored/i")
	}

	// A non-matching title must NOT be dropped.
	item2 := makeFilterItem("Normal news article", "content here")
	if err := runFilter(t, "#filter drop_title=/sponsored/i", item2); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item2.Drop {
		t.Error("expected Drop=false for title not matching drop_title=/sponsored/i")
	}
}

// TestFilterDropTitleWhitespaceMetachar verifies that a multi-word title is
// matched via a whitespace metacharacter (\s), since a pipeline token is split
// on whitespace before its params are parsed and a literal space cannot appear
// in a regex param value.
func TestFilterDropTitleWhitespaceMetachar(t *testing.T) {
	// Multi-word title with runs of whitespace → dropped via \s+.
	item := makeFilterItem("breaking   news", "content")
	if err := runFilter(t, `#filter drop_title=/breaking\s+news/`, item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item.Drop {
		t.Error(`expected Drop=true for "breaking   news" with drop_title=/breaking\s+news/`)
	}

	// No whitespace between the words → not dropped (\s+ requires ≥1 space).
	item2 := makeFilterItem("breakingnews", "content")
	if err := runFilter(t, `#filter drop_title=/breaking\s+news/`, item2); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item2.Drop {
		t.Error(`expected Drop=false for "breakingnews" with drop_title=/breaking\s+news/`)
	}
}

// TestFilterDropContent verifies drop_content matching.
func TestFilterDropContent(t *testing.T) {
	item := makeFilterItem("Hello", "buy now sponsored content yes")
	if err := runFilter(t, "#filter drop_content=/sponsored/i", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item.Drop {
		t.Error("expected Drop=true for content matching drop_content")
	}

	item2 := makeFilterItem("Hello", "regular article text")
	if err := runFilter(t, "#filter drop_content=/sponsored/i", item2); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item2.Drop {
		t.Error("expected Drop=false for content not matching drop_content")
	}
}

// TestFilterKeepTitle drops items whose title does NOT match keep_title.
func TestFilterKeepTitle(t *testing.T) {
	// Title with "news" → keep (not dropped).
	item := makeFilterItem("Breaking news today", "content")
	if err := runFilter(t, "#filter keep_title=/news/", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Drop {
		t.Error("expected Drop=false when title matches keep_title")
	}

	// Title without "news" → drop.
	item2 := makeFilterItem("Sports highlights", "content")
	if err := runFilter(t, "#filter keep_title=/news/", item2); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item2.Drop {
		t.Error("expected Drop=true when title does not match keep_title")
	}
}

// TestFilterKeepContent drops items whose content does NOT match keep_content.
func TestFilterKeepContent(t *testing.T) {
	item := makeFilterItem("T", "this contains golang code")
	if err := runFilter(t, "#filter keep_content=/golang/", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Drop {
		t.Error("expected Drop=false when content matches keep_content")
	}

	item2 := makeFilterItem("T", "this is about python")
	if err := runFilter(t, "#filter keep_content=/golang/", item2); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item2.Drop {
		t.Error("expected Drop=true when content does not match keep_content")
	}
}

// TestFilterMinWords drops items whose plain-text word count is below the threshold.
func TestFilterMinWords(t *testing.T) {
	// 10-word item dropped by min_words=40.
	shortContent := "one two three four five six seven eight nine ten"
	item := makeFilterItem("T", shortContent)
	if err := runFilter(t, "#filter min_words=40", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item.Drop {
		t.Error("expected Drop=true for 10-word item with min_words=40")
	}

	// Enough words → keep.
	long := strings.Repeat("word ", 50)
	item2 := makeFilterItem("T", long)
	if err := runFilter(t, "#filter min_words=40", item2); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item2.Drop {
		t.Error("expected Drop=false for 50-word item with min_words=40")
	}
}

// TestFilterAnyConditionDrops: an item matching ANY active condition is dropped.
func TestFilterAnyConditionDrops(t *testing.T) {
	// Title matches drop_title → dropped even though min_words is satisfied.
	long := strings.Repeat("word ", 50)
	item := makeFilterItem("Sponsored article", long)
	if err := runFilter(t, "#filter drop_title=/sponsored/i min_words=10", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item.Drop {
		t.Error("expected Drop=true when drop_title matches (even though min_words is satisfied)")
	}
}

// TestFilterDoesNotMutateImmutableFields ensures #filter never changes GUID/Published.
func TestFilterDoesNotMutateImmutableFields(t *testing.T) {
	item := makeFilterItem("Sponsored: X", "content")
	origGUID := item.GUID
	origPub := *item.Published
	if err := runFilter(t, "#filter drop_title=/sponsored/i", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.GUID != origGUID {
		t.Errorf("GUID changed from %d to %d", origGUID, item.GUID)
	}
	if !item.Published.Equal(origPub) {
		t.Errorf("Published changed from %v to %v", origPub, *item.Published)
	}
}

// TestFilterBadRegexIsHardError: a malformed regex is rejected with an error.
func TestFilterBadRegexIsHardError(t *testing.T) {
	item := makeFilterItem("T", "c")
	if err := runFilter(t, `#filter drop_title=/[unclosed/`, item); err == nil {
		t.Error("expected hard error for malformed regex, got nil")
	}
}

// TestParseRegexParamMalformed pins the four config-error shapes parseRegexParam
// rejects: no leading '/', a missing closing '/', an empty pattern, and an
// unsupported flag. Each is a hard configuration error (loud, not silently
// ignored).
func TestParseRegexParamMalformed(t *testing.T) {
	for _, val := range []string{
		"foo",  // no leading '/'
		"/foo", // missing closing '/'
		"//",   // empty pattern (matches everything)
		"/x/g", // unsupported flag 'g' (only 'i' is allowed)
	} {
		if _, err := parseRegexParam("drop_title", val); err == nil {
			t.Errorf("parseRegexParam(drop_title=%q): expected a hard error", val)
		}
	}
}

// TestFilterUnknownParamIsHardError: an unknown param key is rejected.
func TestFilterUnknownParamIsHardError(t *testing.T) {
	item := makeFilterItem("T", "c")
	if err := runFilter(t, "#filter foobar=something", item); err == nil {
		t.Error("expected hard error for unknown param, got nil")
	}
}

// TestFilterMinWordsNonIntegerIsHardError: min_words=<non-integer> is a hard error.
// Exercises the strconv.Atoi error path in filter.go.
func TestFilterMinWordsNonIntegerIsHardError(t *testing.T) {
	item := makeFilterItem("T", "c")
	if err := runFilter(t, "#filter min_words=abc", item); err == nil {
		t.Error("expected hard error for min_words=abc (non-integer), got nil")
	}
}

// TestFilterNoParamsIsNoop: #filter with no params is a no-op (nothing to drop on).
func TestFilterNoParamsIsNoop(t *testing.T) {
	item := makeFilterItem("T", "c")
	if err := runFilter(t, "#filter", item); err != nil {
		t.Fatalf("expected no error with no params, got: %v", err)
	}
	if item.Drop {
		t.Error("expected Drop=false with no params (nothing to filter on)")
	}
}

// TestFilterIsBuiltin checks that #filter is registered and visible via Builtins().
func TestFilterIsBuiltin(t *testing.T) {
	if !slices.Contains(Builtins(), "#filter") {
		t.Errorf("Builtins() does not contain \"#filter\": %v", Builtins())
	}
}

// TestFilterValidateRejectsUnknownParam checks Validate surfaces param errors.
func TestFilterValidateRejectsUnknownParam(t *testing.T) {
	m := New()
	if err := m.Validate(context.Background(), []string{"#filter unknown=x"}); err == nil {
		t.Error("Validate should reject #filter with unknown param")
	}
}

// TestFilterValidateAcceptsKnownParams checks that all valid param keys pass Validate.
func TestFilterValidateAcceptsKnownParams(t *testing.T) {
	m := New()
	valid := []string{
		"#filter drop_title=/x/",
		"#filter keep_title=/x/",
		"#filter drop_content=/x/",
		"#filter keep_content=/x/",
		"#filter min_words=10",
		"#filter drop_title=/x/ min_words=5",
		"#filter keep_lang=en,es",
		"#filter keep_lang=en,es min_words=5",
	}
	for _, tok := range valid {
		if err := m.Validate(context.Background(), []string{tok}); err != nil {
			t.Errorf("Validate rejected valid token %q: %v", tok, err)
		}
	}
}

// TestParseKeepLangs pins the happy path (case-insensitive, whitespace-
// tolerant) and the hard config errors: empty value, empty element, unknown
// code — the malformed-regex contract.
func TestParseKeepLangs(t *testing.T) {
	set, err := parseKeepLangs("EN, es")
	if err != nil {
		t.Fatalf("parseKeepLangs(\"EN, es\"): %v", err)
	}
	if len(set) != 2 || !set["en"] || !set["es"] {
		t.Errorf("parseKeepLangs(\"EN, es\") = %v, want {en, es}", set)
	}
	for _, bad := range []string{"", "xx", "en,,es", "en,xx", "english"} {
		if _, err := parseKeepLangs(bad); err == nil {
			t.Errorf("parseKeepLangs(%q): expected a hard error", bad)
		}
	}
	// Region subtags fold to the bare 639-1 code, so a config copied from an
	// RSS <language> ("en-US") means the same as "en".
	set, err = parseKeepLangs("en-US,pt_BR")
	if err != nil {
		t.Fatalf("parseKeepLangs(\"en-US,pt_BR\"): %v", err)
	}
	if len(set) != 2 || !set["en"] || !set["pt"] {
		t.Errorf("parseKeepLangs(\"en-US,pt_BR\") = %v, want {en, pt}", set)
	}
}

// TestFilterKeepLangNormalizesDeclaredLang: a Lang DECLARED over the external
// wire is folded the same way the allowlist was. An ingest strategy copying an
// RSS <language> verbatim emits "ES" or "es-ES"; comparing those raw against a
// lowercased bare-subtag set dropped every item in the feed — silently, and
// permanently, since the GUID is already in the dedup boundary by then.
func TestFilterKeepLangNormalizesDeclaredLang(t *testing.T) {
	for _, lang := range []string{"es", "ES", "Es", "es-ES", "es_MX", " es "} {
		item := makeFilterItem("Title", "content")
		item.Lang = lang
		if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
			t.Fatalf("Process(Lang=%q): %v", lang, err)
		}
		if item.Drop {
			t.Errorf("Lang=%q dropped, want kept — it is Spanish however it is spelled", lang)
		}
		if item.Lang != lang {
			t.Errorf("Lang = %q, want %q untouched — keep_lang never writes it", item.Lang, lang)
		}
	}
	// Normalization must not turn a genuinely foreign code into a match.
	item := makeFilterItem("Title", "content")
	item.Lang = "DE-de"
	if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item.Drop {
		t.Error("Lang=\"DE-de\" kept, want dropped")
	}
}

// TestFilterKeepLangUnknownCodeIsHardError: the error surfaces through the
// pipeline (not just the parser) and names the ISO contract — distinguishing
// it from the p.only unknown-parameter error, which also mentions the key.
func TestFilterKeepLangUnknownCodeIsHardError(t *testing.T) {
	item := makeFilterItem("T", "c")
	err := runFilter(t, "#filter keep_lang=en,xx", item)
	if err == nil || !strings.Contains(err.Error(), "ISO 639-1") {
		t.Errorf("expected unknown-code hard error mentioning ISO 639-1, got: %v", err)
	}
}

// TestFilterKeepLang: the condition consumes i.Lang — stamped by the pre-pipe
// detection or declared by an earlier step — and does no detection of its own.
// Set → allowlist decides; empty → fail-open keep.
func TestFilterKeepLang(t *testing.T) {
	tests := []struct {
		name string
		lang string
		drop bool
	}{
		{"in-list language kept", "es", false},
		{"other in-list language kept", "en", false},
		{"foreign language dropped", "de", true},
		{"declared no-detection code dropped", "fr", true},
		{"empty Lang fails open", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			item := makeFilterItem("Title", "content")
			item.Lang = tt.lang
			if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
				t.Fatalf("Process: %v", err)
			}
			if item.Drop != tt.drop {
				t.Errorf("Drop = %v, want %v (Lang=%q)", item.Drop, tt.drop, tt.lang)
			}
			if item.Lang != tt.lang {
				t.Errorf("Lang = %q, want %q untouched — keep_lang never writes it", item.Lang, tt.lang)
			}
		})
	}
}

// TestFilterValidateParsesEveryParam is the regression guard for the
// validate-by-execution gap: Validate runs the filter against an EMPTY
// sentinel item, so a condition that fires (keep_title against an empty
// title, min_words against empty content) used to return before later params
// were ever parsed. A typo'd code or malformed regex then passed config
// validation and only surfaced per-item at fetch, where a pipeline error just
// drops the article with a warning — the feed silently ingested nothing.
func TestFilterValidateParsesEveryParam(t *testing.T) {
	m := New()
	for _, tok := range []string{
		"#filter keep_lang=xx",
		"#filter keep_title=/x/ keep_lang=xx",
		"#filter min_words=1 keep_lang=xx",
		"#filter keep_content=/x/ keep_lang=xx",
		"#filter drop_title=/x/ keep_lang=xx",
		"#filter keep_title=/x/ drop_content=/[unclosed/",
		"#filter min_words=1 keep_content=/[unclosed/",
		"#filter keep_title=/x/ min_words=notanumber",
	} {
		if err := m.Validate(context.Background(), []string{tok}); err == nil {
			t.Errorf("Validate(%q) = nil, want a hard config error", tok)
		}
	}
}

// TestFilterKeepLangComposes: keep_lang combines with other conditions in one
// token; any condition firing drops.
func TestFilterKeepLangComposes(t *testing.T) {
	// Passes min_words, fails the language gate → dropped.
	item := makeFilterItem("", "some words beyond the minimum")
	item.Lang = "de"
	if err := runFilter(t, "#filter keep_lang=en,es min_words=3", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item.Drop {
		t.Error("expected Drop=true (language gate) with min_words also present")
	}
	// Passes the language gate, fails min_words → dropped.
	item2 := makeFilterItem("", "too short")
	item2.Lang = "en"
	if err := runFilter(t, "#filter keep_lang=en,es min_words=100", item2); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item2.Drop {
		t.Error("expected Drop=true (min_words) with keep_lang also present")
	}
}
