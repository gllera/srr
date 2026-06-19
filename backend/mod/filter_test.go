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
	}
	for _, tok := range valid {
		if err := m.Validate(context.Background(), []string{tok}); err != nil {
			t.Errorf("Validate rejected valid token %q: %v", tok, err)
		}
	}
}
