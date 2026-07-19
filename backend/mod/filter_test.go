package mod

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/abadojack/whatlanggo"
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

// Language fixtures, probe-verified against whatlanggo v1.0.1:
//
//	langTextEN → eng 0.714 (below the 0.8 gate — kept via the in-set check
//	             on keep_lang=en,es, and via fail-open otherwise)
//	langTextES → spa 1.000
//	langTextDE → deu 1.000 (the Latin-script drop path)
//	langTextRU → rus 1.000 (distinct script)
//	langTextJA → jpn 1.000 (distinct script)
//	langTextPT → por 0.412 (Latin-script sibling — under the gate, kept)
const (
	langTextEN = "The quick brown fox jumps over the lazy dog while the morning sun rises slowly over the quiet English countryside."
	langTextES = "El rápido zorro marrón salta sobre el perro perezoso mientras el sol de la mañana se eleva lentamente sobre el tranquilo campo español."
	langTextDE = "Der schnelle braune Fuchs springt über den faulen Hund, während die Morgensonne langsam über der ruhigen deutschen Landschaft aufgeht."
	langTextRU = "Быстрая коричневая лиса перепрыгивает через ленивую собаку, пока утреннее солнце медленно поднимается над тихой русской деревней."
	langTextJA = "素早い茶色の狐が怠け者の犬を飛び越え、朝日が静かな田園風景の上にゆっくりと昇っていきます。"
	langTextPT = "A rápida raposa marrom salta sobre o cão preguiçoso enquanto o sol da manhã nasce lentamente sobre o campo português tranquilo."
)

// TestParseKeepLangs pins the happy path (case-insensitive, whitespace-
// tolerant) and the hard config errors: empty value, empty element, unknown
// code — the malformed-regex contract.
func TestParseKeepLangs(t *testing.T) {
	set, err := parseKeepLangs("EN, es")
	if err != nil {
		t.Fatalf("parseKeepLangs(\"EN, es\"): %v", err)
	}
	if len(set) != 2 || !set[whatlanggo.CodeToLang("eng")] || !set[whatlanggo.CodeToLang("spa")] {
		t.Errorf("parseKeepLangs(\"EN, es\") = %v, want {eng, spa}", set)
	}
	for _, bad := range []string{"", "xx", "en,,es", "en,xx", "english"} {
		if _, err := parseKeepLangs(bad); err == nil {
			t.Errorf("parseKeepLangs(%q): expected a hard error", bad)
		}
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

// TestFilterKeepLangKeepsAllowed: confidently-classified English and Spanish
// articles pass a keep_lang=en,es gate.
func TestFilterKeepLangKeepsAllowed(t *testing.T) {
	for name, text := range map[string]string{"english": langTextEN, "spanish": langTextES} {
		item := makeFilterItem("", "<p>"+text+"</p>")
		if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
			t.Fatalf("%s: Process: %v", name, err)
		}
		if item.Drop {
			t.Errorf("%s: expected Drop=false for allowed language", name)
		}
	}
}

// TestFilterKeepLangDropsForeign: confident foreign classifications drop —
// German is the Latin-script path, Russian/Japanese the distinct-script path.
func TestFilterKeepLangDropsForeign(t *testing.T) {
	for name, text := range map[string]string{"german": langTextDE, "russian": langTextRU, "japanese": langTextJA} {
		item := makeFilterItem("", "<p>"+text+"</p>")
		if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
			t.Fatalf("%s: Process: %v", name, err)
		}
		if !item.Drop {
			t.Errorf("%s: expected Drop=true for foreign language", name)
		}
	}
}

// TestFilterKeepLangFailOpenShortText: below the 24-rune floor nothing is
// judged — a 22-rune German greeting is kept.
func TestFilterKeepLangFailOpenShortText(t *testing.T) {
	item := makeFilterItem("", "Guten Morgen zusammen!")
	if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Drop {
		t.Error("expected Drop=false for sub-floor text length")
	}
}

