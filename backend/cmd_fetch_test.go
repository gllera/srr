package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
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
	// The connection pool is sized to the worker count so a burst of feed fetches
	// can reuse connections instead of exhausting file descriptors.
	if tr.MaxIdleConnsPerHost != 4 {
		t.Errorf("MaxIdleConnsPerHost = %d, want 4 (== workers)", tr.MaxIdleConnsPerHost)
	}
	if tr.MaxConnsPerHost != 4 {
		t.Errorf("MaxConnsPerHost = %d, want 4 (== workers)", tr.MaxConnsPerHost)
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

// TestRunCycleSafeRecoversPanic guards the whole-cycle net: a panic anywhere in
// a fetch cycle OUTSIDE the per-feed fan-out (PutArticles/Commit/sync steps)
// must become an error so the long-running `srr serve` loop / SSE goroutine
// survives, while a normal error passes through unchanged.
func TestRunCycleSafeRecoversPanic(t *testing.T) {
	if err := runCycleSafe(func() error { panic("boom") }); err == nil {
		t.Fatal("panic was not converted to an error")
	}
	sentinel := fmt.Errorf("plain cycle error")
	if got := runCycleSafe(func() error { return sentinel }); got != sentinel {
		t.Fatalf("runCycleSafe passthrough = %v, want %v", got, sentinel)
	}
}

// TestRunFeedFetchRecoversPanic guards that a panic while processing one feed's
// (third-party, attacker-influenced) content is recovered and recorded as that
// feed's error, rather than propagating out of the fan-out goroutine and
// crashing the whole process — the `srr serve` loop/SSE goroutines run outside
// net/http's per-request recover, so an unrecovered panic there takes the admin
// GUI and the fetch loop down together.
func TestRunFeedFetchRecoversPanic(t *testing.T) {
	ch := &Feed{id: 1, Title: "P", URL: "http://p.example/feed"}
	runFeedFetch(ch, func() { panic("boom") }) // must not propagate
	if ch.FetchError == "" {
		t.Fatal("panic was not recorded as a feed error")
	}
	if ch.FailStreak != 1 {
		t.Fatalf("FailStreak = %d, want 1", ch.FailStreak)
	}
}

// TestSelectFeedsOnlyPathDedupsRepeatedIDs guards against a crafted
// /api/fetch?id=5&id=5: without dedup, selectFeeds returns the SAME *Feed
// pointer twice, so the fan-out races two goroutines on it and the aggregation
// writes that feed's new articles into the immutable packs twice.
func TestSelectFeedsOnlyPathDedupsRepeatedIDs(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := db.AddFeed(&Feed{Title: "A", URL: "http://a.example/feed"}); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}

	got, err := (&FetchCmd{only: []int{0, 0}}).selectFeeds(db)
	if err != nil {
		t.Fatalf("selectFeeds(only=[0,0]): %v", err)
	}
	if len(got) != 1 || got[0].id != 0 {
		t.Fatalf("selectFeeds(only=[0,0]) = %v, want a single feed id 0 (deduped)", selectedIDs(got))
	}
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

// backoffTestGlobals swaps in a Globals with the given backoff cap, restoring
// the previous value on cleanup (setupTestDB-style tests leave the field zero,
// so the fetch-path suites all run at full rate — the production default rides
// the kong tag, not the struct zero).
func backoffTestGlobals(t *testing.T, maxT time.Duration) {
	t.Helper()
	saved := globals
	g := Globals{FetchBackoffMax: maxT}
	globals = &g
	t.Cleanup(func() { globals = saved })
}

func TestTargetInterval(t *testing.T) {
	const base, maxT = 300, 3600
	now := int64(1700000000)
	for _, tc := range []struct {
		name    string
		lastNew int64
		want    int64
	}{
		{"never produced stays at base", 0, base},
		{"produced in the future clamps to base", now + 10, base},
		{"just produced", now, base},
		{"quiet under 8x base stays at base", now - 2000, base}, // 2000/8 = 250 < 300
		{"quiet 40min starts drifting", now - 2400, base},       // exactly 8*base
		{"quiet 2h drifts to quiet/8", now - 7200, 900},
		{"quiet 8h caps", now - 8*3600, maxT},
		{"quiet 9 days caps", now - 9*86400, maxT},
	} {
		ch := &Feed{LastNew: tc.lastNew}
		if got := targetInterval(ch, now, base, maxT); got != tc.want {
			t.Errorf("%s: targetInterval = %d, want %d", tc.name, got, tc.want)
		}
	}
}

func TestFilterDue(t *testing.T) {
	const base, maxT = 300, 3600
	now := int64(1700000000)
	feeds := []*Feed{
		// Active feed polled last cycle: due again (base elapsed).
		{id: 0, LastNew: now - 60, LastOK: now - base},
		// Dormant feed (quiet 2h → target 900) polled 5 min ago: skipped.
		{id: 1, LastNew: now - 7200, LastOK: now - base},
		// Same dormancy but 20 min since last poll: due.
		{id: 2, LastNew: now - 7200, LastOK: now - 1200},
		// Long-dormant but still healthy (streak 0), a day since the last poll:
		// past even the capped dormancy interval, so due.
		{id: 3, LastNew: now - 9*86400, LastOK: now - 86400},
		// Never-polled feed (LastOK 0): due.
		{id: 4},
	}
	got := selectedIDs(filterDue(feeds, nil, now, base, maxT))
	want := []int{0, 2, 3, 4}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("filterDue = %v, want %v", got, want)
	}
}

