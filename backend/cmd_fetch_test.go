package main

import (
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"
)

// TestNewFetchClientIdleConnTimeout verifies that the HTTP client/transport
// built for fetch cycles carries a finite IdleConnTimeout.  A zero timeout
// means the transport never closes idle connections on the client side, so
// in --interval mode each cycle would orphan a Transport whose readLoop
// goroutines keep sockets/FDs alive until the remote server closes them.
// 90 s matches the SSRF-guarded transport in mod/helper_ssrf.go.
func TestNewFetchClientIdleConnTimeout(t *testing.T) {
	c := newFetchClient(4)
	tr, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Transport is %T, want *http.Transport", c.Transport)
	}
	if tr.IdleConnTimeout == 0 {
		t.Error("IdleConnTimeout is 0 (no client-side expiry); want a finite value (e.g. 90s)")
	}
	const want = 90 * time.Second
	if tr.IdleConnTimeout != want {
		t.Errorf("IdleConnTimeout = %v, want %v", tr.IdleConnTimeout, want)
	}
}

// TestNewFetchClientPoolingMatchesWorkers verifies that the connection-pool
// limits on the transport are set to the supplied workers value.
func TestNewFetchClientPoolingMatchesWorkers(t *testing.T) {
	const workers = 8
	c := newFetchClient(workers)
	tr := c.Transport.(*http.Transport)
	if tr.MaxIdleConnsPerHost != workers {
		t.Errorf("MaxIdleConnsPerHost = %d, want %d", tr.MaxIdleConnsPerHost, workers)
	}
	if tr.MaxConnsPerHost != workers {
		t.Errorf("MaxConnsPerHost = %d, want %d", tr.MaxConnsPerHost, workers)
	}
}

// filterTestFeeds is the fixture feed set for the include/exclude filter tests:
// a small hierarchical-tag store with an untagged feed and a `news2` decoy that
// must NOT match a `news` prefix selector.
func filterTestFeeds() map[int]*Feed {
	return map[int]*Feed{
		0: {id: 0, Tag: "news"},
		1: {id: 1, Tag: "news/tech"},
		2: {id: 2, Tag: "news2"}, // sibling that shares the "news" prefix but isn't under news/
		3: {id: 3, Tag: "sports"},
		4: {id: 4, Tag: ""}, // untagged
	}
}

func selectedIDs(feeds []*Feed) []int {
	ids := make([]int, len(feeds))
	for i, f := range feeds {
		ids[i] = f.id
	}
	sort.Ints(ids)
	return ids
}

func hasWarn(warnings []string, substr string) bool {
	for _, w := range warnings {
		if strings.Contains(w, substr) {
			return true
		}
	}
	return false
}

func TestMatchTagHierarchicalPrefix(t *testing.T) {
	cases := []struct {
		feedTag, sel string
		want         bool
	}{
		{"news", "news", true},           // exact
		{"news/tech", "news", true},      // child under the subtree
		{"news/world", "news", true},     // another child
		{"news2", "news", false},         // sibling sharing the prefix — the "/" guard rejects it
		{"news", "news/tech", false},     // parent is not matched by a child selector
		{"sports", "news", false},        // unrelated
		{"news/tech", "news/tech", true}, // exact deeper tag
	}
	for _, c := range cases {
		if got := matchTag(c.feedTag, c.sel); got != c.want {
			t.Errorf("matchTag(%q, %q) = %v, want %v", c.feedTag, c.sel, got, c.want)
		}
	}
}