// TestFilterKeepLangFailOpenLowConfidence: Portuguese prose scores ~0.41 —
// well under the 0.8 gate — so the Latin-script sibling is kept, the
// documented fail-open leak direction (never a wanted article lost).
func TestFilterKeepLangFailOpenLowConfidence(t *testing.T) {
	item := makeFilterItem("", "<p>"+langTextPT+"</p>")
	if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Drop {
		t.Error("expected Drop=false for a low-confidence detection")
	}
}

// TestFilterKeepLangEmptyItemKept: no title, no content → nothing to judge.
func TestFilterKeepLangEmptyItemKept(t *testing.T) {
	item := makeFilterItem("", "")
	if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Drop {
		t.Error("expected Drop=false for an empty item")
	}
}

// TestFilterKeepLangStripsMarkup: heavy markup around foreign prose does not
// dilute detection (drops), and tag soup around English does not flip it to a
// confident foreign classification (kept).
func TestFilterKeepLangStripsMarkup(t *testing.T) {
	de := makeFilterItem("", `<div class="entry-content post"><p>`+langTextDE+`</p><img src="https://example.com/x.jpg" alt=""></div>`)
	if err := runFilter(t, "#filter keep_lang=en,es", de); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !de.Drop {
		t.Error("expected Drop=true for German prose in heavy markup")
	}
	en := makeFilterItem("", `<div data-x="qqzz"><p style="color:red">`+langTextEN+`</p></div>`)
	if err := runFilter(t, "#filter keep_lang=en,es", en); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if en.Drop {
		t.Error("expected Drop=false for English prose in tag soup")
	}
}

// TestFilterKeepLangComposes: keep_lang combines with other conditions in one
// token; any condition firing drops.
func TestFilterKeepLangComposes(t *testing.T) {
	// Passes min_words, fails the language gate → dropped.
	item := makeFilterItem("", "<p>"+langTextDE+"</p>")
	if err := runFilter(t, "#filter keep_lang=en,es min_words=5", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item.Drop {
		t.Error("expected Drop=true (language gate) with min_words also present")
	}
	// Passes the language gate, fails min_words → dropped.
	item2 := makeFilterItem("", "<p>"+langTextEN+"</p>")
	if err := runFilter(t, "#filter keep_lang=en,es min_words=100", item2); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item2.Drop {
		t.Error("expected Drop=true (min_words) with keep_lang also present")
	}
}

// TestFilterKeepLangStampsLang: a confident detection is recorded on
// RawItem.Lang (ISO 639-1) whether the item is dropped or kept; a
// below-threshold detection stamps nothing; a pre-set Lang (declared by an
// ingest strategy or an earlier mod) is never clobbered.
func TestFilterKeepLangStampsLang(t *testing.T) {
	// Confident foreign → dropped AND stamped.
	de := makeFilterItem("", "<p>"+langTextDE+"</p>")
	if err := runFilter(t, "#filter keep_lang=en,es", de); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !de.Drop || de.Lang != "de" {
		t.Errorf("german: Drop=%v Lang=%q, want Drop=true Lang=\"de\"", de.Drop, de.Lang)
	}

	// Confident allowed → kept AND stamped.
	es := makeFilterItem("", "<p>"+langTextES+"</p>")
	if err := runFilter(t, "#filter keep_lang=en,es", es); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if es.Drop || es.Lang != "es" {
		t.Errorf("spanish: Drop=%v Lang=%q, want Drop=false Lang=\"es\"", es.Drop, es.Lang)
	}

	// Below the confidence gate (langTextEN scores ~0.71) → kept, NOT stamped.
	en := makeFilterItem("", "<p>"+langTextEN+"</p>")
	if err := runFilter(t, "#filter keep_lang=en,es", en); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if en.Drop || en.Lang != "" {
		t.Errorf("english: Drop=%v Lang=%q, want Drop=false Lang=\"\"", en.Drop, en.Lang)
	}

	// A declared Lang survives; the gate still judges by its own detection.
	declared := makeFilterItem("", "<p>"+langTextDE+"</p>")
	declared.Lang = "fr"
	if err := runFilter(t, "#filter keep_lang=en,es", declared); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !declared.Drop || declared.Lang != "fr" {
		t.Errorf("declared: Drop=%v Lang=%q, want Drop=true Lang=\"fr\"", declared.Drop, declared.Lang)
	}
}