func TestBackoffActive(t *testing.T) {
	backoffTestGlobals(t, time.Hour)
	for _, tc := range []struct {
		name string
		cmd  FetchCmd
		maxT time.Duration
		want bool
	}{
		{"loop mode", FetchCmd{Interval: 5 * time.Minute}, time.Hour, true},
		{"one-shot run", FetchCmd{}, time.Hour, false},
		{"kill switch", FetchCmd{Interval: 5 * time.Minute}, 0, false},
		{"explicit tag selector", FetchCmd{Interval: 5 * time.Minute, feedFilter: feedFilter{Tag: []string{"news"}}}, time.Hour, false},
		{"explicit feed selector", FetchCmd{Interval: 5 * time.Minute, feedFilter: feedFilter{Feed: []int{3}}}, time.Hour, false},
		{"exclude selectors alone keep backoff", FetchCmd{Interval: 5 * time.Minute, feedFilter: feedFilter{ExcludeTag: []string{"x"}}}, time.Hour, true},
	} {
		globals.FetchBackoffMax = tc.maxT
		if got := tc.cmd.backoffActive(); got != tc.want {
			t.Errorf("%s: backoffActive = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// A failing feed backs off exponentially from the loop base, capped at maxT.
// The streak is clamped before the shift so a long outage can't overflow it.
func TestRetryInterval(t *testing.T) {
	const base, maxT = 300, 3600
	for _, tc := range []struct {
		name   string
		streak int
		want   int64
	}{
		{"first failure doubles", 1, 600},
		{"second failure", 2, 1200},
		{"third failure", 3, 2400},
		{"fourth failure hits the cap", 4, maxT},
		{"long outage stays at the cap", 50, maxT},
	} {
		if got := retryInterval(tc.streak, base, maxT); got != tc.want {
			t.Errorf("%s: retryInterval(%d) = %d, want %d", tc.name, tc.streak, got, tc.want)
		}
	}

	// A cap below the base must not make a failing feed poll MORE often than a
	// healthy one.
	if got := retryInterval(3, 300, 60); got != 300 {
		t.Errorf("retryInterval with maxT < base = %d, want the base 300", got)
	}
}

// The failure path counts from this process's own attempt clock (LastOK is
// frozen while a feed fails), so a dead feed is retried on the exponential
// cadence instead of every single cycle.
func TestFilterDueFailureBackoff(t *testing.T) {
	const base, maxT = 300, 3600
	now := int64(1700000000)

	// Streak 2 → retry every 1200s.
	failing := func(id int, sinceAttempt int64) ([]*Feed, map[int]int64) {
		return []*Feed{{id: id, FailStreak: 2, LastOK: now - 86400}},
			map[int]int64{id: now - sinceAttempt}
	}

	feeds, last := failing(7, 600)
	if got := selectedIDs(filterDue(feeds, last, now, base, maxT)); len(got) != 0 {
		t.Errorf("feeds = %v, want the failing feed skipped 600s into a 1200s backoff", got)
	}

	feeds, last = failing(7, 1200)
	if got := selectedIDs(filterDue(feeds, last, now, base, maxT)); fmt.Sprint(got) != "[7]" {
		t.Errorf("feeds = %v, want [7] once the backoff elapsed", got)
	}

	// No recorded attempt (fresh process) → one full poll, then backoff.
	feeds, _ = failing(7, 0)
	if got := selectedIDs(filterDue(feeds, nil, now, base, maxT)); fmt.Sprint(got) != "[7]" {
		t.Errorf("feeds = %v, want [7]: a restart polls everything once", got)
	}

	// A success resets the streak, so the feed leaves the failure path entirely
	// and is governed by dormancy again — here: polled base ago, due.
	healthy := []*Feed{{id: 7, LastNew: now - 60, LastOK: now - base}}
	if got := selectedIDs(filterDue(healthy, map[int]int64{7: now}, now, base, maxT)); fmt.Sprint(got) != "[7]" {
		t.Errorf("feeds = %v, want [7]: streak 0 ignores lastAttempt", got)
	}
}

// The feed fan-out must not open more than perHostConns connections to one
// host, however wide --workers is: feed sets cluster hard on a few hosts, and a
// synchronized burst from one IP is what datacenter WAFs score as a bot.
func TestHostGateCapsPerHostConcurrency(t *testing.T) {
	var mu sync.Mutex
	inFlight := map[string]int{}
	peak := map[string]int{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.URL.Query().Get("h")
		mu.Lock()
		inFlight[host]++
		if inFlight[host] > peak[host] {
			peak[host] = inFlight[host]
		}
		mu.Unlock()

		time.Sleep(20 * time.Millisecond) // hold the slot so overlap is observable

		mu.Lock()
		inFlight[host]--
		mu.Unlock()
	}))
	defer srv.Close()

	// 8 feeds sharing one hostname, plus 4 on distinct hostnames. The gate keys
	// on the URL's hostname, so distinct hostnames must not gate each other —
	// they all point at the same test server, and the `h` query param is what
	// the handler counts by.
	type feed struct{ host, url string }
	var feeds []feed
	for i := 0; i < 8; i++ {
		feeds = append(feeds, feed{"shared", srv.URL + "?h=shared"})
	}
	for i := 0; i < 4; i++ {
		h := fmt.Sprintf("solo%d", i)
		feeds = append(feeds, feed{h, srv.URL + "?h=" + h})
	}

	// The gate keys on url.Hostname(), and every URL above shares the httptest
	// host — so rewrite each feed's gate key to its logical host by gating on a
	// synthetic URL, which is exactly what the fan-out does with ch.URL.
	gate := &hostGate{}
	var wg sync.WaitGroup
	for _, f := range feeds {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release := gate.acquire("https://" + f.host + "/feed.xml")
			defer release()
			res, err := srv.Client().Get(f.url)
			if err != nil {
				t.Error(err)
				return
			}
			res.Body.Close()
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if peak["shared"] > perHostConns {
		t.Errorf("peak concurrency on the shared host = %d, want <= %d", peak["shared"], perHostConns)
	}
	if peak["shared"] < 2 {
		t.Errorf("peak concurrency on the shared host = %d; the gate serialized more than it should", peak["shared"])
	}
	for i := 0; i < 4; i++ {
		h := fmt.Sprintf("solo%d", i)
		if peak[h] != 1 {
			t.Errorf("peak on %s = %d, want 1 (one feed, one request)", h, peak[h])
		}
	}
}

// A feed URL the gate cannot key on must not block the fan-out: it falls
// through ungated and the fetch fails on its own terms.
func TestHostGateIgnoresUnparseableURL(t *testing.T) {
	gate := &hostGate{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < perHostConns+3; i++ {
			gate.acquire("not a url")() // acquire and immediately release
			gate.acquire("")()
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("hostGate blocked on a URL with no host")
	}
}