func TestFeedFilterApply(t *testing.T) {
	t.Run("no selectors selects all feeds", func(t *testing.T) {
		sel, warns := feedFilter{}.apply(filterTestFeeds())
		if got := selectedIDs(sel); !reflectDeepEqualInts(got, []int{0, 1, 2, 3, 4}) {
			t.Errorf("selected %v, want all [0 1 2 3 4]", got)
		}
		if len(warns) != 0 {
			t.Errorf("warnings = %v, want none", warns)
		}
	})

	t.Run("include tag matches subtree by prefix", func(t *testing.T) {
		sel, warns := feedFilter{Tag: []string{"news"}}.apply(filterTestFeeds())
		if got := selectedIDs(sel); !reflectDeepEqualInts(got, []int{0, 1}) {
			t.Errorf("selected %v, want [0 1] (news + news/tech, not news2)", got)
		}
		if len(warns) != 0 {
			t.Errorf("warnings = %v, want none", warns)
		}
	})

	t.Run("include by feed id", func(t *testing.T) {
		sel, _ := feedFilter{Feed: []int{3}}.apply(filterTestFeeds())
		if got := selectedIDs(sel); !reflectDeepEqualInts(got, []int{3}) {
			t.Errorf("selected %v, want [3]", got)
		}
	})

	t.Run("include union of tag and feed id", func(t *testing.T) {
		sel, _ := feedFilter{Tag: []string{"news"}, Feed: []int{3}}.apply(filterTestFeeds())
		if got := selectedIDs(sel); !reflectDeepEqualInts(got, []int{0, 1, 3}) {
			t.Errorf("selected %v, want [0 1 3]", got)
		}
	})

	t.Run("exclude tag drops subtree from all", func(t *testing.T) {
		sel, _ := feedFilter{ExcludeTag: []string{"news"}}.apply(filterTestFeeds())
		if got := selectedIDs(sel); !reflectDeepEqualInts(got, []int{2, 3, 4}) {
			t.Errorf("selected %v, want [2 3 4] (news2 survives the prefix guard)", got)
		}
	})

	t.Run("exclude by feed id", func(t *testing.T) {
		sel, _ := feedFilter{ExcludeFeed: []int{3}}.apply(filterTestFeeds())
		if got := selectedIDs(sel); !reflectDeepEqualInts(got, []int{0, 1, 2, 4}) {
			t.Errorf("selected %v, want [0 1 2 4]", got)
		}
	})

	t.Run("include then exclude a child", func(t *testing.T) {
		sel, _ := feedFilter{Tag: []string{"news"}, ExcludeTag: []string{"news/tech"}}.apply(filterTestFeeds())
		if got := selectedIDs(sel); !reflectDeepEqualInts(got, []int{0}) {
			t.Errorf("selected %v, want [0] (news kept, news/tech excluded)", got)
		}
	})

	t.Run("no-match include selector warns but does not error", func(t *testing.T) {
		sel, warns := feedFilter{Tag: []string{"typo"}}.apply(filterTestFeeds())
		if len(sel) != 0 {
			t.Errorf("selected %v, want none", selectedIDs(sel))
		}
		if !hasWarn(warns, "typo") {
			t.Errorf("warnings = %v, want a no-match warning mentioning \"typo\"", warns)
		}
	})

	t.Run("no-match exclude feed id warns", func(t *testing.T) {
		_, warns := feedFilter{ExcludeFeed: []int{99}}.apply(filterTestFeeds())
		if !hasWarn(warns, "99") {
			t.Errorf("warnings = %v, want a no-match warning mentioning 99", warns)
		}
	})

	t.Run("empty result warns and returns none", func(t *testing.T) {
		sel, warns := feedFilter{Tag: []string{"news"}, ExcludeTag: []string{"news"}}.apply(filterTestFeeds())
		if len(sel) != 0 {
			t.Errorf("selected %v, want none", selectedIDs(sel))
		}
		if !hasWarn(warns, "no feeds") {
			t.Errorf("warnings = %v, want an empty-result warning", warns)
		}
	})
}

func TestSelectFeedsOnlyPathUnknownIDErrors(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := db.AddFeed(&Feed{Title: "A", URL: "http://a.example/feed"}); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}

	// Known id resolves.
	got, err := (&FetchCmd{only: []int{0}}).selectFeeds(db)
	if err != nil {
		t.Fatalf("selectFeeds(only=[0]): %v", err)
	}
	if len(got) != 1 || got[0].id != 0 {
		t.Fatalf("selectFeeds(only=[0]) = %v, want the single feed id 0", selectedIDs(got))
	}

	// Unknown id is a hard error (GUI single-feed contract), unlike the filter's warn.
	if _, err := (&FetchCmd{only: []int{999}}).selectFeeds(db); err == nil {
		t.Error("selectFeeds(only=[999]) = nil error, want an unknown-id error")
	}
}

func reflectDeepEqualInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
